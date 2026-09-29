import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { AccountService } from "../src/auth/accounts.js";
import { AdminAuth } from "../src/auth/admin-auth.js";
import { GsmcpOAuthProvider } from "../src/auth/oauth-provider.js";
import { hashPassword } from "../src/auth/password.js";
import { PatService } from "../src/auth/pat.js";
import { ConnectionRegistry } from "../src/connection/connection-registry.js";
import type { EvalResult, ScriptEvaluator } from "../src/core/script/evaluator.js";
import type * as G from "../src/core/sheets/gateway.js";
import { createAdminApp } from "../src/http/admin-app.js";
import { createPublicApp } from "../src/http/public-app.js";
import { PublicBaseUrl } from "../src/settings/public-base-url.js";
import { StateStore } from "../src/store/state-store.js";
import { UsageService } from "../src/usage/usage-service.js";
import { FailureLimiter } from "../src/util/rate-limit.js";

export class FakeGateway implements G.SheetsGateway {
  calls: Array<{ method: string; arg: unknown }> = [];
  spreadsheets: G.SpreadsheetInfo[] = [
    { id: "id-sales", name: "Sales 2025", alias: "sales", access: "write", url: "https://x/sales" },
    { id: "id-ro", name: "Read Only Book", alias: null, access: "read", url: "https://x/ro" },
  ];
  private rec<T>(method: string, arg: unknown, result: T): Promise<T> {
    this.calls.push({ method, arg });
    return Promise.resolve(result);
  }
  ping() {
    return this.rec("ping", null, { account: "me@example.com", backendVersion: "1", spreadsheetCount: this.spreadsheets.length });
  }
  listSpreadsheets() {
    return this.rec("listSpreadsheets", null, this.spreadsheets);
  }
  getMetadata(id: string) {
    return this.rec("getMetadata", id, { id, name: "n", url: "u", locale: "en", timeZone: "UTC", sheets: [] });
  }
  readRange(r: G.ReadRequest) {
    return this.rec("readRange", r, { range: r.range, values: [["a", 1]] });
  }
  writeRange(r: G.WriteRequest) {
    return this.rec("writeRange", r, { updatedRange: r.range, updatedRows: r.values.length, updatedColumns: r.values[0]!.length, updatedCells: 1 });
  }
  appendRows(r: G.AppendRequest) {
    return this.rec("appendRows", r, { updatedRange: `${r.sheet}!A2`, appendedRows: r.rows.length });
  }
  search(r: G.SearchRequest) {
    return this.rec("search", r, { matches: [], truncated: false });
  }
  batchUpdate(r: G.BatchRequest) {
    return this.rec("batchUpdate", r, { results: [] });
  }
}

/** Records what it is asked to run; `handler` decides the outcome. */
export class FakeEvaluator implements ScriptEvaluator {
  calls: Array<{ code: string; args: unknown }> = [];
  handler: (code: string, args: unknown) => Promise<EvalResult> = async () => ({ value: { ok: true }, logs: ["hello"], durationMs: 3 });
  evaluate(code: string, args?: unknown): Promise<EvalResult> {
    this.calls.push({ code, args });
    return this.handler(code, args);
  }
}

/** A gateway that can also evaluate scripts (like AppsScriptGateway), delegating to a FakeEvaluator. */
export class FakeEvalGateway extends FakeGateway implements ScriptEvaluator {
  constructor(private readonly ev: FakeEvaluator) {
    super();
  }
  evaluate(code: string, args?: unknown): Promise<EvalResult> {
    return this.ev.evaluate(code, args);
  }
}

export interface Harness {
  dir: string;
  store: StateStore;
  usage: UsageService;
  /** Gateway of the owner's default connection. */
  gateway: FakeGateway;
  /** Gateways by connection id (created on demand for connections without one). */
  gateways: Map<string, FakeGateway>;
  evaluator: FakeEvaluator;
  admin: AdminAuth;
  accounts: AccountService;
  pats: PatService;
  provider: GsmcpOAuthProvider;
  baseUrl: PublicBaseUrl;
  registry: ConnectionRegistry;
  ipLimiter: FailureLimiter;
  userLimiter: FailureLimiter;
  publicApp: Express;
  adminApp: Express;
  publicUrl: string;
  adminUrl: string;
  /** Owner's username (admin) and password. */
  username: string;
  password: string;
  ownerId: string;
  /** The owner's default connection (undefined when the harness was made with connection: false). */
  connectionId: string;
  addConnection(userId: string, label: string, gateway?: FakeGateway): Promise<string>;
  addMember(username: string, password?: string): Promise<{ id: string; username: string; password: string }>;
  close(): Promise<void>;
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

export interface HarnessOptions {
  baseUrl?: boolean;
  setup?: boolean;
  envBase?: string;
  withEvaluator?: boolean;
  /** Personalisable Code.gs text for the registry (default: none). */
  bundle?: string | null;
  connection?: boolean;
  fetchImpl?: typeof fetch;
  /** Use the real AppsScriptGateway (over `fetchImpl`) instead of FakeGateways; for contract tests. */
  realGateways?: boolean;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-test-"));
  const store = new StateStore(dir);
  await store.load();
  const usage = new UsageService(store);
  const evaluator = new FakeEvaluator();
  const gateway: FakeGateway = opts.withEvaluator ? new FakeEvalGateway(evaluator) : new FakeGateway();
  const gateways = new Map<string, FakeGateway>();
  const ipLimiter = new FailureLimiter(5, 15 * 60_000);
  const userLimiter = new FailureLimiter(5, 15 * 60_000);
  const admin = new AdminAuth();
  const accounts = new AccountService({ store, ipLimiter, userLimiter, adminSessions: admin });
  const pats = new PatService(store);
  const baseUrl = new PublicBaseUrl(opts.envBase, store);
  const registry = new ConnectionRegistry({
    store,
    pats,
    instanceLabel: "test",
    bundle: opts.bundle ?? null,
    baseUrl: () => baseUrl.get(),
    fetchImpl: opts.fetchImpl,
    gatewayFactory: opts.realGateways
      ? undefined
      : (c) => {
          let g = gateways.get(c.id);
          if (!g) {
            g = new FakeGateway();
            gateways.set(c.id, g);
          }
          return g;
        },
  });
  const provider = new GsmcpOAuthProvider({ store, accounts, connections: registry, pats, baseUrl: () => baseUrl.get() });
  const username = "admin";
  const password = "correct horse battery";
  let ownerId = "";
  if (opts.setup !== false) {
    ownerId = (await accounts.bootstrapOwner(username, password))!.id;
  }
  const publicApp = createPublicApp({ provider, baseUrl, accounts, registry, pats, usage, ipLimiter, evaluatorAvailable: !!opts.withEvaluator, trustProxy: false });
  const adminApp = createAdminApp({ auth: admin, accounts, limiter: ipLimiter, registry, baseUrl, pats, provider, usage, allowedHosts: ["admin.internal"], trustProxy: false });
  const ps = await listen(publicApp);
  const as = await listen(adminApp);
  const publicUrl = `http://127.0.0.1:${(ps.address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
  if (opts.baseUrl !== false && !opts.envBase) await baseUrl.set(publicUrl);

  const addConnection = async (userId: string, label: string, gw?: FakeGateway): Promise<string> => {
    const id = randomUUID();
    if (gw) gateways.set(id, gw);
    await store.update((st) => {
      st.connections[id] = {
        id,
        userId,
        label,
        url: `https://script.google.com/macros/s/${label.replace(/[^A-Za-z0-9]/g, "")}/exec`,
        instanceId: randomUUID(),
        secret: b64url(randomBytes(32)),
        account: `${label.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}@example.com`,
        scriptId: null,
        pairedAt: Date.now(),
        lastOkAt: null,
        lastError: null,
        evalEnabled: null,
      };
    });
    return id;
  };
  let connectionId = "";
  if (ownerId && opts.connection !== false) connectionId = await addConnection(ownerId, "Owner script", gateway);

  // The product has a single account. Tenant-isolation tests still need a second one, so this writes it straight into the
  // state (there is no way to create one through the product).
  const addMember = async (name: string, pw = "member-password-1") => {
    const id = randomUUID();
    const passwordHash = await hashPassword(pw);
    await store.update((st) => {
      st.users[id] = { id, username: name, passwordHash, role: "owner", createdAt: Date.now(), lastConnectionId: null };
    });
    return { id, username: name, password: pw };
  };

  return {
    dir, store, usage, gateway, gateways, evaluator, admin, accounts, pats, provider, baseUrl, registry, ipLimiter, userLimiter, publicApp, adminApp, publicUrl, adminUrl,
    username, password, ownerId, connectionId, addConnection, addMember,
    close: async () => {
      registry.stop();
      ps.closeAllConnections();
      as.closeAllConnections();
      await Promise.all([new Promise((r) => ps.close(r)), new Promise((r) => as.close(r))]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const b64url = (b: Buffer): string => b.toString("base64url");
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export interface OAuthTokensResp {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
}

export async function registerClient(h: Harness, redirect = "http://localhost:9999/cb"): Promise<string> {
  const r = await fetch(`${h.publicUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test Client", token_endpoint_auth_method: "none" }),
  });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${await r.text()}`);
  return ((await r.json()) as { client_id: string }).client_id;
}

export interface Login {
  cookie: string;
  csrf: string;
}

/** POST /account/login as a user; returns the session cookie and CSRF token. */
export async function accountLogin(h: Harness, username: string, password: string): Promise<Login> {
  const r = await fetch(`${h.publicUrl}/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { cookie, csrf: ((await r.json()) as { csrfToken: string }).csrfToken };
}

export const nonceOf = (html: string): string | undefined => /name="nonce" value="([^"]+)"/.exec(html)?.[1];
export const csrfOf = (html: string): string | undefined => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
export const checkedConnection = (html: string): string | undefined => /value="([^"]+)" checked/.exec(html)?.[1];

export function authorizeUrl(h: Harness, clientId: string, scope: string | undefined, redirect = "http://localhost:9999/cb"): { url: string; verifier: string; redirect: string } {
  const { verifier, challenge } = pkcePair();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st123",
  });
  if (scope) q.set("scope", scope);
  return { url: `${h.publicUrl}/authorize?${q}`, verifier, redirect };
}

export const formPost = (h: Harness, fields: Record<string, string>, cookie?: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${h.publicUrl}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...headers },
    body: new URLSearchParams(fields),
  });

/**
 * Runs authorize + consent (login inline, pick a connection, approve) and returns the authorization code plus the PKCE verifier.
 * Defaults: the owner, and whichever connection the picker preselects.
 */
export async function authorizeForCode(
  h: Harness,
  clientId: string,
  scope: string | undefined,
  redirect = "http://localhost:9999/cb",
  as: { username: string; password: string; connectionId?: string } = { username: h.username, password: h.password },
): Promise<{ code: string; verifier: string; redirect: string }> {
  const { url, verifier } = authorizeUrl(h, clientId, scope, redirect);
  const page = await fetch(url);
  const html = await page.text();
  const nonce = nonceOf(html);
  if (!nonce) throw new Error(`no consent nonce (status ${page.status}): ${html.slice(0, 200)}`);
  const login = await formPost(h, { nonce, action: "login", username: as.username, password: as.password });
  if (login.status !== 200) throw new Error(`consent login failed ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const picker = await login.text();
  const csrf = csrfOf(picker);
  const connectionId = as.connectionId ?? checkedConnection(picker);
  if (!csrf || !connectionId) throw new Error(`no picker: ${picker.slice(0, 300)}`);
  const res = await formPost(h, { nonce, action: "approve", csrf, connectionId }, cookie);
  const loc = res.headers.get("location");
  if (res.status !== 302 || !loc) throw new Error(`consent failed ${res.status}`);
  const u = new URL(loc);
  const code = u.searchParams.get("code");
  if (!code || u.searchParams.get("state") !== "st123") throw new Error(`bad redirect ${loc}`);
  return { code, verifier, redirect };
}

export async function tokenRequest(h: Harness, params: Record<string, string>): Promise<Response> {
  return fetch(`${h.publicUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

export async function fullOAuth(
  h: Harness,
  scope?: string,
  as?: { username: string; password: string; connectionId?: string },
): Promise<{ clientId: string; tokens: OAuthTokensResp }> {
  const clientId = await registerClient(h);
  const { code, verifier, redirect } = await authorizeForCode(h, clientId, scope, undefined, as);
  const r = await tokenRequest(h, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    client_id: clientId,
  });
  if (r.status !== 200) throw new Error(`token failed ${r.status} ${await r.text()}`);
  return { clientId, tokens: (await r.json()) as OAuthTokensResp };
}
