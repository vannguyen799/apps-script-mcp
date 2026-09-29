import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPasswordHash, hashPassword } from "../src/auth/admin-auth.js";
import type { Harness } from "./helpers.js";
import { makeHarness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h.close();
});

interface Resp {
  status: number;
  json: any;
  headers: Headers;
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; csrf?: string; host?: string; origin?: string; contentType?: string | null } = {}): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
  if (opts.host) headers.host = opts.host;
  if (opts.origin) headers.origin = opts.origin;
  const r = await fetch(`${h.adminUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) });
  const t = await r.text();
  let json: unknown = t;
  try {
    json = JSON.parse(t);
  } catch {
    /* html */
  }
  return { status: r.status, json, headers: r.headers };
}

const cookieOf = (r: Resp): string => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

describe("first-run setup", () => {
  beforeEach(async () => {
    h = await makeHarness({ setup: false });
  });

  it("requires setup; setup token is one-time and only its hash is stored", async () => {
    expect((await call("GET", "/api/session")).json).toMatchObject({ setupRequired: true, authenticated: false });
    const token = (await h.admin.ensureSetupToken())!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 bytes b64url
    expect(JSON.stringify(h.store.state)).not.toContain(token);
    expect(h.store.state.admin.setupTokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await call("POST", "/api/login", { body: { password: "whatever12345" } })).status).toBe(409);
    expect((await call("POST", "/api/setup", { body: { setupToken: "bad", password: "longenough123" } })).status).toBe(401);
    expect((await call("POST", "/api/setup", { body: { setupToken: token, password: "short" } })).json.error.code).toBe("WEAK_PASSWORD");

    const ok = await call("POST", "/api/setup", { body: { setupToken: token, password: "longenough123" } });
    expect(ok.status).toBe(200);
    expect(ok.json.csrfToken).toBeTruthy();
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^asmcp_admin=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(h.store.state.admin.setupTokenHash).toBeNull();
    expect(h.store.state.admin.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);

    // token cannot be reused
    expect((await call("POST", "/api/setup", { body: { setupToken: token, password: "another-long-pass" } })).status).toBe(409);
    expect(h.admin.needsSetup()).toBe(false);
    expect(await h.admin.ensureSetupToken()).toBeNull();
  });

  it("scrypt hashes verify and are salted", async () => {
    const a = await hashPassword("secret-password");
    const b = await hashPassword("secret-password");
    expect(a).not.toBe(b);
    expect(await verifyPasswordHash("secret-password", a)).toBe(true);
    expect(await verifyPasswordHash("secret-passwora", a)).toBe(false);
  });
});

describe("admin API security", () => {
  let cookie: string;
  let csrf: string;
  beforeEach(async () => {
    h = await makeHarness();
    const r = await call("POST", "/api/login", { body: { password: h.password } });
    cookie = cookieOf(r);
    csrf = r.json.csrfToken;
  });

  it("Host allowlist: localhost/127.0.0.1/[::1] and ADMIN_ALLOWED_HOSTS pass, everything else is 421", async () => {
    // fetch() cannot override Host, so drive the check with raw sockets via http.request
    const { request } = await import("node:http");
    const hit = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(h.adminUrl);
        const req = request({ host: u.hostname, port: u.port, path: "/api/session", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
    for (const ok of ["localhost:8788", "127.0.0.1", "[::1]:8788", "LOCALHOST", "admin.internal:9000"]) expect(await hit(ok), ok).toBe(200);
    for (const bad of ["evil.com", "localhost.evil.com", "127.0.0.1.evil.com:8788", "192.168.1.5:8788", "admin.internal.evil.com"]) expect(await hit(bad), bad).toBe(421);
  });

  it("unauthenticated API calls are 401", async () => {
    expect((await call("GET", "/api/status")).status).toBe(401);
    expect((await call("POST", "/api/pats", { body: { label: "x", scopes: ["sheets.read"] } })).status).toBe(401);
  });

  it("CSRF: state-changing calls need X-CSRF-Token equal to the session's", async () => {
    const body = { label: "x", scopes: ["sheets.read"] };
    expect((await call("POST", "/api/pats", { cookie, body })).json.error.code).toBe("BAD_CSRF");
    expect((await call("POST", "/api/pats", { cookie, body, csrf: "wrong" })).status).toBe(403);
    const ok = await call("POST", "/api/pats", { cookie, body, csrf });
    expect(ok.status).toBe(201);
    expect(ok.json.token).toMatch(/^asmcp_pat_/);
    // GET does not need it
    expect((await call("GET", "/api/pats", { cookie })).json.pats).toHaveLength(1);
    // DELETE does
    const id = ok.json.pat.id as string;
    expect((await call("DELETE", `/api/pats/${id}`, { cookie, body: {} })).status).toBe(403);
    expect((await call("DELETE", `/api/pats/${id}`, { cookie, body: {}, csrf })).status).toBe(200);
  });

  it("the PAT list never returns the token again", async () => {
    await call("POST", "/api/pats", { cookie, csrf, body: { label: "x", scopes: ["sheets.read"] } });
    const list = await call("GET", "/api/pats", { cookie });
    expect(JSON.stringify(list.json)).not.toMatch(/asmcp_pat_[A-Za-z0-9_-]{8,}/);
    expect(list.json.pats[0].hint).toMatch(/^asmcp_pat_/);
    expect(Object.keys(list.json.pats[0])).not.toContain("token");
  });

  it("requires Content-Type: application/json on POST", async () => {
    const r = await call("POST", "/api/pats", { cookie, csrf, contentType: "text/plain", body: '{"label":"x","scopes":["sheets.read"]}' });
    expect(r.status).toBe(415);
    const nobody = await call("POST", "/api/login", { contentType: "application/x-www-form-urlencoded", body: "password=x" });
    expect(nobody.status).toBe(415);
  });

  it("Origin, when present on POST, must match Host", async () => {
    const body = { label: "x", scopes: ["sheets.read"] };
    const u = new URL(h.adminUrl);
    expect((await call("POST", "/api/pats", { cookie, csrf, body, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/pats", { cookie, csrf, body, origin: "null" })).status).toBe(403);
    expect((await call("POST", "/api/pats", { cookie, csrf, body, origin: `http://${u.host}` })).status).toBe(201);
  });

  it("logout destroys the session", async () => {
    expect((await call("POST", "/api/logout", { cookie, csrf, body: {} })).status).toBe(200);
    expect((await call("GET", "/api/status", { cookie })).status).toBe(401);
  });

  it("login rate limit: 5 failures then 429, even for the right password", async () => {
    for (let i = 0; i < 5; i++) expect((await call("POST", "/api/login", { body: { password: "nope" + i } })).status).toBe(401);
    const blocked = await call("POST", "/api/login", { body: { password: h.password } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("status exposes the endpoint and locks the base URL when env-configured", async () => {
    const s = await call("GET", "/api/status", { cookie });
    expect(s.json.mcpEndpoint).toBe(`${h.publicUrl}/mcp`);
    expect(s.json.publicBaseUrl).toMatchObject({ source: "ui", editable: true });
    const set = await call("PUT", "/api/settings/public-base-url", { cookie, csrf, body: { value: "https://mcp.example.com/" } });
    expect(set.json.mcpEndpoint).toBe("https://mcp.example.com/mcp");
    expect((await call("PUT", "/api/settings/public-base-url", { cookie, csrf, body: { value: "http://evil.example.com" } })).status).toBe(400);
    expect((await call("PUT", "/api/settings/public-base-url", { cookie, csrf, body: { value: "https://x.example.com/path" } })).status).toBe(400);
    await h.close();
    h = await makeHarness({ envBase: "https://fixed.example.com" });
    const r = await call("POST", "/api/login", { body: { password: h.password } });
    const locked = await call("PUT", "/api/settings/public-base-url", { cookie: cookieOf(r), csrf: r.json.csrfToken, body: { value: "https://other.example.com" } });
    expect(locked.status).toBe(409);
    expect((await call("GET", "/api/status", { cookie: cookieOf(r) })).json.publicBaseUrl).toMatchObject({ value: "https://fixed.example.com", source: "env", editable: false });
  });

  it("serves the UI with a CSP nonce and no inline-script wildcard", async () => {
    const r = await fetch(`${h.adminUrl}/`);
    const csp = r.headers.get("content-security-policy")!;
    const html = await r.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("{{NONCE}}");
    expect(csp).not.toContain("unsafe-inline");
    expect(html).toContain("Tạo mã pairing");
  });

  it("spreadsheets and connection endpoints map errors", async () => {
    // not connected: the real manager has no link, so the gateway raises NOT_CONNECTED
    const noLink = await call("GET", "/api/spreadsheets", { cookie });
    expect(noLink.status).toBe(409);
    expect((await call("POST", "/api/pairing/start", { cookie, csrf, body: { url: "http://evil.example/exec" } })).status).toBe(400);
    const start = await call("POST", "/api/pairing/start", { cookie, csrf, body: { url: "https://script.google.com/macros/s/abc/exec" } });
    expect(start.status).toBe(200);
    expect(start.json.connection.state).toBe("pairing_pending");
    expect(start.json.connection.pairing.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect((await call("POST", "/api/pairing/cancel", { cookie, csrf, body: {} })).json.connection.state).toBe("not_connected");
  });
});
