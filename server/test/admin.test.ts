import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPasswordHash } from "../src/auth/password.js";
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

describe("owner account", () => {
  beforeEach(async () => {
    h = await makeHarness({ setup: false });
  });

  it("has no setup flow: /api/setup is gone, the session says nothing about setup, and login works for the owner", async () => {
    await h.accounts.bootstrapOwner("Boss.One", "longenough123");
    expect((await call("GET", "/api/session")).json).toEqual({ authenticated: false, csrfToken: null, username: null });
    expect((await call("POST", "/api/setup", { body: { setupToken: "x", password: "longenough123" } })).status).toBe(401); // no such route: falls through to the auth wall
    expect(Object.values(h.store.state.users)).toHaveLength(1);
    const ok = await call("POST", "/api/login", { body: { username: "boss.one", password: "longenough123" } });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^asmcp_admin=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const owners = Object.values(h.store.state.users);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ username: "boss.one", role: "owner" });
    expect(owners[0]!.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h.store.state).not.toHaveProperty("admin");
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
    const r = await call("POST", "/api/login", { body: { username: h.username, password: h.password } });
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
    for (const p of ["/api/usage", "/api/connections", "/api/pats", "/api/grants"]) expect((await call("GET", p)).status, p).toBe(401);
    expect((await call("POST", "/api/pending", { body: {} })).status).toBe(401);
  });

  it("CSRF: state-changing calls need X-CSRF-Token equal to the session's", async () => {
    expect((await call("POST", "/api/pending", { cookie, body: {} })).json.error.code).toBe("BAD_CSRF");
    expect((await call("POST", "/api/pending", { cookie, body: {}, csrf: "wrong" })).status).toBe(403);
    const ok = await call("POST", "/api/pending", { cookie, body: {}, csrf });
    expect(ok.status).toBe(201);
    // GET does not need it
    const id = ok.json.pending.id as string;
    expect((await call("GET", `/api/pending/${id}`, { cookie })).status).toBe(200);
    // DELETE does
    expect((await call("DELETE", `/api/pending/${id}`, { cookie, body: {} })).status).toBe(403);
    expect((await call("DELETE", `/api/pending/${id}`, { cookie, body: {}, csrf })).status).toBe(200);
  });

  it("requires Content-Type: application/json on POST", async () => {
    const r = await call("POST", "/api/pending", { cookie, csrf, contentType: "text/plain", body: "{}" });
    expect(r.status).toBe(415);
    const nobody = await call("POST", "/api/login", { contentType: "application/x-www-form-urlencoded", body: "password=x" });
    expect(nobody.status).toBe(415);
  });

  it("Origin, when present on POST, must match Host", async () => {
    const u = new URL(h.adminUrl);
    expect((await call("POST", "/api/pending", { cookie, csrf, body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/pending", { cookie, csrf, body: {}, origin: "null" })).status).toBe(403);
    expect((await call("POST", "/api/pending", { cookie, csrf, body: {}, origin: `http://${u.host}` })).status).toBe(201);
  });

  it("logout destroys the session", async () => {
    expect((await call("POST", "/api/logout", { cookie, csrf, body: {} })).status).toBe(200);
    expect((await call("GET", "/api/status", { cookie })).status).toBe(401);
  });

  it("login rate limit: 5 failures then 429, even for the right password", async () => {
    for (let i = 0; i < 5; i++) expect((await call("POST", "/api/login", { body: { username: h.username, password: "nope" + i } })).status).toBe(401);
    const blocked = await call("POST", "/api/login", { body: { username: h.username, password: h.password } });
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
    const r = await call("POST", "/api/login", { body: { username: h.username, password: h.password } });
    const locked = await call("PUT", "/api/settings/public-base-url", { cookie: cookieOf(r), csrf: r.json.csrfToken, body: { value: "https://other.example.com" } });
    expect(locked.status).toBe(409);
    expect((await call("GET", "/api/status", { cookie: cookieOf(r) })).json.publicBaseUrl).toMatchObject({ value: "https://fixed.example.com", source: "env", editable: false });
  });

  it("serves the UI with a CSP nonce, a password-change form, no setup form and no old single-link pairing UI", async () => {
    const r = await fetch(`${h.adminUrl}/`);
    const csp = r.headers.get("content-security-policy")!;
    const html = await r.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("{{NONCE}}");
    expect(csp).not.toContain("unsafe-inline");
    expect(html).toMatch(/id="login-user"[^>]*value="admin"/);
    expect(html).not.toMatch(/setup-token|form-setup|#setup=/);
    expect(html).toContain('id="form-pw"');
    expect(html).toContain("Thêm Apps Script");
    expect(html).not.toContain("Tạo mã pairing");
    expect(html).not.toContain("btn-unpair");
  });

  it("the owner sees and removes every connection, PAT and grant", async () => {
    const m = await h.addMember("mary", "mary-password-1");
    const cid = await h.addConnection(m.id, "Mary script");
    const { pat } = await h.pats.create(m.id, cid, "mary pat", ["sheets.read"]);
    const conns = await call("GET", "/api/connections", { cookie });
    expect(conns.json.connections.map((c: any) => [c.ownerUsername, c.label]).sort()).toEqual([["admin", "Owner script"], ["mary", "Mary script"]]);
    expect(JSON.stringify(conns.json)).not.toContain("secret");
    const pats = await call("GET", "/api/pats", { cookie });
    expect(pats.json.pats[0]).toMatchObject({ username: "mary", connectionLabel: "Mary script" });
    expect((await call("DELETE", `/api/pats/${pat.id}`, { cookie, csrf, body: {} })).status).toBe(200);
    expect((await call("DELETE", `/api/connections/${cid}`, { cookie, csrf, body: {} })).status).toBe(200);
    expect((await call("DELETE", `/api/connections/${cid}`, { cookie, csrf, body: {} })).status).toBe(404);
    expect((await call("GET", "/api/grants", { cookie })).json.grants).toEqual([]);
  });

  it("the owner's pending-connection flow validates the URL and mode", async () => {
    expect((await call("POST", "/api/pending", { cookie, csrf, body: {} })).status).toBe(201);
    const p = (await call("POST", "/api/pending", { cookie, csrf, body: {} })).json.pending;
    expect((await call("POST", `/api/pending/${p.id}/url`, { cookie, csrf, body: { url: "http://evil.example/exec", mode: "code" } })).status).toBe(400);
    const ok = await call("POST", `/api/pending/${p.id}/url`, { cookie, csrf, body: { url: "https://script.google.com/macros/s/abc/exec", mode: "code" } });
    expect(ok.status).toBe(200);
    expect(ok.json.pending.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(JSON.stringify(ok.json)).not.toContain("secret");
    expect((await call("DELETE", `/api/pending/${p.id}`, { cookie, csrf, body: {} })).status).toBe(200);
    expect((await call("GET", `/api/pending/${p.id}`, { cookie })).status).toBe(404);
  });
});
