import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacHex } from "../src/adapters/apps-script/signing.js";
import { ConnectionManager } from "../src/connection/connection-manager.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { StateStore } from "../src/store/state-store.js";

let dir: string;
let store: StateStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gsmcp-conn-"));
  store = new StateStore(dir);
  await store.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const URL_OK = "https://script.google.com/macros/s/abc/exec";

/** A fake Apps Script that requires the user to have typed the code, then answers the pair request. */
function scriptFetch(state: { typedCode: string | null; proofOk: boolean; calls: number }) {
  return (async (_u: string, init: RequestInit) => {
    state.calls++;
    const req = JSON.parse(init.body as string) as { kind: string; pairingCode: string; secret: string; instanceId: string; ts: number };
    let body: unknown;
    if (req.kind !== "pair") body = { ok: false, error: { code: "UNAUTHENTICATED", message: "x" } };
    else if (!state.typedCode) body = { ok: false, error: { code: "PAIRING_NOT_READY" } };
    else if (state.typedCode !== req.pairingCode) body = { ok: false, error: { code: "PAIRING_INVALID" } };
    else {
      const proof = hmacHex(state.proofOk ? req.secret : "B".repeat(43), `v1\npair-ack\n${req.instanceId}\n${req.ts}`);
      body = { ok: true, result: { account: "me@example.com", proof } };
    }
    return new Response(JSON.stringify({ body: JSON.stringify(body), sig: null }));
  }) as unknown as typeof fetch;
}

describe("connection manager", () => {
  it("not_connected -> pairing_pending -> connected, persisting the link", async () => {
    const s = { typedCode: null as string | null, proofOk: true, calls: 0 };
    let t = 1_000_000;
    const m = new ConnectionManager({ store, instanceLabel: "t", fetchImpl: scriptFetch(s), now: () => t });
    expect(m.status().state).toBe("not_connected");
    await expect(m.startPairing("https://evil.example/exec")).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const st = await m.startPairing(URL_OK);
    expect(st.state).toBe("pairing_pending");
    expect(st.pairing!.code).toMatch(/^\w{4}-\w{4}$/);
    expect(st.pairing!.expiresAt).toBe(t + 600_000);

    await m.pollOnce(); // not ready yet
    expect(m.status().state).toBe("pairing_pending");
    s.typedCode = store.state.pending!.code;
    await m.pollOnce();
    const done = m.status();
    expect(done).toMatchObject({ state: "connected", account: "me@example.com", appsScriptUrl: URL_OK });
    expect(store.state.pending).toBeNull();
    expect(store.state.link!.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // persisted with mode 0600
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.filePath, "utf8")).link.account).toBe("me@example.com");
  });

  it("wrong proof -> error state and the new secret is discarded", async () => {
    const s = { typedCode: null as string | null, proofOk: false, calls: 0 };
    const m = new ConnectionManager({ store, instanceLabel: "t", fetchImpl: scriptFetch(s) });
    await m.startPairing(URL_OK);
    s.typedCode = store.state.pending!.code;
    await m.pollOnce();
    expect(m.status().state).toBe("error");
    expect(store.state.link).toBeNull();
    expect(store.state.pending).toBeNull();
  });

  it("expired code clears pending without polling", async () => {
    const s = { typedCode: null as string | null, proofOk: true, calls: 0 };
    let t = 0;
    const m = new ConnectionManager({ store, instanceLabel: "t", fetchImpl: scriptFetch(s), now: () => t });
    await m.startPairing(URL_OK);
    t += 600_001;
    await m.pollOnce();
    expect(s.calls).toBe(0);
    expect(m.status().state).toBe("not_connected");
    expect(m.status().message).toContain("hết hạn");
  });

  it("a wrong typed code reports a message but keeps waiting", async () => {
    const s = { typedCode: "ZZZZZZZZ", proofOk: true, calls: 0 };
    const m = new ConnectionManager({ store, instanceLabel: "t", fetchImpl: scriptFetch(s) });
    await m.startPairing(URL_OK);
    await m.pollOnce();
    expect(m.status()).toMatchObject({ state: "pairing_pending" });
    expect(m.status().message).toBeTruthy();
  });

  it("health ping failure -> error (message kept); success -> connected; unpair clears", async () => {
    let fail = false;
    const gw = {
      ping: async () => {
        if (fail) throw new (await import("../src/core/sheets/gateway.js")).GatewayError("UNAUTHENTICATED", "unauthenticated");
        return { account: "me@example.com", backendVersion: "1", spreadsheetCount: 1 };
      },
    };
    await store.update((x) => {
      x.link = { url: URL_OK, secret: "A".repeat(43), account: "me@example.com", pairedAt: 1 };
    });
    const m = new ConnectionManager({ store, instanceLabel: "t", gatewayFactory: () => gw as never });
    expect((await m.ping()).state).toBe("connected");
    fail = true;
    const bad = await m.ping();
    expect(bad.state).toBe("error");
    expect(bad.message).toContain("UNAUTHENTICATED");
    fail = false;
    expect((await m.ping()).state).toBe("connected");
    await m.unpair();
    expect(m.status().state).toBe("not_connected");
    expect(store.state.link).toBeNull();
    await expect(m.ping()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await expect(m.gateway.listSpreadsheets()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
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
    expect(loadConfig({})).toMatchObject({ portPublic: 8787, portAdmin: 8788, dataDir: "/data", publicBaseUrl: undefined, adminAllowedHosts: [], logLevel: "info", trustProxy: false });
    const c = loadConfig({ PORT_PUBLIC: "1", PUBLIC_BASE_URL: "https://a.example.com/", ADMIN_ALLOWED_HOSTS: "A.com, b.com ", TRUST_PROXY: "2", LOG_LEVEL: "debug" });
    expect(c).toMatchObject({ portPublic: 1, publicBaseUrl: "https://a.example.com", adminAllowedHosts: ["a.com", "b.com"], trustProxy: 2, logLevel: "debug" });
    expect(() => loadConfig({ PUBLIC_BASE_URL: "http://a.example.com" })).toThrow();
    expect(() => loadConfig({ PORT_ADMIN: "x" })).toThrow();
  });
});
