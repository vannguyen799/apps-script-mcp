import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAT_PREFIX } from "../src/auth/pat.js";
import { CONNECTION_REMOVED_MESSAGE } from "../src/connection/connection-registry.js";
import type { Harness } from "./helpers.js";
import { authorizeForCode, authorizeUrl, checkedConnection, csrfOf, formPost, FakeGateway, fullOAuth, makeHarness, nonceOf, registerClient, tokenRequest } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
  h = undefined;
});

async function mcp(token: string): Promise<Client> {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${h!.publicUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text;
const cookieOf = (r: Response): string => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

/** Opens /authorize as a fresh visitor and returns the consent nonce. */
async function startConsent(scope?: string, cookie?: string): Promise<{ nonce: string; html: string; res: Response; verifier: string }> {
  const clientId = await registerClient(h!);
  const { url, verifier } = authorizeUrl(h!, clientId, scope);
  const res = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const html = await res.text();
  return { nonce: nonceOf(html) ?? "", html, res, verifier };
}

async function loginOnConsent(nonce: string, username: string, password: string) {
  const r = await formPost(h!, { nonce, action: "login", username, password });
  return { r, cookie: cookieOf(r), html: await r.text() };
}

describe("consent (DESIGN.md 9.4)", () => {
  it("requires login: the first step is the inline login form, and approving without a session is refused", async () => {
    h = await makeHarness();
    const { nonce, html } = await startConsent("sheets.read");
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Owner script"); // no connection list before login
    expect(html).toContain("Test Client");

    const approve = await formPost(h, { nonce, action: "approve", connectionId: h.connectionId, csrf: "x" });
    expect(approve.status).toBe(401);
    expect(approve.headers.get("location")).toBeNull();
    // the nonce survives the failed attempt
    const again = await formPost(h, { nonce, action: "login", username: h.username, password: h.password });
    expect(again.status).toBe(200);
  });

  it("wrong password re-renders the login with the nonce preserved and counts toward the limits; unknown user gives the same error", async () => {
    h = await makeHarness();
    const { nonce } = await startConsent();
    const bad = await loginOnConsent(nonce, h.username, "nope-nope-nope");
    const unknown = await loginOnConsent(nonce, "nobody", "nope-nope-nope");
    expect(bad.r.status).toBe(401);
    expect(unknown.r.status).toBe(401);
    expect(nonceOf(bad.html)).toBe(nonce);
    const errText = (html: string) => /class="err"[^>]*>([^<]+)</.exec(html)![1];
    expect(errText(bad.html)).toBe(errText(unknown.html));
    expect(bad.cookie).toBe("");
    for (let i = 0; i < 3; i++) await loginOnConsent(nonce, h.username, "nope-nope-nope");
    const blocked = await loginOnConsent(nonce, h.username, h.password); // 5 failures: even the right password is refused
    expect(blocked.r.status).toBe(429);
    expect(blocked.r.headers.get("retry-after")).toBeTruthy();
  });

  it("after login, the picker lists only MY connections (label, Google account, status)", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    await h.addConnection(mary.id, "Mary private script");
    const second = await h.addConnection(h.ownerId, "Second owner script");
    await h.store.update((s) => {
      s.connections[second]!.lastError = "UNAUTHENTICATED: bad";
    });

    const o = await startConsent();
    const owner = await loginOnConsent(o.nonce, h.username, h.password);
    expect(owner.r.status).toBe(200);
    expect(owner.cookie).toMatch(/^asmcp_sess=/);
    expect(owner.html).toContain("Owner script");
    expect(owner.html).toContain("Second owner script");
    expect(owner.html).toContain("ownerscript@example.com");
    expect(owner.html).toContain("lỗi"); // the errored one is marked
    expect(owner.html).not.toContain("Mary private script");
    expect(owner.html.match(/type="radio"/g)).toHaveLength(2);
    expect(owner.html).toContain("Thêm Apps Script mới");
    expect(csrfOf(owner.html)).toBeTruthy();

    const m = await startConsent();
    const asMary = await loginOnConsent(m.nonce, "mary", mary.password);
    expect(asMary.html).toContain("Mary private script");
    expect(asMary.html).not.toContain("Owner script");
    expect(asMary.html.match(/type="radio"/g)).toHaveLength(1);
  });

  it("a visitor who already has a session sees the picker straight away (no second login)", async () => {
    h = await makeHarness();
    const first = await startConsent();
    const { cookie } = await loginOnConsent(first.nonce, h.username, h.password);
    const second = await startConsent(undefined, cookie);
    expect(second.html).toContain('type="radio"');
    expect(second.html).not.toContain('name="password"');
  });

  it("preselects the last used connection", async () => {
    h = await makeHarness();
    const second = await h.addConnection(h.ownerId, "Second owner script");
    // first pass: nothing used yet -> the first connection is preselected; approve the second one
    const a = await startConsent();
    const login = await loginOnConsent(a.nonce, h.username, h.password);
    expect(checkedConnection(login.html)).toBe(h.connectionId);
    const ok = await formPost(h, { nonce: a.nonce, action: "approve", csrf: csrfOf(login.html)!, connectionId: second }, login.cookie);
    expect(ok.status).toBe(302);
    // next time the second one is preselected
    const b = await startConsent(undefined, login.cookie);
    expect(checkedConnection(b.html)).toBe(second);
    expect(h.store.state.users[h.ownerId]!.lastConnectionId).toBe(second);
    // removing it falls back to the first
    await h.registry.remove(second, h.ownerId);
    const c = await startConsent(undefined, login.cookie);
    expect(checkedConnection(c.html)).toBe(h.connectionId);
  });

  it("approving a connection that belongs to somebody else is rejected and issues no code", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const maryConn = await h.addConnection(mary.id, "Mary private script");
    const { nonce } = await startConsent();
    const { cookie, html } = await loginOnConsent(nonce, h.username, h.password);
    for (const connectionId of [maryConn, "does-not-exist", ""]) {
      const r = await formPost(h, { nonce, action: "approve", csrf: csrfOf(html)!, connectionId }, cookie);
      expect(r.status, connectionId).toBe(403);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.text()).not.toContain("Mary private script");
    }
    // ...and the same nonce still works for the owner's own connection
    const ok = await formPost(h, { nonce, action: "approve", csrf: csrfOf(html)!, connectionId: h.connectionId }, cookie);
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("approve needs the session's CSRF token, and a session cookie of the same user", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const { nonce } = await startConsent();
    const { cookie, html } = await loginOnConsent(nonce, h.username, h.password);
    const noCsrf = await formPost(h, { nonce, action: "approve", connectionId: h.connectionId }, cookie);
    expect(noCsrf.status).toBe(403);
    const wrong = await formPost(h, { nonce, action: "approve", connectionId: h.connectionId, csrf: "wrong" }, cookie);
    expect(wrong.status).toBe(403);
    // Mary's CSRF token with the owner's cookie does not work either
    const mn = await startConsent();
    const mlogin = await loginOnConsent(mn.nonce, "mary", mary.password);
    const cross = await formPost(h, { nonce, action: "approve", connectionId: h.connectionId, csrf: csrfOf(mlogin.html)! }, cookie);
    expect(cross.status).toBe(403);
    expect((await formPost(h, { nonce, action: "approve", connectionId: h.connectionId, csrf: csrfOf(html)! }, cookie)).status).toBe(302);
  });

  it("the nonce is single use", async () => {
    h = await makeHarness();
    const { nonce } = await startConsent();
    const { cookie, html } = await loginOnConsent(nonce, h.username, h.password);
    const fields = { nonce, action: "approve", csrf: csrfOf(html)!, connectionId: h.connectionId };
    expect((await formPost(h, fields, cookie)).status).toBe(302);
    expect((await formPost(h, fields, cookie)).status).toBe(400);
  });

  it("zero connections: straight to the add-Apps-Script flow, which returns to the same consent", async () => {
    h = await makeHarness({ connection: false });
    const { nonce } = await startConsent();
    const login = await loginOnConsent(nonce, h.username, h.password);
    // the login POST itself redirects to the add flow
    expect(login.r.status).toBe(302);
    const first = await formPost(h, { nonce, action: "login", username: h.username, password: h.password });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`/account?add=1&consent=${encodeURIComponent(nonce)}`);

    // GET back into the consent with a session but still no connection: to the add flow again
    const cookie = cookieOf(first);
    const back = await fetch(`${h.publicUrl}/oauth/consent?nonce=${encodeURIComponent(nonce)}`, { headers: { cookie }, redirect: "manual" });
    expect(back.status).toBe(302);
    // once a connection exists the same nonce leads to the picker
    await h.addConnection(h.ownerId, "Fresh script");
    const picker = await fetch(`${h.publicUrl}/oauth/consent?nonce=${encodeURIComponent(nonce)}`, { headers: { cookie } });
    expect(picker.status).toBe(200);
    const html = await picker.text();
    expect(html).toContain("Fresh script");
    expect(nonceOf(html)).toBe(nonce);
  });

  it("the consent nonce lives 30 minutes while the user is in the add flow (10 otherwise)", async () => {
    h = await makeHarness();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { nonce } = await startConsent();
    const login = await formPost(h, { nonce, action: "login", username: h.username, password: h.password });
    const cookie = cookieOf(login);
    vi.setSystemTime(Date.now() + 9 * 60_000);
    // opening /account?consent=<nonce> (the add flow) extends it
    expect((await fetch(`${h.publicUrl}/account?add=1&consent=${encodeURIComponent(nonce)}`)).status).toBe(200);
    vi.setSystemTime(Date.now() + 15 * 60_000); // 24 min after authorize: dead without the extension
    const back = await fetch(`${h.publicUrl}/oauth/consent?nonce=${encodeURIComponent(nonce)}`, { headers: { cookie } });
    expect(back.status).toBe(200);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect((await fetch(`${h.publicUrl}/oauth/consent?nonce=${encodeURIComponent(nonce)}`, { headers: { cookie } })).status).toBe(400);

    // without the extension the nonce dies after 10 minutes
    const { nonce: n2 } = await startConsent();
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect((await formPost(h, { nonce: n2, action: "login", username: h.username, password: h.password })).status).toBe(400);
  });

  it("shows the red script.eval warning only when it is requested, on the picker too", async () => {
    h = await makeHarness({ withEvaluator: true });
    const a = await startConsent("sheets.read script.eval");
    const login = await loginOnConsent(a.nonce, h.username, h.password);
    expect(login.html).toContain('class="danger"');
    expect(login.html).toContain("<code>script.eval</code>");
    const b = await startConsent("sheets.read");
    const plain = await loginOnConsent(b.nonce, h.username, h.password);
    expect(plain.html).not.toContain('class="danger"');
    expect(plain.html).not.toContain("script.eval");
  });

  it("deny needs no login and redirects with access_denied", async () => {
    h = await makeHarness();
    const { nonce } = await startConsent();
    const r = await formPost(h, { nonce, action: "deny" });
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("the page is served with a nonce'd style and no script at all", async () => {
    h = await makeHarness();
    const { res, html } = await startConsent();
    const csp = res.headers.get("content-security-policy")!;
    const styleNonce = /style-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<style nonce="${styleNonce}">`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("grants, tokens and PATs carry {userId, connectionId}", () => {
  it("the grant, access token, refresh token and AuthInfo.extra all carry them; refresh keeps them", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const maryConn = await h.addConnection(mary.id, "Mary script");
    const { clientId, tokens } = await fullOAuth(h, "sheets.read", { username: "mary", password: mary.password });
    const grants = Object.values(h.store.state.oauth.grants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ userId: mary.id, connectionId: maryConn });
    expect(Object.values(h.store.state.oauth.accessTokens)[0]).toMatchObject({ userId: mary.id, connectionId: maryConn });
    expect(Object.values(h.store.state.oauth.refreshTokens)[0]).toMatchObject({ userId: mary.id, connectionId: maryConn });
    expect((await h.provider.verifyAccessToken(tokens.access_token)).extra).toMatchObject({ kind: "oauth", userId: mary.id, connectionId: maryConn });

    const r = await tokenRequest(h, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    const t2 = (await r.json()) as { access_token: string };
    expect((await h.provider.verifyAccessToken(t2.access_token)).extra).toMatchObject({ userId: mary.id, connectionId: maryConn });
    expect(h.provider.listGrants(mary.id)).toHaveLength(1);
    expect(h.provider.listGrants(h.ownerId)).toHaveLength(0);
    expect(h.provider.listGrants()[0]).toMatchObject({ username: "mary", connectionLabel: "Mary script" });
  });

  it("a PAT is bound to a connection of its creator and only that", async () => {
    h = await makeHarness();
    const mary = await h.addMember("mary");
    const maryConn = await h.addConnection(mary.id, "Mary script");
    await expect(h.pats.create(h.ownerId, maryConn, "steal", ["sheets.read"])).rejects.toThrow();
    await expect(h.pats.create(h.ownerId, "nope", "x", ["sheets.read"])).rejects.toThrow();
    const { token, pat } = await h.pats.create(mary.id, maryConn, "mine", ["sheets.read"]);
    expect(pat).toMatchObject({ userId: mary.id, connectionId: maryConn });
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    expect(Object.values(h.store.state.pats)[0]).toMatchObject({ userId: mary.id, connectionId: maryConn });
    expect((await h.provider.verifyAccessToken(token)).extra).toMatchObject({ kind: "pat", patId: pat.id, userId: mary.id, connectionId: maryConn });
    expect(h.pats.list(mary.id)).toHaveLength(1);
    expect(h.pats.list(h.ownerId)).toHaveLength(0);
    expect(await h.pats.revoke(pat.id, h.ownerId)).toBe(false); // not theirs
    expect(await h.pats.revoke(pat.id, mary.id)).toBe(true);
  });

  it("two PATs of one user on two connections each reach their own script", async () => {
    h = await makeHarness();
    const gwB = new FakeGateway();
    gwB.spreadsheets = [{ id: "id-b", name: "Book B", alias: "b", access: "read", url: "u" }];
    const connB = await h.addConnection(h.ownerId, "Second script", gwB);
    const a = await h.pats.create(h.ownerId, h.connectionId, "a", ["sheets.read"]);
    const b = await h.pats.create(h.ownerId, connB, "b", ["sheets.read"]);
    const names = async (token: string) => {
      const c = await mcp(token);
      const r = await c.callTool({ name: "list_spreadsheets", arguments: {} });
      await c.close();
      return JSON.parse(text(r)).spreadsheets.map((x: { alias: string | null; name: string }) => x.alias ?? x.name);
    };
    expect(await names(a.token)).toEqual(["sales", "Read Only Book"]);
    expect(await names(b.token)).toEqual(["b"]);
  });
});

describe("tenant isolation", () => {
  async function twoTenants() {
    const harness = await makeHarness();
    const mary = await harness.addMember("mary");
    const gwB = new FakeGateway();
    gwB.spreadsheets = [{ id: "id-mary", name: "Mary secrets", alias: "secrets", access: "write", url: "u" }];
    const maryConn = await harness.addConnection(mary.id, "Mary script", gwB);
    return { harness, mary, maryConn, gwA: harness.gateway, gwB };
  }

  it("user A's token never reaches user B's connection, whatever the tool input says", async () => {
    const t = await twoTenants();
    h = t.harness;
    const a = await fullOAuth(h, "sheets.read sheets.write", { username: h.username, password: h.password });
    const b = await fullOAuth(h, "sheets.read sheets.write", { username: "mary", password: t.mary.password });
    const ca = await mcp(a.tokens.access_token);
    const cb = await mcp(b.tokens.access_token);

    const listA = JSON.parse(text(await ca.callTool({ name: "list_spreadsheets", arguments: {} })));
    expect(listA.spreadsheets.map((s: { id: string }) => s.id)).toEqual(["id-sales", "id-ro"]);
    const listB = JSON.parse(text(await cb.callTool({ name: "list_spreadsheets", arguments: {} })));
    expect(listB.spreadsheets.map((s: { id: string }) => s.id)).toEqual(["id-mary"]);
    expect(t.gwB.calls.filter((c) => c.method === "listSpreadsheets")).toHaveLength(1);
    expect(t.gwA.calls.filter((c) => c.method === "listSpreadsheets")).toHaveLength(1);

    // B's spreadsheet is invisible to A by name and by ID
    for (const spreadsheet of ["secrets", "Mary secrets", "id-mary"]) {
      const r = await ca.callTool({ name: "read_range", arguments: { spreadsheet, range: "S!A1" } });
      expect(r.isError, spreadsheet).toBe(true);
    }
    // A connection id smuggled into tool input is not a parameter: ignored or rejected, never used
    const smuggled = await ca.callTool({ name: "read_range", arguments: { spreadsheet: "id-mary", range: "S!A1", connectionId: t.maryConn, connection_id: t.maryConn } }).catch((e: Error) => e);
    expect((smuggled as { isError?: boolean }).isError === true || smuggled instanceof Error).toBe(true);
    const w = await ca.callTool({ name: "write_range", arguments: { spreadsheet: "sales", range: "S!A1", values: [["x"]], connectionId: t.maryConn } }).catch((e: Error) => e);
    void w;
    expect(t.gwB.calls.some((c) => ["readRange", "writeRange", "appendRows", "batchUpdate", "search", "getMetadata"].includes(c.method))).toBe(false);
    await ca.close();
    await cb.close();
  });

  it("no tool accepts a connection id as input", async () => {
    const t = await twoTenants();
    h = t.harness;
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "x", ["sheets.read", "sheets.write", "script.eval"]);
    const c = await mcp(token);
    for (const tool of (await c.listTools()).tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/connection/i);
    }
    await c.close();
  });

  it("the registry refuses a connection id with the wrong user id, even if the id is right", () => {
    return (async () => {
      const t = await twoTenants();
      h = t.harness;
      expect(h.registry.resolve(t.maryConn, t.mary.id)).toBeDefined();
      expect(h.registry.resolve(t.maryConn, h.ownerId)).toBeUndefined();
      expect(h.registry.resolve(h.connectionId, t.mary.id)).toBeUndefined();
      expect(h.registry.resolve("unknown", h.ownerId)).toBeUndefined();
      // a token whose bound user does not own the connection (corrupted state) fails closed at the tool
      const { token } = await h.pats.create(h.ownerId, h.connectionId, "x", ["sheets.read"]);
      await h.store.update((s) => {
        const rec = Object.values(s.pats)[0]!;
        rec.connectionId = t.maryConn; // forge a cross-tenant binding
      });
      const c = await mcp(token);
      const r = await c.callTool({ name: "list_spreadsheets", arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(CONNECTION_REMOVED_MESSAGE);
      expect(t.gwB.calls).toEqual([]);
      await c.close();
    })();
  });

  it("removing a connection makes its OAuth tokens and PATs fail cleanly (a tool error, no crash, no fallback to another connection)", async () => {
    const t = await twoTenants();
    h = t.harness;
    const second = await h.addConnection(h.ownerId, "Another owner script");
    const oauth = await fullOAuth(h, "sheets.read", { username: h.username, password: h.password, connectionId: h.connectionId });
    const { token: pat } = await h.pats.create(h.ownerId, h.connectionId, "cli", ["sheets.read"]);
    const marys = await h.pats.create(t.mary.id, t.maryConn, "marys", ["sheets.read"]);

    const before = await mcp(oauth.tokens.access_token);
    expect((await before.callTool({ name: "list_spreadsheets", arguments: {} })).isError).toBeFalsy();
    await before.close();

    expect(await h.registry.remove(h.connectionId, h.ownerId)).toBe(true);
    const callsBefore = h.gateways.get(second)?.calls.length ?? 0;
    for (const token of [oauth.tokens.access_token, pat]) {
      const c = await mcp(token); // the token itself still authenticates
      const r = await c.callTool({ name: "list_spreadsheets", arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Kết nối Apps Script đã bị xóa, hãy kết nối lại");
      const w = await c.callTool({ name: "read_range", arguments: { spreadsheet: "sales", range: "S!A1" } });
      expect(w.isError).toBe(true);
      await c.close();
    }
    expect(h.gateways.get(second)?.calls.length ?? 0).toBe(callsBefore); // the owner's other connection was not used as a fallback
    expect(t.gwB.calls).toEqual([]);

    // Mary is unaffected
    const cm = await mcp(marys.token);
    const ok = await cm.callTool({ name: "list_spreadsheets", arguments: {} });
    expect(ok.isError).toBeFalsy();
    await cm.close();
  });

  it("a PAT presented as a different user's is not a thing: extra always comes from the stored record", async () => {
    const t = await twoTenants();
    h = t.harness;
    const owners = await h.pats.create(h.ownerId, h.connectionId, "owners", ["sheets.read"]);
    const info = await h.provider.verifyAccessToken(owners.token);
    expect(info.extra).toEqual({ kind: "pat", patId: owners.pat.id, userId: h.ownerId, connectionId: h.connectionId });
  });
});

describe("script.eval keeps its section 8.2 behaviour with connections", () => {
  it("run_apps_script needs the scope and runs on the token's connection only", async () => {
    h = await makeHarness({ withEvaluator: true });
    const mary = await h.addMember("mary");
    const gwB = new FakeGateway(); // cannot evaluate
    const maryConn = await h.addConnection(mary.id, "Mary script", gwB);
    const plain = await h.pats.create(h.ownerId, h.connectionId, "plain", ["sheets.read", "sheets.write"]);
    const evalPat = await h.pats.create(h.ownerId, h.connectionId, "eval", ["script.eval"]);
    const maryEval = await h.pats.create(mary.id, maryConn, "eval", ["script.eval"]);

    const c1 = await mcp(plain.token);
    const denied = await c1.callTool({ name: "run_apps_script", arguments: { code: "return 1;" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("INSUFFICIENT_SCOPE");
    await c1.close();

    const c2 = await mcp(evalPat.token);
    const ok = await c2.callTool({ name: "run_apps_script", arguments: { code: "return 1;", args: { a: 1 } } });
    expect(ok.isError).toBeFalsy();
    expect(h.evaluator.calls).toEqual([{ code: "return 1;", args: { a: 1 } }]);
    await c2.close();

    // Mary's connection cannot evaluate: a clean error, and the owner's evaluator is untouched
    const c3 = await mcp(maryEval.token);
    const r = await c3.callTool({ name: "run_apps_script", arguments: { code: "return 2;" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("UNKNOWN_ACTION");
    expect(h.evaluator.calls).toHaveLength(1);
    await c3.close();
  });
});
