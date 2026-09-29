import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { PersistedState, StateStore, StoredClient } from "../store/state-store.js";
import { randomB64Url, sha256Hex } from "../util/crypto.js";
import { originAllowed } from "../util/http.js";
import { safeEqualStr } from "../util/crypto.js";
import type { AccountService } from "./accounts.js";
import { AccountError } from "./accounts.js";
import { renderConsentPage, renderMessagePage } from "./consent-page.js";
import type { ConsentConnection } from "./consent-page.js";
import type { PatService } from "./pat.js";
import { PAT_PREFIX } from "./pat.js";
import { DEFAULT_SCOPES, isSupportedScope } from "./scopes.js";
import { readSessionId, setSessionCookie } from "./session-cookie.js";

export const ACCESS_TTL_MS = 3600_000;
export const REFRESH_TTL_MS = 30 * 24 * 3600_000;
export const CODE_TTL_MS = 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
/** While the user is in the "add an Apps Script" flow the consent nonce lives this long (DESIGN.md 9.4). */
export const CONSENT_ADD_FLOW_TTL_MS = 30 * 60_000;
const MAX_CLIENTS = 500;
export const CONSENT_PATH = "/oauth/consent";

/** What the consent page needs to know about connections (a subset of ConnectionRegistry). */
export interface ConnectionDirectory {
  listFor(userId: string): ConsentConnection[];
}

export interface OAuthProviderDeps {
  store: StateStore;
  accounts: AccountService;
  connections: ConnectionDirectory;
  pats: PatService;
  /** Current public base URL (env or UI setting), if any. */
  baseUrl: () => string | undefined;
  logger?: Logger;
  now?: () => number;
}

interface PendingConsent {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state: string | undefined;
  expiresAt: number;
}

interface IssuedCode extends PendingConsent {
  challengeServed: boolean;
  userId: string;
  connectionId: string;
}

/** DESIGN.md 3.2: redirect URIs must be https, or http on localhost / 127.0.0.1. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  username: string | null;
  connectionId: string;
  connectionLabel: string | null;
  scopes: string[];
  createdAt: number;
}

export class GsmcpOAuthProvider implements OAuthServerProvider {
  private readonly store: StateStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly consents = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, IssuedCode>();

  constructor(private readonly deps: OAuthProviderDeps) {
    this.store = deps.store;
    this.log = deps.logger ?? nullLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  // ---- clients (DCR) ----------------------------------------------------
  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.store.state.oauth.clients[id] as OAuthClientInformationFull | undefined,
    registerClient: async (client) => {
      const uris = client.redirect_uris.map(String);
      if (uris.length === 0 || uris.length > 10) throw new InvalidClientMetadataError("redirect_uris must contain 1-10 entries");
      for (const u of uris) {
        if (!isAllowedRedirectUri(u)) {
          throw new InvalidClientMetadataError("redirect_uris must be https://... or http://localhost|127.0.0.1[:port]/... without a fragment");
        }
      }
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(this.now() / 1000),
        redirect_uris: uris,
        client_name: client.client_name ? String(client.client_name).slice(0, 100) : undefined,
        // Public clients only; PKCE S256 is enforced by the SDK's authorize handler.
        token_endpoint_auth_method: "none",
        client_secret: undefined,
        client_secret_expires_at: undefined,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      await this.store.update((s) => {
        const ids = Object.keys(s.oauth.clients);
        if (ids.length >= MAX_CLIENTS) {
          const inUse = new Set(Object.values(s.oauth.grants).map((g) => g.clientId));
          const victims = ids
            .filter((id) => !inUse.has(id))
            .sort((a, b) => (s.oauth.clients[a]?.client_id_issued_at ?? 0) - (s.oauth.clients[b]?.client_id_issued_at ?? 0));
          for (const v of victims.slice(0, ids.length - MAX_CLIENTS + 1)) delete s.oauth.clients[v];
        }
        s.oauth.clients[full.client_id] = full as unknown as StoredClient;
      });
      this.log.info("oauth_client_registered");
      return full;
    },
  };

  // ---- authorize + consent page ----------------------------------------
  private resourceOk(resource: URL | undefined): boolean {
    if (!resource) return true;
    const base = this.deps.baseUrl();
    if (!base) return false;
    const r = resource.href.replace(/\/$/, "");
    return r === base || r === `${base}/mcp`;
  }

  private registerConsent(rec: Omit<PendingConsent, "expiresAt">): string {
    const t = this.now();
    if (this.consents.size > 1000) {
      for (const [k, v] of this.consents) if (v.expiresAt <= t) this.consents.delete(k);
      if (this.consents.size > 1000) this.consents.delete(this.consents.keys().next().value as string);
    }
    const nonce = randomB64Url(24);
    this.consents.set(nonce, { ...rec, expiresAt: t + CONSENT_TTL_MS });
    return nonce;
  }

  private consentPageHeaders(res: Response, styleNonce: string): void {
    res.set({
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${styleNonce}'; frame-ancestors 'none'; base-uri 'none'`,
      "Referrer-Policy": "no-referrer",
    });
  }

  private secure(): boolean {
    return (this.deps.baseUrl() ?? "").startsWith("https:");
  }

  /**
   * Renders the consent step for a nonce (DESIGN.md 9.4). Not logged in: the inline login form. Logged in: the picker of
   * the user's own connections, last used one preselected; with none, straight to the add-Apps-Script flow.
   */
  private render(res: Response, rec: PendingConsent, nonce: string, session: { user: { id: string; username: string; lastConnectionId?: string | null }; csrf: string } | undefined, opts: { error?: string; status?: number; username?: string } = {}): void {
    const client = this.store.state.oauth.clients[rec.clientId];
    let host = rec.redirectUri;
    try {
      host = new URL(rec.redirectUri).host;
    } catch {
      /* keep raw */
    }
    const addUrl = `/account?add=1&consent=${encodeURIComponent(nonce)}`;
    let picker: NonNullable<Parameters<typeof renderConsentPage>[0]["picker"]> | undefined;
    if (session) {
      const connections = this.deps.connections.listFor(session.user.id);
      if (connections.length === 0) {
        this.extendConsent(nonce);
        res.redirect(302, addUrl);
        return;
      }
      const last = session.user.lastConnectionId;
      const selectedId = connections.some((c) => c.id === last) ? (last as string) : (connections[0]?.id ?? null);
      picker = { username: session.user.username, csrf: session.csrf, connections, selectedId, addUrl };
    }
    const styleNonce = randomB64Url(16);
    this.consentPageHeaders(res, styleNonce);
    res
      .status(opts.status ?? 200)
      .type("html")
      .send(
        renderConsentPage({
          clientName: client?.client_name ?? "(không tên)",
          redirectHost: host,
          scopes: rec.scopes,
          nonce,
          styleNonce,
          error: opts.error,
          action: CONSENT_PATH,
          ...(picker ? { picker } : { login: { username: opts.username } }),
        }),
      );
  }

  /** Extends a live consent nonce to 30 min (the user is adding an Apps Script and will come back). */
  extendConsent(nonce: string): boolean {
    const rec = this.consents.get(nonce);
    if (!rec || rec.expiresAt <= this.now()) return false;
    rec.expiresAt = Math.max(rec.expiresAt, this.now() + CONSENT_ADD_FLOW_TTL_MS);
    return true;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = params.scopes && params.scopes.length > 0 ? [...new Set(params.scopes)] : [...DEFAULT_SCOPES];
    for (const s of scopes) if (!isSupportedScope(s)) throw new InvalidScopeError(`Unsupported scope: ${s.slice(0, 50)}`);
    if (!this.resourceOk(params.resource)) throw new InvalidTargetError("resource does not match this server");
    const rec = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      state: params.state,
    };
    const nonce = this.registerConsent(rec);
    const req = res.req as Request;
    this.render(res, { ...rec, expiresAt: 0 }, nonce, this.accounts.getSession(readSessionId(req)));
  }

  private get accounts(): AccountService {
    return this.deps.accounts;
  }

  private liveConsent(nonce: unknown): PendingConsent | undefined {
    const rec = typeof nonce === "string" ? this.consents.get(nonce) : undefined;
    if (!rec) return undefined;
    if (rec.expiresAt <= this.now()) {
      this.consents.delete(nonce as string);
      return undefined;
    }
    return rec;
  }

  /** GET /oauth/consent?nonce=...: back from the add-Apps-Script flow (or a reload). The nonce is not consumed. */
  async handleConsentGet(req: Request, res: Response): Promise<void> {
    const nonce = typeof req.query.nonce === "string" ? req.query.nonce : "";
    const rec = this.liveConsent(nonce);
    if (!rec) {
      res.set("Cache-Control", "no-store").status(400).type("html").send(renderMessagePage("Phiên đã hết hạn", "Hãy quay lại ứng dụng và bắt đầu kết nối lại."));
      return;
    }
    this.render(res, rec, nonce, this.accounts.getSession(readSessionId(req)));
  }

  /** POST handler for the consent form (urlencoded body must already be parsed). Actions: login, approve, deny. */
  async handleConsent(req: Request, res: Response): Promise<void> {
    res.set("Cache-Control", "no-store");
    if (!originAllowed(req, this.deps.baseUrl())) {
      res.status(403).type("html").send(renderMessagePage("Yêu cầu bị từ chối", "Origin không hợp lệ."));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const rec = this.liveConsent(nonce);
    if (!rec) {
      res.status(400).type("html").send(renderMessagePage("Phiên đã hết hạn", "Hãy quay lại ứng dụng và bắt đầu kết nối lại."));
      return;
    }

    const redirect = (params: Record<string, string>) => {
      const u = new URL(rec.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (rec.state) u.searchParams.set("state", rec.state);
      res.redirect(302, u.href);
    };

    const action = body.action;
    if (action === "deny") {
      this.consents.delete(nonce);
      redirect({ error: "access_denied", error_description: "The user denied the request" });
      return;
    }

    let session = this.accounts.getSession(readSessionId(req));

    if (action === "login") {
      const username = typeof body.username === "string" ? body.username : "";
      try {
        const user = await this.accounts.login(username, body.password, req.ip ?? "unknown");
        const created = await this.accounts.createSession(user.id);
        setSessionCookie(res, created.id, this.secure());
        session = this.accounts.getSession(created.id);
        this.log.info("consent_login");
        this.render(res, rec, nonce, session);
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        if (e.code === "RATE_LIMITED") res.set("Retry-After", String(e.retryAfterSec ?? 60));
        this.log.warn("consent_login_failed", { resultCode: e.code });
        this.render(res, rec, nonce, undefined, { error: e.message, status: e.code === "RATE_LIMITED" ? 429 : 401, username });
      }
      return;
    }

    if (action !== "approve") {
      this.render(res, rec, nonce, session, { error: "Yêu cầu không hợp lệ.", status: 400 });
      return;
    }
    if (!session) {
      this.render(res, rec, nonce, undefined, { error: "Hãy đăng nhập trước.", status: 401 });
      return;
    }
    const csrf = typeof body.csrf === "string" ? body.csrf : "";
    if (!safeEqualStr(csrf, session.csrf)) {
      this.render(res, rec, nonce, session, { error: "Phiên không hợp lệ, hãy thử lại.", status: 403 });
      return;
    }
    // Re-check on approve that the connection belongs to the session user (DESIGN.md 9.4 step 3).
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    const mine = this.deps.connections.listFor(session.user.id).some((c) => c.id === connectionId);
    if (!mine) {
      this.log.warn("consent_foreign_connection");
      this.render(res, rec, nonce, session, { error: "Kết nối Apps Script không hợp lệ.", status: 403 });
      return;
    }
    this.consents.delete(nonce); // nonce is single use
    const userId = session.user.id;
    await this.store.update((st) => {
      const u = st.users[userId];
      if (u) u.lastConnectionId = connectionId;
    });
    const code = randomB64Url(32);
    this.codes.set(sha256Hex(code), { ...rec, expiresAt: this.now() + CODE_TTL_MS, challengeServed: false, userId, connectionId });
    this.log.info("consent_approved");
    redirect({ code });
  }

  // ---- code / token exchange -------------------------------------------
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const h = sha256Hex(authorizationCode);
    const rec = this.codes.get(h);
    if (!rec || rec.expiresAt <= this.now() || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (rec.challengeServed) {
      // Only one PKCE verification attempt per code.
      this.codes.delete(h);
      throw new InvalidGrantError("Authorization code already used");
    }
    rec.challengeServed = true;
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const h = sha256Hex(authorizationCode);
    const rec = this.codes.get(h);
    this.codes.delete(h); // single use, even if a later check fails
    if (!rec || rec.expiresAt <= this.now() || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (!this.resourceOk(resource)) throw new InvalidTargetError("resource does not match this server");
    const grantId = randomUUID();
    return this.issue(grantId, client.client_id, rec.scopes, true, { userId: rec.userId, connectionId: rec.connectionId });
  }

  private prune(s: PersistedState, t: number): void {
    for (const [h, a] of Object.entries(s.oauth.accessTokens)) if (a.expiresAt <= t) delete s.oauth.accessTokens[h];
    for (const [h, r] of Object.entries(s.oauth.refreshTokens)) if (r.expiresAt <= t) delete s.oauth.refreshTokens[h];
    const live = new Set<string>();
    for (const r of Object.values(s.oauth.refreshTokens)) live.add(r.grantId);
    for (const a of Object.values(s.oauth.accessTokens)) live.add(a.grantId);
    for (const g of Object.keys(s.oauth.grants)) if (!live.has(g)) delete s.oauth.grants[g];
  }

  private async issue(grantId: string, clientId: string, scopes: string[], newGrant: boolean, bound: { userId: string; connectionId: string }): Promise<OAuthTokens> {
    const t = this.now();
    const access = randomB64Url(32);
    const refresh = randomB64Url(32);
    await this.store.update((s) => {
      if (newGrant) s.oauth.grants[grantId] = { id: grantId, clientId, ...bound, scopes, createdAt: t };
      s.oauth.accessTokens[sha256Hex(access)] = { grantId, clientId, ...bound, scopes, expiresAt: t + ACCESS_TTL_MS };
      s.oauth.refreshTokens[sha256Hex(refresh)] = { grantId, clientId, ...bound, expiresAt: t + REFRESH_TTL_MS };
      this.prune(s, t);
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const h = sha256Hex(refreshToken);
    const s = this.store.state;
    const rec = s.oauth.refreshTokens[h];
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const grant = s.oauth.grants[rec.grantId];
    if (!grant) throw new InvalidGrantError("Invalid refresh token");
    if (rec.rotated) {
      await this.revokeGrant(rec.grantId);
      this.log.warn("refresh_token_reuse_detected");
      throw new InvalidGrantError("Refresh token reuse detected; the grant has been revoked");
    }
    if (rec.expiresAt <= this.now()) throw new InvalidGrantError("Refresh token expired");
    if (!this.resourceOk(resource)) throw new InvalidTargetError("resource does not match this server");
    let granted = grant.scopes;
    if (scopes && scopes.length > 0) {
      if (!scopes.every((x) => grant.scopes.includes(x))) throw new InvalidScopeError("Requested scope exceeds the original grant");
      granted = scopes;
    }
    rec.rotated = true; // synchronous with the check above: concurrent reuse is detected
    return this.issue(rec.grantId, client.client_id, granted, false, { userId: grant.userId, connectionId: grant.connectionId });
  }

  // ---- verification / revocation ---------------------------------------
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = this.now();
    if (token.startsWith(PAT_PREFIX)) {
      const pat = this.deps.pats.verify(token);
      if (!pat) throw new InvalidTokenError("Invalid token");
      // requireBearerAuth insists on an expiry; PATs have none, so report a rolling short one.
      return {
        token,
        clientId: `pat:${pat.id}`,
        scopes: pat.scopes,
        expiresAt: Math.floor(t / 1000) + 3600,
        extra: { kind: "pat", patId: pat.id, userId: pat.userId, connectionId: pat.connectionId },
      };
    }
    const rec = this.store.state.oauth.accessTokens[sha256Hex(token)];
    if (!rec || rec.expiresAt <= t || !this.store.state.oauth.grants[rec.grantId]) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      extra: { kind: "oauth", grantId: rec.grantId, userId: rec.userId, connectionId: rec.connectionId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const h = sha256Hex(request.token);
    const s = this.store.state;
    const refresh = s.oauth.refreshTokens[h];
    if (refresh && refresh.clientId === client.client_id) {
      await this.revokeGrant(refresh.grantId);
      return;
    }
    const access = s.oauth.accessTokens[h];
    if (access && access.clientId === client.client_id) {
      await this.store.update((st) => {
        delete st.oauth.accessTokens[h];
      });
    }
  }

  // ---- admin / account views ---------------------------------------------
  /** All grants when `userId` is omitted (owner admin UI), else only that user's. */
  listGrants(userId?: string): GrantView[] {
    const s = this.store.state;
    return Object.values(s.oauth.grants)
      .filter((g) => userId === undefined || g.userId === userId)
      .map((g) => ({
        id: g.id,
        clientId: g.clientId,
        clientName: s.oauth.clients[g.clientId]?.client_name ?? "(không tên)",
        userId: g.userId,
        username: s.users[g.userId]?.username ?? null,
        connectionId: g.connectionId,
        connectionLabel: s.connections[g.connectionId]?.label ?? null,
        scopes: g.scopes,
        createdAt: g.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async revokeGrant(grantId: string, userId?: string): Promise<boolean> {
    let existed = false;
    await this.store.update((s) => {
      const g = s.oauth.grants[grantId];
      if (!g || (userId !== undefined && g.userId !== userId)) return;
      existed = true;
      delete s.oauth.grants[grantId];
      for (const [h, a] of Object.entries(s.oauth.accessTokens)) if (a.grantId === grantId) delete s.oauth.accessTokens[h];
      for (const [h, r] of Object.entries(s.oauth.refreshTokens)) if (r.grantId === grantId) delete s.oauth.refreshTokens[h];
    });
    return existed;
  }
}
