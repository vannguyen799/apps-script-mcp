import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { AdminAuth } from "../src/auth/admin-auth.js";
import { GsmcpOAuthProvider } from "../src/auth/oauth-provider.js";
import { PatService } from "../src/auth/pat.js";
import { ConnectionManager } from "../src/connection/connection-manager.js";
import type { EvalResult, ScriptEvaluator } from "../src/core/script/evaluator.js";
import type * as G from "../src/core/sheets/gateway.js";
import { SheetsService } from "../src/core/sheets/sheets.service.js";
import { createAdminApp } from "../src/http/admin-app.js";
import { createPublicApp } from "../src/http/public-app.js";
import { PublicBaseUrl } from "../src/settings/public-base-url.js";
import { StateStore } from "../src/store/state-store.js";
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

export interface Harness {
  dir: string;
  store: StateStore;
  gateway: FakeGateway;
  evaluator: FakeEvaluator;
  admin: AdminAuth;
  pats: PatService;
  provider: GsmcpOAuthProvider;
  baseUrl: PublicBaseUrl;
  connection: ConnectionManager;
  service: SheetsService;
  limiter: FailureLimiter;
  publicApp: Express;
  adminApp: Express;
  publicUrl: string;
  adminUrl: string;
  password: string;
  close(): Promise<void>;
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

export async function makeHarness(opts: { baseUrl?: boolean; setup?: boolean; envBase?: string; withEvaluator?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-test-"));
  const store = new StateStore(dir);
  await store.load();
  const gateway = new FakeGateway();
  const evaluator = new FakeEvaluator();
  const limiter = new FailureLimiter(5, 15 * 60_000);
  const admin = new AdminAuth(store);
  const pats = new PatService(store);
  const baseUrl = new PublicBaseUrl(opts.envBase, store);
  const provider = new GsmcpOAuthProvider({ store, admin, limiter, pats, baseUrl: () => baseUrl.get() });
  const connection = new ConnectionManager({ store, instanceLabel: "test", gatewayFactory: () => gateway });
  const service = new SheetsService(gateway);
  const password = "correct horse battery";
  if (opts.setup !== false) {
    const t = await admin.ensureSetupToken();
    await admin.completeSetup(t!, password);
  }
  const publicApp = createPublicApp({ provider, baseUrl, service, evaluator: opts.withEvaluator ? evaluator : undefined, trustProxy: false });
  const adminApp = createAdminApp({ auth: admin, limiter, connection, baseUrl, pats, provider, allowedHosts: ["admin.internal"], trustProxy: false });
  const ps = await listen(publicApp);
  const as = await listen(adminApp);
  const publicUrl = `http://127.0.0.1:${(ps.address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
  if (opts.baseUrl !== false && !opts.envBase) await baseUrl.set(publicUrl);
  return {
    dir, store, gateway, evaluator, admin, pats, provider, baseUrl, connection, service, limiter, publicApp, adminApp, publicUrl, adminUrl, password,
    close: async () => {
      connection.stop();
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

/** Runs authorize + consent and returns the authorization code plus the PKCE verifier. */
export async function authorizeForCode(
  h: Harness,
  clientId: string,
  scope: string | undefined,
  redirect = "http://localhost:9999/cb",
): Promise<{ code: string; verifier: string; redirect: string }> {
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
  const page = await fetch(`${h.publicUrl}/authorize?${q}`);
  const html = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
  if (!nonce) throw new Error(`no consent nonce (status ${page.status}): ${html.slice(0, 200)}`);
  const res = await fetch(`${h.publicUrl}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce, password: h.password, action: "approve" }),
  });
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

export async function fullOAuth(h: Harness, scope?: string): Promise<{ clientId: string; tokens: OAuthTokensResp }> {
  const clientId = await registerClient(h);
  const { code, verifier, redirect } = await authorizeForCode(h, clientId, scope);
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
