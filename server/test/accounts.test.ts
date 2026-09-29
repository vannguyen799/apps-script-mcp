import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/auth/accounts.js";
import { verifyAgainstDummy } from "../src/auth/password.js";
import { StateStore } from "../src/store/state-store.js";
import { sha256Hex } from "../src/util/crypto.js";
import { originAllowed } from "../src/util/http.js";
import { FailureLimiter } from "../src/util/rate-limit.js";
import type { Harness } from "./helpers.js";
import { accountLogin, makeHarness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Resp {
  status: number;
  json: any;
  headers: Headers;
  text: string;
}
async function pub(harness: Harness, method: string, path: string, opts: { body?: unknown; cookie?: string; csrf?: string; origin?: string; contentType?: string | null; ip?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
  if (opts.origin) headers.origin = opts.origin;
  const r = await fetch(`${harness.publicUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) });
  const text = await r.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: r.status, json, headers: r.headers, text };
}

async function accountsWith(now = () => Date.now(), ipMax = 5, userMax = 5) {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-acc-"));
  const store = new StateStore(dir);
  await store.load();
  const accounts = new AccountService({ store, ipLimiter: new FailureLimiter(ipMax, 15 * 60_000, now), userLimiter: new FailureLimiter(userMax, 15 * 60_000, now), now });
  const t = await accounts.ensureSetupToken();
  await accounts.completeSetup(t!, "boss", "boss-password-1");
  return { accounts, store, dir };
}

describe("public login", () => {
  it("sets the session cookie with HttpOnly, SameSite=Lax, Path=/ (and no Secure on an http base); only its hash is persisted", async () => {
    h = await makeHarness();
    const r = await pub(h, "POST", "/account/login", { body: { username: h.username, password: h.password } });
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^asmcp_sess=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(setCookie).not.toContain("Secure");
    const raw = setCookie.split(";")[0]!.split("=")[1]!;
    const stored = Object.entries(h.store.state.sessions);
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toBe(sha256Hex(raw));
    expect(stored[0]![1]).toMatchObject({ userId: h.ownerId });
    expect(stored[0]![1].expiresAt - stored[0]![1].createdAt).toBe(30 * 24 * 3600_000);
    expect(JSON.stringify(h.store.state)).not.toContain(raw);
    expect(r.json).toMatchObject({ ok: true, username: "admin", role: "owner" });
  });

  it("adds Secure when the public base is https", async () => {
    h = await makeHarness({ envBase: "https://mcp.example.com" });
    const r = await pub(h, "POST", "/account/login", { body: { username: h.username, password: h.password } });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/; Secure/);
    expect(r.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("unknown user and wrong password give the same error; both pay the scrypt cost", async () => {
    h = await makeHarness();
    const t0 = Date.now();
    const unknown = await pub(h, "POST", "/account/login", { body: { username: "nobody", password: "whatever-password" } });
    const unknownMs = Date.now() - t0;
    const wrong = await pub(h, "POST", "/account/login", { body: { username: h.username, password: "wrong-password-x" } });
    const invalidName = await pub(h, "POST", "/account/login", { body: { username: "!!", password: "whatever-password" } });
    for (const r of [unknown, wrong, invalidName]) expect(r.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(invalidName.json).toEqual(wrong.json);
    expect(wrong.json.error.code).toBe("BAD_CREDENTIALS");
    // scrypt N=2^15 takes tens of ms; a shortcut for unknown users would answer in ~1 ms
    expect(unknownMs).toBeGreaterThan(15);
    const t1 = Date.now();
    expect(await verifyAgainstDummy("x")).toBe(false);
    expect(Date.now() - t1).toBeGreaterThan(15);
  });

  it("rate limit: 5 failures per IP then 429 with Retry-After, even for the right password", async () => {
    h = await makeHarness();
    for (let i = 0; i < 5; i++) expect((await pub(h, "POST", "/account/login", { body: { username: `user${i}`, password: "nope-nope-nope" } })).status).toBe(401);
    const blocked = await pub(h, "POST", "/account/login", { body: { username: h.username, password: h.password } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("rate limit per username: 5 failures from five different IPs block that username (right password included), not others", async () => {
    const { accounts, dir } = await accountsWith(undefined, 100, 5);
    try {
      await expect(accounts.login("boss", "boss-password-1", "9.9.9.9")).resolves.toMatchObject({ username: "boss" });
      for (let i = 0; i < 5; i++) await expect(accounts.login("boss", "wrong-wrong-wrong", `10.0.0.${i}`)).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
      await expect(accounts.login("boss", "boss-password-1", "10.0.0.99")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: expect.any(Number) });
      // same limiter also protects usernames that do not exist
      for (let i = 0; i < 5; i++) await expect(accounts.login("ghost", "wrong-wrong-wrong", `10.0.1.${i}`)).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
      await expect(accounts.login("ghost", "wrong-wrong-wrong", "10.0.1.99")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("concurrent attempts cannot outrun the limit: at most 5 password checks, the rest are RATE_LIMITED", async () => {
    const { accounts, dir } = await accountsWith();
    try {
      const rs = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => accounts.login("boss", `wrong-wrong-${i}`, "1.2.3.4")));
      const codes = rs.map((r) => (r.status === "rejected" ? (r.reason as { code: string }).code : "OK"));
      expect(codes.filter((c) => c === "BAD_CREDENTIALS")).toHaveLength(5);
      expect(codes.filter((c) => c === "RATE_LIMITED")).toHaveLength(15);
      await expect(accounts.login("boss", "boss-password-1", "5.6.7.8")).rejects.toMatchObject({ code: "RATE_LIMITED" }); // username blocked too
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("per-IP limit spans usernames; the window expires; a success resets the username counter only", async () => {
    let t = 1_000_000;
    const { accounts, dir } = await accountsWith(() => t, 5, 5);
    try {
      for (let i = 0; i < 4; i++) await expect(accounts.login("boss", "wrong-wrong-wrong", "1.2.3.4")).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
      await accounts.login("boss", "boss-password-1", "1.2.3.4"); // success: username counter reset, IP counter kept
      await expect(accounts.login("other", "wrong-wrong-wrong", "1.2.3.4")).rejects.toMatchObject({ code: "BAD_CREDENTIALS" }); // 5th failure for the IP
      await expect(accounts.login("boss", "boss-password-1", "1.2.3.4")).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await expect(accounts.login("boss", "boss-password-1", "5.6.7.8")).resolves.toBeDefined(); // another IP is fine
      t += 15 * 60_000 + 1;
      await expect(accounts.login("boss", "boss-password-1", "1.2.3.4")).resolves.toBeDefined();
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("public CSRF, Origin and content-type", () => {
  it("Origin, when present on a public POST, must equal the public base origin", async () => {
    h = await makeHarness();
    const body = { username: h.username, password: h.password };
    const evil = await pub(h, "POST", "/account/login", { body, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe("BAD_ORIGIN");
    expect((await pub(h, "POST", "/account/login", { body, origin: "null" })).status).toBe(403);
    expect((await pub(h, "POST", "/account/login", { body, origin: h.publicUrl })).status).toBe(200);
    expect((await pub(h, "POST", "/account/login", { body })).status).toBe(200); // no Origin (non-browser): allowed
    expect(Object.keys(h.store.state.sessions)).toHaveLength(2); // the rejected ones created nothing

    await h.close();
    h = await makeHarness({ envBase: "https://mcp.example.com" });
    const b2 = { username: h.username, password: h.password };
    expect((await pub(h, "POST", "/account/login", { body: b2, origin: "https://mcp.example.com" })).status).toBe(200);
    expect((await pub(h, "POST", "/account/login", { body: b2, origin: "https://mcp.example.com.evil.example" })).status).toBe(403);
    expect((await pub(h, "POST", "/account/login", { body: b2, origin: "http://mcp.example.com" })).status).toBe(403);
  });

  it("the consent POST checks Origin too", async () => {
    h = await makeHarness();
    const r = await fetch(`${h.publicUrl}/oauth/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ nonce: "x", action: "deny" }),
    });
    expect(r.status).toBe(403);
  });

  it("originAllowed: no base configured -> Origin must equal Host; loopback Host may differ from a tunnel base; rebinding hosts may not", () => {
    const req = (origin: string | undefined, host: string) => ({ headers: { origin, host } }) as unknown as Request;
    expect(originAllowed(req(undefined, "x"), "https://a.example.com")).toBe(true);
    expect(originAllowed(req("https://a.example.com", "a.example.com"), "https://a.example.com")).toBe(true);
    expect(originAllowed(req("http://localhost:8787", "localhost:8787"), "https://a.example.com")).toBe(true);
    expect(originAllowed(req("http://127.0.0.1:8787", "127.0.0.1:8787"), "https://a.example.com")).toBe(true);
    expect(originAllowed(req("http://evil.example:8787", "evil.example:8787"), "https://a.example.com")).toBe(false);
    expect(originAllowed(req("http://localhost:1", "localhost:8787"), "https://a.example.com")).toBe(false);
    expect(originAllowed(req("http://evil.example", "evil.example"), undefined)).toBe(true); // nothing configured to compare with
    expect(originAllowed(req("http://evil.example", "other.example"), undefined)).toBe(false);
    expect(originAllowed(req("not a url", "x"), "https://a.example.com")).toBe(false);
  });

  it("authenticated writes need the session's X-CSRF-Token and a JSON content type; logout does too", async () => {
    h = await makeHarness();
    const { cookie, csrf } = await accountLogin(h, h.username, h.password);
    const body = { label: "x", connectionId: h.connectionId, scopes: ["sheets.read"] };
    expect((await pub(h, "POST", "/account/api/pats", { cookie, body })).json.error.code).toBe("BAD_CSRF");
    expect((await pub(h, "POST", "/account/api/pats", { cookie, body, csrf: "wrong" })).status).toBe(403);
    expect((await pub(h, "POST", "/account/api/pats", { cookie, body: JSON.stringify(body), csrf, contentType: "text/plain" })).status).toBe(415);
    expect((await pub(h, "POST", "/account/api/pats", { cookie, body, csrf, origin: "https://evil.example" })).status).toBe(403);
    expect((await pub(h, "POST", "/account/api/pats", { cookie, body, csrf })).status).toBe(201);
    // another user's CSRF token does not work for this session
    const mary = await h.addMember("mary");
    const other = await accountLogin(h, "mary", mary.password);
    expect((await pub(h, "POST", "/account/api/pats", { cookie, body, csrf: other.csrf })).status).toBe(403);
    // GET needs no token, but does need the session
    expect((await pub(h, "GET", "/account/api/pats", { cookie })).status).toBe(200);
    expect((await pub(h, "GET", "/account/api/pats")).status).toBe(401);
    // logout
    expect((await pub(h, "POST", "/account/logout", { cookie, body: {} })).status).toBe(403);
    const out = await pub(h, "POST", "/account/logout", { cookie, csrf, body: {} });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/asmcp_sess=;.*Max-Age=0/);
    expect((await pub(h, "GET", "/account/api/pats", { cookie })).status).toBe(401);
    expect(Object.keys(h.store.state.sessions)).toHaveLength(1); // only mary's remains
  });

  it("logout everywhere removes every session of the user and none of anyone else's", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const a1 = await accountLogin(h, h.username, h.password);
    const a2 = await accountLogin(h, h.username, h.password);
    const m1 = await accountLogin(h, "mary", mary.password);
    expect((await pub(h, "POST", "/account/logout-all", { cookie: a1.cookie, body: {} })).status).toBe(403);
    expect((await pub(h, "POST", "/account/logout-all", { cookie: a1.cookie, csrf: a1.csrf, body: {} })).status).toBe(200);
    expect((await pub(h, "GET", "/account/api/session", { cookie: a2.cookie })).json.authenticated).toBe(false);
    expect((await pub(h, "GET", "/account/api/session", { cookie: a1.cookie })).json.authenticated).toBe(false);
    expect((await pub(h, "GET", "/account/api/session", { cookie: m1.cookie })).json.authenticated).toBe(true);
  });

  it("an expired session is refused", async () => {
    let t = 1_000_000;
    const { accounts, dir } = await accountsWith(() => t);
    try {
      const user = await accounts.login("boss", "boss-password-1", "1.1.1.1");
      const s = await accounts.createSession(user.id);
      expect(accounts.getSession(s.id)?.user.username).toBe("boss");
      t += 30 * 24 * 3600_000 + 1;
      expect(accounts.getSession(s.id)).toBeUndefined();
      expect(accounts.getSession(undefined)).toBeUndefined();
      expect(accounts.getSession("garbage")).toBeUndefined();
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("/account pages", () => {
  it("serves the page with a strict nonce CSP and Vietnamese text", async () => {
    h = await makeHarness();
    for (const p of ["/account"]) {
      const r = await fetch(`${h.publicUrl}${p}`);
      expect(r.status).toBe(200);
      const csp = r.headers.get("content-security-policy")!;
      const html = await r.text();
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).toContain(`<style nonce="${nonce}">`);
      expect(html).not.toContain("{{NONCE}}");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(html).toContain("Đăng nhập");
      expect(html).toContain("Thêm Apps Script");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
    }
    // a fresh nonce per response
    const a = (await fetch(`${h.publicUrl}/account`)).headers.get("content-security-policy");
    const b = (await fetch(`${h.publicUrl}/account`)).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  it("works without a configured public base URL (login is not an OAuth endpoint)", async () => {
    h = await makeHarness({ baseUrl: false });
    expect((await fetch(`${h.publicUrl}/account`)).status).toBe(200);
    expect((await pub(h, "POST", "/account/login", { body: { username: h.username, password: h.password } })).status).toBe(200);
  });
});

describe("account API scoping", () => {
  it("lists, renames, tests and removes only the caller's own connections", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const maryConn = await h.addConnection(mary.id, "Mary script");
    const owner = await accountLogin(h, h.username, h.password);
    const asMary = await accountLogin(h, "mary", mary.password);

    const ownerList = await pub(h, "GET", "/account/api/connections", { cookie: owner.cookie });
    expect(ownerList.json.connections.map((c: any) => c.label)).toEqual(["Owner script"]);
    const maryList = await pub(h, "GET", "/account/api/connections", { cookie: asMary.cookie });
    expect(maryList.json.connections.map((c: any) => c.label)).toEqual(["Mary script"]);
    expect(JSON.stringify([ownerList.json, maryList.json])).not.toMatch(/"secret"|instanceId/);

    const w = { cookie: owner.cookie, csrf: owner.csrf };
    expect((await pub(h, "PATCH", `/account/api/connections/${maryConn}`, { ...w, body: { label: "hijack" } })).status).toBe(404);
    expect((await pub(h, "POST", `/account/api/connections/${maryConn}/test`, { ...w, body: {} })).status).toBe(404);
    expect((await pub(h, "DELETE", `/account/api/connections/${maryConn}`, { ...w, body: {} })).status).toBe(404);
    expect(h.registry.get(maryConn)!.label).toBe("Mary script");

    const mine = { cookie: asMary.cookie, csrf: asMary.csrf };
    expect((await pub(h, "PATCH", `/account/api/connections/${maryConn}`, { ...mine, body: { label: "Renamed" } })).json.connection.label).toBe("Renamed");
    expect((await pub(h, "POST", `/account/api/connections/${maryConn}/test`, { ...mine, body: {} })).json.connection.state).toBe("connected");
    expect((await pub(h, "DELETE", `/account/api/connections/${maryConn}`, { ...mine, body: {} })).status).toBe(200);
    expect(h.registry.get(maryConn)).toBeUndefined();
  });

  it("PATs are bound to one of the user's own connections; nobody else's connection is accepted, and PATs are private", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const maryConn = await h.addConnection(mary.id, "Mary script");
    const owner = await accountLogin(h, h.username, h.password);
    const asMary = await accountLogin(h, "mary", mary.password);
    const create = (who: typeof owner, connectionId: string) =>
      pub(h!, "POST", "/account/api/pats", { cookie: who.cookie, csrf: who.csrf, body: { label: "cli", connectionId, scopes: ["sheets.read"] } });

    expect((await create(owner, maryConn)).status).toBe(400); // not the owner's connection
    expect((await create(owner, "nope")).status).toBe(400);
    const ok = await create(owner, h.connectionId);
    expect(ok.status).toBe(201);
    expect(ok.json.token).toMatch(/^asmcp_pat_/);
    expect(ok.json.pat).toMatchObject({ connectionId: h.connectionId, userId: h.ownerId });

    const list = await pub(h, "GET", "/account/api/pats", { cookie: owner.cookie });
    expect(list.json.pats).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(ok.json.token);
    expect((await pub(h, "GET", "/account/api/pats", { cookie: asMary.cookie })).json.pats).toEqual([]);
    expect((await pub(h, "DELETE", `/account/api/pats/${ok.json.pat.id}`, { cookie: asMary.cookie, csrf: asMary.csrf, body: {} })).status).toBe(404);
    expect((await pub(h, "DELETE", `/account/api/pats/${ok.json.pat.id}`, { cookie: owner.cookie, csrf: owner.csrf, body: {} })).status).toBe(200);
  });

  it("the Add-Apps-Script flow is private to its user and serves the personalised Code.gs as a download and as text", async () => {
    const bundle = "// header\nvar ASMCP_SETUP_ = null;\nfunction doPost() {}\n";
    h = await makeHarness({ bundle, connection: false });
    const mary = await h.addMember("mary");
    const owner = await accountLogin(h, h.username, h.password);
    const asMary = await accountLogin(h, "mary", mary.password);

    const created = await pub(h, "POST", "/account/api/pending", { cookie: owner.cookie, csrf: owner.csrf, body: {} });
    expect(created.status).toBe(201);
    const id = created.json.pending.id as string;
    expect(created.json.pending).toMatchObject({ state: "waiting_url", setupAvailable: true });
    expect(JSON.stringify(created.json)).not.toMatch(/secret|setupToken/);

    const dl = await fetch(`${h.publicUrl}/account/api/pending/${id}/Code.gs`, { headers: { cookie: owner.cookie } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="Code.gs"');
    expect(dl.headers.get("content-type")).toContain("text/plain");
    const file = await dl.text();
    const token = h.store.state.pendingConnections[id]!.setupToken;
    expect(file).toContain(`var ASMCP_SETUP_ = {"server":"${h.publicUrl}","token":"${token}","expiresAt":${h.store.state.pendingConnections[id]!.expiresAt}};`);
    expect(file).not.toContain("var ASMCP_SETUP_ = null;");
    const text = await pub(h, "GET", `/account/api/pending/${id}/bundle`, { cookie: owner.cookie });
    expect(text.json.text).toBe(file);

    // Mary cannot see, fetch, drive or cancel the owner's pending connection
    for (const [m, p, body] of [
      ["GET", `/account/api/pending/${id}`, undefined],
      ["GET", `/account/api/pending/${id}/Code.gs`, undefined],
      ["GET", `/account/api/pending/${id}/bundle`, undefined],
      ["POST", `/account/api/pending/${id}/url`, { url: "https://script.google.com/macros/s/abc/exec", mode: "code" }],
      ["DELETE", `/account/api/pending/${id}`, {}],
    ] as const) {
      const r = await pub(h, m, p, { cookie: asMary.cookie, csrf: asMary.csrf, body });
      expect([400, 404], `${m} ${p}`).toContain(r.status);
      expect(r.text).not.toContain(token);
    }
    // unauthenticated: no download either
    expect((await fetch(`${h.publicUrl}/account/api/pending/${id}/Code.gs`)).status).toBe(401);
  });

  it("option 1 is unavailable when the server has no valid Code.gs", async () => {
    h = await makeHarness({ bundle: null, connection: false });
    const owner = await accountLogin(h, h.username, h.password);
    const p = (await pub(h, "POST", "/account/api/pending", { cookie: owner.cookie, csrf: owner.csrf, body: {} })).json.pending;
    expect(p.setupAvailable).toBe(false);
    expect((await pub(h, "GET", `/account/api/pending/${p.id}/bundle`, { cookie: owner.cookie })).status).toBe(400);
    expect((await pub(h, "POST", `/account/api/pending/${p.id}/url`, { cookie: owner.cookie, csrf: owner.csrf, body: { url: "https://script.google.com/macros/s/abc/exec", mode: "setup" } })).status).toBe(400);
    expect((await pub(h, "GET", "/account/api/session", { cookie: owner.cookie })).json.setupAvailable).toBe(false);
  });
});
