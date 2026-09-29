import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacHex } from "../src/adapters/apps-script/signing.js";
import { ConnectionRegistry } from "../src/connection/connection-registry.js";
import { loadConfig } from "../src/config.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import { createLogger } from "../src/log.js";
import { StateStore } from "../src/store/state-store.js";

let dir: string;
let store: StateStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-conn-"));
  store = new StateStore(dir);
  await store.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const URL_OK = "https://script.google.com/macros/s/abc/exec";
const BUNDLE = "// header\nvar ASMCP_SETUP_ = null;\nfunction doPost() {}\n";

interface ScriptState {
  typedCode: string | null;
  /** The token embedded in the personalised Code.gs; null = no setup block on the script. */
  setupToken: string | null;
  proofOk: boolean;
  scriptId: string | null;
  account: string;
  error: string | null;
  calls: number;
  lastRequest?: any;
}

/** A fake Apps Script that answers pair requests: by code (only after the user typed it) or by setup proof. */
function scriptFetch(state: Partial<ScriptState> = {}) {
  const st: ScriptState = { typedCode: null, setupToken: null, proofOk: true, scriptId: null, account: "me@example.com", error: null, calls: 0, ...state };
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    st.calls++;
    const req = JSON.parse(init.body as string) as { kind: string; mode?: string; pairingCode?: string; secret: string; instanceId: string; ts: number; setupProof?: string };
    st.lastRequest = req;
    let body: unknown;
    const ok = () => ({
      ok: true,
      result: {
        account: st.account,
        ...(st.scriptId ? { scriptId: st.scriptId, scriptName: null } : {}),
        proof: hmacHex(st.proofOk ? req.secret : "B".repeat(43), `v1\npair-ack\n${req.instanceId}\n${req.ts}`),
      },
    });
    if (st.error) body = { ok: false, error: { code: st.error } };
    else if (req.kind !== "pair") body = { ok: false, error: { code: "UNAUTHENTICATED", message: "x" } };
    else if (req.mode === "setup") {
      if (!st.setupToken) body = { ok: false, error: { code: "PAIRING_NOT_READY" } };
      else if (req.setupProof !== hmacHex(st.setupToken, `v1\nsetup\n${req.instanceId}\n${req.ts}\n${req.secret}`)) body = { ok: false, error: { code: "PAIRING_INVALID" } };
      else body = ok();
    } else if (!st.typedCode) body = { ok: false, error: { code: "PAIRING_NOT_READY" } };
    else if (st.typedCode !== req.pairingCode) body = { ok: false, error: { code: "PAIRING_INVALID" } };
    else body = ok();
    return new Response(JSON.stringify({ body: JSON.stringify(body), sig: null }));
  }) as unknown as typeof fetch;
  return { st, fetchImpl };
}

const OWNER = "user-owner";
const OTHER = "user-other";

function registry(fetchImpl?: typeof fetch, extra: Partial<ConstructorParameters<typeof ConnectionRegistry>[0]> = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const r = new ConnectionRegistry({ store, instanceLabel: "t", fetchImpl, now: () => t, bundle: BUNDLE, baseUrl: () => "https://mcp.example.com", ...extra });
  return { r, clock, now: () => t };
}

describe("connection registry: pending connections", () => {
  it("code mode: waiting_url -> waiting_script -> connected, persisting a connection with a fresh instanceId", async () => {
    const { st, fetchImpl } = scriptFetch();
    const { r, now } = registry(fetchImpl);
    const p0 = await r.startPending(OWNER);
    expect(p0).toMatchObject({ state: "waiting_url", setupAvailable: true, code: null });
    expect(p0.expiresAt).toBe(now() + 30 * 60_000);
    expect(JSON.stringify(p0)).not.toMatch(/secret|setupToken/);
    await expect(r.submitUrl(p0.id, OWNER, "https://evil.example/exec", "code")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(r.submitUrl(p0.id, OWNER, URL_OK, "bogus")).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const p1 = await r.submitUrl(p0.id, OWNER, URL_OK, "code");
    expect(p1.state).toBe("waiting_script");
    expect(p1.code).toMatch(/^\w{4}-\w{4}$/);
    expect(p1.codeExpiresAt).toBe(now() + 10 * 60_000);

    await r.pollOnce(); // not ready yet
    expect(r.getPending(p0.id, OWNER)!.state).toBe("waiting_script");
    st.typedCode = store.state.pendingConnections[p0.id]!.code!;
    await r.pollOnce();
    const done = r.getPending(p0.id, OWNER)!;
    expect(done).toMatchObject({ state: "connected", updated: false });
    expect(done.connection).toMatchObject({ account: "me@example.com", label: "me@example.com", url: URL_OK, state: "connected", userId: OWNER });
    expect(store.state.pendingConnections[p0.id]).toBeUndefined();
    const conn = Object.values(store.state.connections)[0]!;
    expect(conn.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(conn.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(conn.instanceId).not.toBe(store.state.instanceId);
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.filePath, "utf8")).connections[conn.id].account).toBe("me@example.com");
    // other users cannot see the outcome
    expect(r.getPending(p0.id, OTHER)).toBeUndefined();
  });

  it("setup mode: needs the bundle, sends the setup proof, and pairs without a code", async () => {
    const { st, fetchImpl } = scriptFetch();
    const noBundle = registry(fetchImpl, { bundle: null });
    const q = await noBundle.r.startPending(OWNER);
    expect(q.setupAvailable).toBe(false);
    await expect(noBundle.r.submitUrl(q.id, OWNER, URL_OK, "setup")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(() => noBundle.r.personalizedBundle(q.id, OWNER)).toThrow(GatewayError);

    const { r, now } = registry(fetchImpl);
    const p = await r.startPending(OWNER);
    const text = r.personalizedBundle(p.id, OWNER);
    const rec = store.state.pendingConnections[p.id]!;
    expect(text).toContain(`var ASMCP_SETUP_ = {"server":"https://mcp.example.com","token":"${rec.setupToken}","expiresAt":${now() + 30 * 60_000}};`);
    expect(() => r.personalizedBundle(p.id, OTHER)).toThrow(GatewayError);

    const p2 = await r.submitUrl(p.id, OWNER, URL_OK, "setup");
    expect(p2).toMatchObject({ state: "waiting_script", mode: "setup", code: null });
    await r.pollOnce();
    expect(st.lastRequest).toMatchObject({ mode: "setup" });
    expect(st.lastRequest.pairingCode).toBeUndefined();
    expect(r.getPending(p.id, OWNER)!.state).toBe("waiting_script"); // script has no setup block yet: keep waiting
    st.setupToken = rec.setupToken;
    await r.pollOnce();
    expect(r.getPending(p.id, OWNER)!.state).toBe("connected");
    expect(r.listFor(OWNER)).toHaveLength(1);
  });

  it("the bundle says server local when there is no public base URL", async () => {
    const { r } = registry(undefined, { baseUrl: () => undefined });
    const p = await r.startPending(OWNER);
    expect(r.personalizedBundle(p.id, OWNER)).toContain('"server":"local"');
  });

  it("a wrong setup token is fatal (the script burns it); a wrong proof discards the secret", async () => {
    const wrongToken = scriptFetch({ setupToken: "Z".repeat(43) });
    const a = registry(wrongToken.fetchImpl);
    const p = await a.r.startPending(OWNER);
    await a.r.submitUrl(p.id, OWNER, URL_OK, "setup");
    await a.r.pollOnce();
    expect(a.r.getPending(p.id, OWNER)).toMatchObject({ state: "failed" });
    expect(store.state.pendingConnections[p.id]).toBeUndefined();

    const badProof = scriptFetch({ typedCode: "x", proofOk: false });
    const b = registry(badProof.fetchImpl);
    const q = await b.r.startPending(OWNER);
    await b.r.submitUrl(q.id, OWNER, URL_OK, "code");
    badProof.st.typedCode = store.state.pendingConnections[q.id]!.code!;
    await b.r.pollOnce();
    expect(b.r.getPending(q.id, OWNER)!.state).toBe("failed");
    expect(Object.keys(store.state.connections)).toHaveLength(0);
    expect(Object.keys(store.state.pendingConnections)).toHaveLength(0);
  });

  it("keeps waiting with a message for a wrong typed code, a clock skew and a network failure; 20 pairings is fatal", async () => {
    const f = scriptFetch({ typedCode: "ZZZZZZZZ" });
    const { r } = registry(f.fetchImpl);
    const p = await r.startPending(OWNER);
    await r.submitUrl(p.id, OWNER, URL_OK, "code");
    await r.pollOnce();
    expect(r.getPending(p.id, OWNER)).toMatchObject({ state: "waiting_script", message: expect.stringContaining("không khớp") });
    f.st.error = "REQUEST_EXPIRED";
    await r.pollOnce();
    expect(r.getPending(p.id, OWNER)!.message).toContain("Đồng hồ");
    f.st.error = "LIMIT_EXCEEDED";
    await r.pollOnce();
    expect(r.getPending(p.id, OWNER)).toMatchObject({ state: "failed", message: expect.stringContaining("20 kết nối") });
  });

  it("an expired pending is dropped without polling; a pairing code expires after 10 min inside the 30", async () => {
    const f = scriptFetch();
    const { r, clock } = registry(f.fetchImpl);
    const p = await r.startPending(OWNER);
    await r.submitUrl(p.id, OWNER, URL_OK, "code");
    clock.advance(10 * 60_000 + 1);
    await r.pollOnce();
    expect(f.st.calls).toBe(0);
    const back = r.getPending(p.id, OWNER)!;
    expect(back).toMatchObject({ state: "waiting_url", code: null });
    expect(back.message).toContain("hết hạn");
    clock.advance(20 * 60_000);
    await r.pollOnce();
    expect(r.getPending(p.id, OWNER)).toMatchObject({ state: "expired" });
    expect(store.state.pendingConnections[p.id]).toBeUndefined();
  });

  it("pending connections are private to their user and capped per user", async () => {
    const { r } = registry();
    const first = await r.startPending(OWNER);
    for (let i = 0; i < 5; i++) await r.startPending(OWNER);
    expect(Object.values(store.state.pendingConnections).filter((p) => p.userId === OWNER)).toHaveLength(5);
    expect(store.state.pendingConnections[first.id]).toBeUndefined();
    const mine = await r.startPending(OWNER);
    await expect(r.submitUrl(mine.id, OTHER, URL_OK, "code")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await r.cancelPending(mine.id, OTHER)).toBe(false);
    expect(await r.cancelPending(mine.id, OWNER)).toBe(true);
  });
});

describe("connection registry: script identity (scriptId)", () => {
  async function pairOnce(r: ConnectionRegistry, userId: string, f: ReturnType<typeof scriptFetch>, url = URL_OK) {
    const p = await r.startPending(userId);
    await r.submitUrl(p.id, userId, url, "code");
    f.st.typedCode = store.state.pendingConnections[p.id]!.code!;
    await r.pollOnce();
    return r.getPending(p.id, userId)!;
  }

  it("re-pairing the same script updates the connection in place (same id, new url / instanceId / secret) and says so", async () => {
    const f = scriptFetch({ scriptId: "SCRIPT-1" });
    const { r } = registry(f.fetchImpl);
    const first = await pairOnce(r, OWNER, f);
    const id = first.connection!.id;
    await r.rename(id, OWNER, "My sales script");
    const before = { ...store.state.connections[id]! };

    const second = await pairOnce(r, OWNER, f, "https://script.google.com/macros/s/NEWDEPLOY/exec");
    expect(second).toMatchObject({ state: "connected", updated: true, message: "Script này đã được kết nối trước đó, đã cập nhật." });
    expect(second.connection!.id).toBe(id);
    const after = store.state.connections[id]!;
    expect(after.url).toBe("https://script.google.com/macros/s/NEWDEPLOY/exec");
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.secret).not.toBe(before.secret);
    expect(after.label).toBe("My sales script"); // the label the user chose survives
    expect(r.listFor(OWNER)).toHaveLength(1);
  });

  it("two different scripts with the same email are two connections; the same script for two users is two connections", async () => {
    const { r } = registry();
    const a = scriptFetch({ scriptId: "S-A", account: "same@example.com" });
    const b = scriptFetch({ scriptId: "S-B", account: "same@example.com" });
    const ra = registry(a.fetchImpl).r;
    await pairOnce(ra, OWNER, a);
    const rb = registry(b.fetchImpl).r;
    await pairOnce(rb, OWNER, b);
    expect(r.listFor(OWNER).map((c) => c.scriptId).sort()).toEqual(["S-A", "S-B"]);
    // same script, another user
    await pairOnce(ra, OTHER, a);
    expect(r.listFor(OTHER)).toHaveLength(1);
    expect(r.listFor(OWNER)).toHaveLength(2);
  });

  it("a script that reports no scriptId always creates a new connection; label = account (+ name when known)", async () => {
    const f = scriptFetch();
    const { r } = registry(f.fetchImpl);
    await pairOnce(r, OWNER, f);
    await pairOnce(r, OWNER, f);
    expect(r.listFor(OWNER)).toHaveLength(2);
  });

  it("a migrated connection (scriptId null) learns its scriptId on the next ping, unless another connection of the user has it", async () => {
    const { r } = registry(undefined, {
      gatewayFactory: () => ({ ping: async () => ({ account: "me@example.com", backendVersion: "1", spreadsheetCount: 0, scriptId: "LEARNED" }) }) as never,
    });
    const put = async (id: string, userId: string, scriptId: string | null) =>
      store.update((s) => {
        s.connections[id] = { id, userId, label: id, url: URL_OK, instanceId: id, secret: "s".repeat(43), account: "me@example.com", scriptId, pairedAt: 1, lastOkAt: null, lastError: null, evalEnabled: null };
      });
    await put("c1", OWNER, null);
    await put("c2", OWNER, null);
    await put("c3", OTHER, null);
    await r.ping("c1");
    expect(store.state.connections.c1!.scriptId).toBe("LEARNED");
    await r.ping("c2"); // would duplicate (userId, scriptId): left alone
    expect(store.state.connections.c2!.scriptId).toBeNull();
    await r.ping("c3"); // another user may hold the same script
    expect(store.state.connections.c3!.scriptId).toBe("LEARNED");
  });
});

describe("connection registry: health and isolation", () => {
  const put = (id: string, userId: string) =>
    store.update((s) => {
      s.connections[id] = { id, userId, label: id, url: URL_OK, instanceId: id, secret: "s".repeat(43), account: `${id}@example.com`, scriptId: null, pairedAt: 1, lastOkAt: null, lastError: null, evalEnabled: null };
    });

  it("ping failure -> error (message kept); success -> connected; each connection has its own gateway and service cache", async () => {
    let fail = false;
    const built: string[] = [];
    const { r } = registry(undefined, {
      gatewayFactory: (c) => {
        built.push(c.id);
        return {
          ping: async () => {
            if (fail) throw new GatewayError("UNAUTHENTICATED", "unauthenticated");
            return { account: `${c.id}@example.com`, backendVersion: "1", spreadsheetCount: 1 };
          },
          listSpreadsheets: async () => [{ id: `sheet-of-${c.id}`, name: c.id, alias: null, access: "read" as const, url: "u" }],
        } as never;
      },
    });
    await put("a", OWNER);
    await put("b", OTHER);
    expect((await r.ping("a")).state).toBe("connected");
    fail = true;
    const bad = await r.ping("a");
    expect(bad.state).toBe("error");
    expect(bad.message).toContain("UNAUTHENTICATED");
    expect(r.getView("b")!.state).toBe("connected"); // b was never pinged: independent
    fail = false;
    expect((await r.ping("a")).state).toBe("connected");
    await r.pingAll();
    expect(store.state.connections.a!.lastOkAt).not.toBeNull();

    const ra = r.resolve("a", OWNER)!;
    const rb = r.resolve("b", OTHER)!;
    expect(ra.service).not.toBe(rb.service);
    expect(r.resolve("a", OWNER)!.service).toBe(ra.service); // cached
    expect((await ra.service.listSpreadsheets())[0]!.id).toBe("sheet-of-a");
    expect((await rb.service.listSpreadsheets())[0]!.id).toBe("sheet-of-b");
    expect(built.sort()).toEqual(["a", "b"]);
    expect(r.resolve("a", OTHER)).toBeUndefined(); // not theirs
    expect(await r.remove("a", OTHER)).toBe(false);
    expect(await r.remove("a", null)).toBe(true); // the owner acting from the admin UI
    expect(r.resolve("a", OWNER)).toBeUndefined();
    await expect(r.ping("a")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("rename validates and is scoped to the user", async () => {
    const { r } = registry();
    await put("a", OWNER);
    expect(await r.rename("a", OTHER, "x")).toBeUndefined();
    await expect(r.rename("a", OWNER, "  ")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await r.rename("a", OWNER, "  Sales  "))!.label).toBe("Sales");
  });
});

describe("state store", () => {
  it("serializes concurrent writes and leaves no tmp files", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.update((s) => void (s.publicBaseUrl = `https://h${i}.example.com`))));
    const fs = await import("node:fs/promises");
    expect((await fs.readdir(dir)).sort()).toEqual(["state.json"]);
    expect(JSON.parse(await readFile(store.filePath, "utf8")).publicBaseUrl).toBe("https://h24.example.com");
    const again = new StateStore(dir);
    await again.load();
    expect(again.state.instanceId).toBe(store.state.instanceId);
  });
  it("refuses to start on a corrupt file instead of silently resetting", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(store.filePath, "{not json");
    await expect(new StateStore(dir).load()).rejects.toThrow();
  });
});

describe("logger", () => {
  it("never writes secret-like fields", () => {
    const lines: string[] = [];
    const log = createLogger("debug", (l) => lines.push(l));
    log.info("evt", { action: "range.read", spreadsheetId: "s1", durationMs: 5, resultCode: "OK", secret: "S3CRET", token: "T", password: "P", pairingCode: "ABCD", body: "B", values: "V", query: "Q", cellCount: 4 });
    const out = lines.join("\n");
    for (const leak of ["S3CRET", '"T"', '"P"', "ABCD", '"B"', '"V"', '"Q"']) expect(out).not.toContain(leak);
    expect(out).toContain('"action":"range.read"');
    expect(out).toContain('"cellCount":4');
    expect(out).toContain('"resultCode":"OK"');
  });
  it("respects level", () => {
    const lines: string[] = [];
    const log = createLogger("warn", (l) => lines.push(l));
    log.info("x");
    log.warn("y");
    expect(lines).toHaveLength(1);
  });
});

describe("config", () => {
  it("defaults and parsing", () => {
    expect(loadConfig({})).toMatchObject({ portPublic: 8787, portAdmin: 8788, dataDir: "/data", publicBaseUrl: undefined, adminAllowedHosts: [], logLevel: "info", trustProxy: false, appsScriptBundlePath: "/app/apps-script/Code.gs" });
    expect(loadConfig({ APPS_SCRIPT_BUNDLE_PATH: " /x/Code.gs " }).appsScriptBundlePath).toBe("/x/Code.gs");
    const c = loadConfig({ PORT_PUBLIC: "1", PUBLIC_BASE_URL: "https://a.example.com/", ADMIN_ALLOWED_HOSTS: "A.com, b.com ", TRUST_PROXY: "2", LOG_LEVEL: "debug" });
    expect(c).toMatchObject({ portPublic: 1, publicBaseUrl: "https://a.example.com", adminAllowedHosts: ["a.com", "b.com"], trustProxy: 2, logLevel: "debug" });
    expect(() => loadConfig({ PUBLIC_BASE_URL: "http://a.example.com" })).toThrow();
    expect(() => loadConfig({ PORT_ADMIN: "x" })).toThrow();
  });
});
