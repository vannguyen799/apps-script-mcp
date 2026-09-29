import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../src/log.js";
import { StateStore, emptyState } from "../src/store/state-store.js";
import type { Harness } from "./helpers.js";
import { accountLogin, makeHarness } from "./helpers.js";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A state file as an earlier version wrote it: an owner and a member, invites, and everything the member had. */
function multiUserDoc() {
  const s = emptyState() as unknown as Record<string, any>;
  s.users = {
    o1: { id: "o1", username: "boss", passwordHash: "h", role: "owner", createdAt: 1 },
    m1: { id: "m1", username: "mary", passwordHash: "h", role: "member", createdAt: 2 },
    m2: { id: "m2", username: "mick", passwordHash: "h", role: "member", createdAt: 3 },
  };
  s.invites = { hash1: { id: "i1", createdBy: "o1", createdAt: 1, expiresAt: 9e15 } };
  const conn = (id: string, userId: string) => ({ id, userId, label: id, url: "https://script.google.com/macros/s/X/exec", instanceId: id, secret: "s", account: "a@x.com", scriptId: null, pairedAt: 1, lastOkAt: null, lastError: null, evalEnabled: null });
  s.connections = { c1: conn("c1", "o1"), c2: conn("c2", "m1") };
  s.pendingConnections = { p1: { id: "p1", userId: "m1", instanceId: "i", secret: "s", setupToken: "t", expiresAt: 9e15 }, p2: { id: "p2", userId: "o1", instanceId: "i", secret: "s", setupToken: "t", expiresAt: 9e15 } };
  s.sessions = { s1: { userId: "o1", createdAt: 1, expiresAt: 9e15 }, s2: { userId: "m1", createdAt: 1, expiresAt: 9e15 } };
  s.oauth.grants = { g1: { id: "g1", clientId: "c", userId: "o1", connectionId: "c1", scopes: ["sheets.read"], createdAt: 1 }, g2: { id: "g2", clientId: "c", userId: "m1", connectionId: "c2", scopes: ["sheets.read"], createdAt: 1 } };
  s.oauth.accessTokens = { a1: { grantId: "g1", clientId: "c", userId: "o1", connectionId: "c1", scopes: [], expiresAt: 9e15 }, a2: { grantId: "g2", clientId: "c", userId: "m1", connectionId: "c2", scopes: [], expiresAt: 9e15 } };
  s.oauth.refreshTokens = { r1: { grantId: "g1", clientId: "c", userId: "o1", connectionId: "c1", expiresAt: 9e15 }, r2: { grantId: "g2", clientId: "c", userId: "m1", connectionId: "c2", expiresAt: 9e15 } };
  s.pats = { t1: { id: "t1", userId: "o1", connectionId: "c1", label: "a", scopes: ["sheets.read"], createdAt: 1, lastUsedAt: null, hint: "x" }, t2: { id: "t2", userId: "m1", connectionId: "c2", label: "b", scopes: ["sheets.read"], createdAt: 1, lastUsedAt: null, hint: "y" } };
  return s;
}

describe("single-owner state: members and invites are dropped on load", () => {
  it("removes members with everything of theirs and every invite, logs users_pruned with only a count, and persists it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-solo-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "state.json"), JSON.stringify(multiUserDoc()));
    const lines: Array<{ event: string; fields?: unknown }> = [];
    const log: Logger = { debug() {}, info: (event, fields) => lines.push({ event, fields }), warn: (event, fields) => lines.push({ event, fields }), error: (event, fields) => lines.push({ event, fields }) };
    const store = new StateStore(dir, log);
    await store.load();
    const st = store.state;
    expect(Object.keys(st.users)).toEqual(["o1"]);
    expect(Object.keys(st.connections)).toEqual(["c1"]);
    expect(Object.keys(st.pendingConnections)).toEqual(["p2"]);
    expect(Object.keys(st.sessions)).toEqual(["s1"]);
    expect(Object.keys(st.oauth.grants)).toEqual(["g1"]);
    expect(Object.keys(st.oauth.accessTokens)).toEqual(["a1"]);
    expect(Object.keys(st.oauth.refreshTokens)).toEqual(["r1"]);
    expect(Object.keys(st.pats)).toEqual(["t1"]);
    expect((st as unknown as Record<string, unknown>).invites).toBeUndefined();

    const pruned = lines.filter((l) => l.event === "users_pruned");
    expect(pruned).toEqual([{ event: "users_pruned", fields: { count: 2 } }]);
    expect(JSON.stringify(lines)).not.toMatch(/mary|mick/);

    const onDisk = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    expect(Object.keys(onDisk.users)).toEqual(["o1"]);
    expect(onDisk.invites).toBeUndefined();

    // nothing more to prune the second time
    lines.length = 0;
    await new StateStore(dir, log).load();
    expect(lines.map((l) => l.event)).not.toContain("users_pruned");
  });

  it("invites alone (no members) are dropped silently", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-solo-"));
    dirs.push(dir);
    const doc = multiUserDoc();
    delete doc.users.m1;
    delete doc.users.m2;
    await writeFile(path.join(dir, "state.json"), JSON.stringify(doc));
    const events: string[] = [];
    const store = new StateStore(dir, { debug() {}, info: (e) => events.push(e), warn() {}, error() {} });
    await store.load();
    expect(events).not.toContain("users_pruned");
    expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).invites).toBeUndefined();
  });
});

describe("what is gone", () => {
  it("has no invite page, invite API, or user management endpoints", async () => {
    h = await makeHarness();
    for (const p of ["/account/invite", "/account/invite/accept"]) {
      const r = await fetch(`${h.publicUrl}${p}`, { method: p.endsWith("accept") ? "POST" : "GET", headers: { "content-type": "application/json" }, body: p.endsWith("accept") ? "{}" : undefined });
      expect(r.status, p).toBe(404);
    }
    const login = await fetch(`${h.adminUrl}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: h.username, password: h.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    for (const [method, p] of [["GET", "/api/users"], ["GET", "/api/invites"], ["POST", "/api/invites"], ["DELETE", "/api/users/x"], ["POST", "/api/users/x/disabled"]] as const) {
      const r = await fetch(`${h.adminUrl}${p}`, { method, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(r.status, `${method} ${p}`).toBe(404);
    }
  });

  it("the pages carry no invite or user-management UI", async () => {
    h = await makeHarness();
    for (const html of [await (await fetch(`${h.publicUrl}/account`)).text(), await (await fetch(`${h.adminUrl}/`)).text()]) {
      expect(html).not.toMatch(/lời mời|invite/i);
      expect(html).not.toContain("Người dùng");
    }
  });

  it("the owner still logs in on the public host, and sessions and logout-everywhere still work", async () => {
    h = await makeHarness();
    const a = await accountLogin(h, h.username, h.password);
    const b = await accountLogin(h, h.username, h.password);
    const r = await fetch(`${h.publicUrl}/account/api/session`, { headers: { cookie: a.cookie } });
    expect(await r.json()).toMatchObject({ authenticated: true, role: "owner" });
    const out = await fetch(`${h.publicUrl}/account/logout-all`, { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json" }, body: "{}" });
    expect(out.status).toBe(200);
    const gone = await fetch(`${h.publicUrl}/account/api/session`, { headers: { cookie: b.cookie } });
    expect(((await gone.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });
});
