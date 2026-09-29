import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPasswordHash } from "../src/auth/password.js";
import type { Harness, Login } from "./helpers.js";
import { accountLogin, fullOAuth, makeHarness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h.close();
});

interface Resp {
  status: number;
  json: any;
  headers: Headers;
}

async function call(method: string, path: string, opts: { body?: unknown; login?: Login; csrf?: string; origin?: string; contentType?: string | null } = {}): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.login) {
    headers.cookie = opts.login.cookie;
    headers["x-csrf-token"] = opts.csrf ?? opts.login.csrf;
  }
  if (opts.origin) headers.origin = opts.origin;
  const r = await fetch(`${h.publicUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) });
  const t = await r.text();
  let json: unknown = t;
  try {
    json = JSON.parse(t);
  } catch {
    /* html */
  }
  return { status: r.status, json, headers: r.headers };
}
const noCsrf = (login: Login): { login: Login; csrf: string } => ({ login, csrf: "" });

const BASE = "/account/api/settings/public-base-url";

describe("single port: / and the owner login", () => {
  it("/ redirects to /account on the same port, and /healthz answers there too", async () => {
    h = await makeHarness();
    const r = await fetch(`${h.publicUrl}/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/account");
    expect((await fetch(`${h.publicUrl}/healthz`)).status).toBe(200);
    const followed = await fetch(`${h.publicUrl}/`);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("the bootstrapped owner logs in on /account (scrypt hash, HttpOnly SameSite cookie); there is no setup flow", async () => {
    h = await makeHarness({ setup: false });
    await h.accounts.bootstrapOwner("Boss.One", "longenough123");
    expect(Object.values(h.store.state.users)).toHaveLength(1);
    expect((await call("POST", "/account/api/setup", { body: { setupToken: "x", password: "longenough123" } })).status).toBe(401);
    const ok = await call("POST", "/account/login", { body: { username: "boss.one", password: "longenough123" } });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=");
    const owners = Object.values(h.store.state.users);
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

describe("Cài đặt: public base URL, MCP endpoint, grants (session, CSRF, Origin)", () => {
  let login: Login;
  beforeEach(async () => {
    h = await makeHarness();
    login = await accountLogin(h, h.username, h.password);
  });

  it("every settings and grants endpoint is 401 without a session", async () => {
    for (const p of ["/account/api/settings", "/account/api/grants"]) expect((await call("GET", p)).status, p).toBe(401);
    expect((await call("PUT", BASE, { body: { value: "https://mcp.example.com" } })).status).toBe(401);
    expect((await call("DELETE", "/account/api/grants/x", { body: {} })).status).toBe(401);
    expect(h.baseUrl.get()).toBe(h.publicUrl);
  });

  it("writes need the session's X-CSRF-Token: none or a wrong one is 403 and changes nothing", async () => {
    const { tokens } = await (async () => ({ tokens: await fullOAuth(h) }))();
    void tokens;
    const grantId = Object.keys(h.store.state.oauth.grants)[0]!;
    for (const csrf of ["", "wrong"]) {
      const put = await call("PUT", BASE, { login, csrf, body: { value: "https://mcp.example.com" } });
      expect(put.status).toBe(403);
      expect(put.json.error.code).toBe("BAD_CSRF");
      expect((await call("DELETE", `/account/api/grants/${grantId}`, { login, csrf, body: {} })).status).toBe(403);
    }
    expect(h.baseUrl.get()).toBe(h.publicUrl);
    expect(h.provider.listGrants()).toHaveLength(1);
    // GET needs no CSRF token
    expect((await call("GET", "/account/api/settings", noCsrf(login))).status).toBe(200);
  });

  it("writes need application/json and a matching Origin", async () => {
    expect((await call("PUT", BASE, { login, contentType: "text/plain", body: "{}" })).status).toBe(415);
    expect((await call("PUT", BASE, { login, origin: "https://evil.example", body: { value: "https://x.example.com" } })).status).toBe(403);
    expect((await call("PUT", BASE, { login, origin: "null", body: { value: "https://x.example.com" } })).status).toBe(403);
    expect((await call("DELETE", "/account/api/grants/x", { login, origin: "https://evil.example", body: {} })).status).toBe(403);
    expect(h.baseUrl.get()).toBe(h.publicUrl);
    expect((await call("PUT", BASE, { login, origin: h.publicUrl, body: { value: "https://ok.example.com" } })).status).toBe(200);
  });

  it("exposes the endpoint and the source, validates and saves the URL, and can clear it", async () => {
    const s = await call("GET", "/account/api/settings", noCsrf(login));
    expect(s.json.mcpEndpoint).toBe(`${h.publicUrl}/mcp`);
    expect(s.json.publicBaseUrl).toMatchObject({ value: h.publicUrl, source: "ui", editable: true });
    const set = await call("PUT", BASE, { login, body: { value: "https://mcp.example.com/" } });
    expect(set.json.mcpEndpoint).toBe("https://mcp.example.com/mcp");
    expect(set.json.publicBaseUrl).toMatchObject({ value: "https://mcp.example.com", source: "ui", editable: true });
    expect((await call("PUT", BASE, { login, body: { value: "http://evil.example.com" } })).status).toBe(400);
    expect((await call("PUT", BASE, { login, body: { value: "https://x.example.com/path" } })).status).toBe(400);
    expect(h.baseUrl.get()).toBe("https://mcp.example.com");
    const cleared = await call("PUT", BASE, { login, body: { value: "" } });
    expect(cleared.json).toMatchObject({ mcpEndpoint: null, publicBaseUrl: { value: null, source: null } });
  });

  it("is locked (409, shown as disabled with its source) when PUBLIC_BASE_URL is set", async () => {
    await h.close();
    h = await makeHarness({ envBase: "https://fixed.example.com" });
    const l = await accountLogin(h, h.username, h.password);
    const locked = await call("PUT", BASE, { login: l, body: { value: "https://other.example.com" } });
    expect(locked.status).toBe(409);
    expect((await call("GET", "/account/api/settings", noCsrf(l))).json.publicBaseUrl).toMatchObject({ value: "https://fixed.example.com", source: "env", editable: false });
    expect(h.baseUrl.get()).toBe("https://fixed.example.com");
  });

  it("is locked too while a built-in tunnel supplies the URL", async () => {
    h.baseUrl.setTunnelUrl("https://abc.trycloudflare.com");
    const s = await call("GET", "/account/api/settings", noCsrf(login));
    expect(s.json.publicBaseUrl).toMatchObject({ value: "https://abc.trycloudflare.com", source: "tunnel", editable: false });
    expect(s.json.mcpEndpoint).toBe("https://abc.trycloudflare.com/mcp");
    expect((await call("PUT", BASE, { login, body: { value: "https://other.example.com" } })).status).toBe(409);
  });

  it("lists the owner's OAuth grants without any token or secret, and revoking one kills its tokens", async () => {
    const { tokens } = await fullOAuth(h);
    const list = await call("GET", "/account/api/grants", noCsrf(login));
    expect(list.json.grants).toHaveLength(1);
    expect(list.json.grants[0]).toMatchObject({ clientName: "Test Client", connectionLabel: "Owner script", scopes: ["sheets.read", "sheets.write"] });
    const raw = JSON.stringify(list.json);
    for (const leak of [tokens.access_token, tokens.refresh_token, "secret", "hash"]) expect(raw).not.toContain(leak);
    const id = list.json.grants[0].id as string;
    expect((await call("DELETE", `/account/api/grants/${id}`, { login, body: {} })).status).toBe(200);
    expect((await call("DELETE", `/account/api/grants/${id}`, { login, body: {} })).status).toBe(404);
    expect((await call("GET", "/account/api/grants", noCsrf(login))).json.grants).toEqual([]);
    await expect(h.provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("a session only sees and revokes its own user's grants", async () => {
    const mary = await h.addMember("mary", "mary-password-1");
    const maryConn = await h.addConnection(mary.id, "Mary script");
    await fullOAuth(h, undefined, { username: "mary", password: mary.password, connectionId: maryConn });
    const maryGrant = h.provider.listGrants(mary.id)[0]!.id;
    expect((await call("GET", "/account/api/grants", noCsrf(login))).json.grants).toEqual([]);
    expect((await call("DELETE", `/account/api/grants/${maryGrant}`, { login, body: {} })).status).toBe(404);
    expect(h.provider.listGrants(mary.id)).toHaveLength(1);
  });

  it("the page has the Cài đặt section, a nonce CSP, and every element the script uses exists", async () => {
    const r = await fetch(`${h.publicUrl}/account`);
    const csp = r.headers.get("content-security-policy")!;
    const html = await r.text();
    expect(html).toContain("Cài đặt");
    expect(html).toContain('id="form-base"');
    expect(html).toContain('id="grant-list"');
    expect(html).toContain('id="mcp-endpoint"');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain("8787");
    expect(csp).not.toContain("unsafe-inline");
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
    for (const id of new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]!))) expect(html, id).toContain(`id="${id}"`);
  });
});
