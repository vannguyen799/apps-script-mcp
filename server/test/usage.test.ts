import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/core/sheets/gateway.js";
import { createMcpServer } from "../src/mcp/server.js";
import { StateStore } from "../src/store/state-store.js";
import type { StateBackend } from "../src/store/backend.js";
import { USAGE_FLUSH_MS, USAGE_RETENTION_DAYS, UsageService } from "../src/usage/usage-service.js";
import type { Harness } from "./helpers.js";
import { accountLogin, makeHarness } from "./helpers.js";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 29, 10, 0, 0); // 2026-09-29 10:00 UTC

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-usage-"));
  dirs.push(dir);
  const store = new StateStore(dir);
  await store.load();
  return { dir, store };
}

describe("UsageService", () => {
  it("counts calls and errors per UTC day and tool; rows() shows them before they are flushed, newest day first", async () => {
    const { store } = await localStore();
    let now = T0;
    const u = new UsageService(store, { now: () => now });
    u.record("read_range", true);
    u.record("read_range", false);
    u.record("search", true);
    now = T0 + DAY;
    u.record("read_range", true);
    expect(u.rows()).toEqual([
      { day: "2026-09-30", tool: "read_range", calls: 1, errors: 0 },
      { day: "2026-09-29", tool: "read_range", calls: 2, errors: 1 },
      { day: "2026-09-29", tool: "search", calls: 1, errors: 0 },
    ]);
    expect(store.state.usage).toEqual({}); // nothing written yet: counters are batched
  });

  it("the day rolls over at 00:00 UTC", async () => {
    const { store } = await localStore();
    let now = Date.UTC(2026, 8, 29, 23, 59, 59);
    const u = new UsageService(store, { now: () => now });
    u.record("search", true);
    now += 1000;
    u.record("search", true);
    expect(u.rows().map((r) => [r.day, r.calls])).toEqual([["2026-09-30", 1], ["2026-09-29", 1]]);
  });

  it("flush merges into state.usage[day][tool] (adding to what is there), persists it, and survives a restart", async () => {
    const { dir, store } = await localStore();
    const u = new UsageService(store, { now: () => T0 });
    u.record("read_range", true);
    u.record("read_range", false);
    await u.flush();
    expect(store.state.usage).toEqual({ "2026-09-29": { read_range: { calls: 2, errors: 1 } } });
    u.record("read_range", true);
    u.record("write_range", true);
    await u.flush();
    expect(store.state.usage["2026-09-29"]).toEqual({ read_range: { calls: 3, errors: 1 }, write_range: { calls: 1, errors: 0 } });
    expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).usage).toEqual(store.state.usage);

    const reopened = new StateStore(dir);
    await reopened.load();
    const u2 = new UsageService(reopened, { now: () => T0 });
    expect(u2.rows()).toHaveLength(2);
    u2.record("read_range", true);
    expect(u2.rows().find((r) => r.tool === "read_range")).toMatchObject({ calls: 4 }); // stored + pending, not double counted
  });

  it("flush with nothing to do writes nothing", async () => {
    const backend = memoryBackend();
    const store = new StateStore(backend);
    await store.load();
    const before = backend.saves;
    const u = new UsageService(store, { now: () => T0 });
    await u.flush();
    await u.flush();
    expect(backend.saves).toBe(before);
    u.record("search", true);
    u.record("search", true);
    u.record("search", true);
    await u.flush();
    expect(backend.saves).toBe(before + 1); // many calls, one write
  });

  it("keeps 30 days: today and the 29 before it; older days are pruned on flush and hidden from rows()", async () => {
    const { store } = await localStore();
    const old = (n: number) => new Date(T0 - n * DAY).toISOString().slice(0, 10);
    await store.update((s) => {
      s.usage[old(31)] = { search: { calls: 9, errors: 0 } };
      s.usage[old(30)] = { search: { calls: 8, errors: 0 } };
      s.usage[old(29)] = { search: { calls: 7, errors: 1 } }; // the 30th day counting today: kept
      s.usage[old(1)] = { search: { calls: 6, errors: 0 } };
    });
    const u = new UsageService(store, { now: () => T0 });
    expect(USAGE_RETENTION_DAYS).toBe(30);
    expect(u.rows().map((r) => r.day)).toEqual([old(1), old(29)]); // hidden even before pruning
    await u.flush();
    expect(Object.keys(store.state.usage).sort()).toEqual([old(29), old(1)].sort());
    u.record("search", true);
    await u.flush();
    expect(Object.keys(store.state.usage)).toHaveLength(3);
  });

  it("a failing write never throws, and the counts are neither lost nor counted twice", async () => {
    const backend = memoryBackend();
    const store = new StateStore(backend);
    await store.load();
    const lines: string[] = [];
    const u = new UsageService(store, { now: () => T0, logger: { debug() {}, info() {}, error() {}, warn: (e) => lines.push(e) } });
    u.record("search", true);
    u.record("search", false);
    backend.failNext = true;
    await expect(u.flush()).resolves.toBeUndefined();
    expect(lines).toContain("usage_flush_failed");
    expect(u.rows()).toEqual([{ day: "2026-09-29", tool: "search", calls: 2, errors: 1 }]); // still in the state, not lost
    u.record("search", true);
    await u.flush(); // the next write carries everything
    expect(JSON.parse(backend.doc!).usage).toEqual({ "2026-09-29": { search: { calls: 3, errors: 1 } } });
    expect(u.rows()[0]!.calls).toBe(3);
  });

  it("start() flushes every 60 seconds, stop() ends it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new StateStore(memoryBackend());
    await store.load();
    const u = new UsageService(store);
    u.start();
    u.record("search", true);
    expect(store.state.usage).toEqual({});
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_MS);
    expect(store.state.usage["2026-09-29"]?.search).toEqual({ calls: 1, errors: 0 });
    u.stop();
    u.record("search", true);
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_MS * 3);
    expect(store.state.usage["2026-09-29"]?.search?.calls).toBe(1);
    expect(USAGE_FLUSH_MS).toBe(60_000);
  });

  it("record() never throws", async () => {
    const { store } = await localStore();
    const u = new UsageService(store, {
      now: () => {
        throw new Error("clock broke");
      },
    });
    expect(() => u.record("search", true)).not.toThrow();
  });
});

function memoryBackend(): StateBackend & { doc: string | null; saves: number; failNext: boolean } {
  return {
    doc: null as string | null,
    saves: 0,
    failNext: false,
    async load() {
      return this.doc === null ? null : (JSON.parse(this.doc) as unknown);
    },
    async save(d: unknown) {
      const j = JSON.stringify(d);
      if (this.failNext) {
        this.failNext = false;
        throw new Error("disk full");
      }
      this.doc = j;
      this.saves++;
    },
    async close() {},
  };
}

// ---- recording from the tool wrapper ---------------------------------------------------------------------------------------
async function mcp(base: string, token: string): Promise<Client> {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

describe("recording in the tool wrapper", () => {
  it("counts every tool call after it finishes: calls per tool, errors for failures and refused scopes", async () => {
    h = await makeHarness();
    h.gateway.readRange = () => Promise.reject(new GatewayError("SHEET_NOT_FOUND", "Sheet 'Payroll-SECRET' not found"));
    const rw = await h.pats.create(h.ownerId, h.connectionId, "rw", ["sheets.read", "sheets.write"]);
    const ro = await h.pats.create(h.ownerId, h.connectionId, "ro", ["sheets.read"]);
    const c = await mcp(h.publicUrl, rw.token);
    await c.callTool({ name: "list_spreadsheets", arguments: {} });
    await c.callTool({ name: "list_spreadsheets", arguments: {} });
    const bad = await c.callTool({ name: "read_range", arguments: { spreadsheet: "sales", range: "Payroll-SECRET!A1:B2" } });
    expect(bad.isError).toBe(true);
    await c.callTool({ name: "search", arguments: { spreadsheet: "sales", query: "SEARCH-SECRET" } });
    await c.close();
    const c2 = await mcp(h.publicUrl, ro.token);
    const denied = await c2.callTool({ name: "write_range", arguments: { spreadsheet: "sales", range: "S!A1", values: [[1]] } });
    expect(JSON.stringify(denied)).toContain("INSUFFICIENT_SCOPE");
    await c2.close();

    const today = new Date().toISOString().slice(0, 10);
    expect(h.usage.rows()).toEqual([
      { day: today, tool: "list_spreadsheets", calls: 2, errors: 0 },
      { day: today, tool: "read_range", calls: 1, errors: 1 },
      { day: today, tool: "search", calls: 1, errors: 0 },
      { day: today, tool: "write_range", calls: 1, errors: 1 },
    ]);
    await h.usage.flush();
    // only day, tool and two counters are ever stored: no ranges, queries, values, messages, users or connections
    const stored = JSON.stringify(h.store.state.usage);
    expect(JSON.parse(stored)).toEqual({
      [today]: { list_spreadsheets: { calls: 2, errors: 0 }, read_range: { calls: 1, errors: 1 }, search: { calls: 1, errors: 0 }, write_range: { calls: 1, errors: 1 } },
    });
    for (const secret of ["Payroll-SECRET", "SEARCH-SECRET", "not found", "sales", h.ownerId, h.connectionId]) expect(stored).not.toContain(secret);
  });

  it("a failing recorder never breaks the tool call", async () => {
    h = await makeHarness();
    const server = createMcpServer(h.registry.resolve, undefined, false, {
      record: () => {
        throw new Error("recorder exploded");
      },
    });
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> })._registeredTools.list_spreadsheets!;
    const extra = { authInfo: { token: "x", clientId: "c", scopes: ["sheets.read"], extra: { userId: h.ownerId, connectionId: h.connectionId } } };
    const r = await tool.handler({}, extra);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]!.text).spreadsheets).toHaveLength(2);
    const denied = await tool.handler({}, { authInfo: { ...extra.authInfo, scopes: [] } });
    expect(denied.isError).toBe(true);
  });

  it("a failing write of the usage counters does not affect calls either", async () => {
    h = await makeHarness();
    const rw = await h.pats.create(h.ownerId, h.connectionId, "rw", ["sheets.read"]);
    const c = await mcp(h.publicUrl, rw.token);
    expect((await c.callTool({ name: "list_spreadsheets", arguments: {} })).isError).toBeFalsy();
    const original = h.store.update.bind(h.store);
    h.store.update = () => Promise.reject(new Error("database is down"));
    await expect(h.usage.flush()).resolves.toBeUndefined();
    expect((await c.callTool({ name: "list_spreadsheets", arguments: {} })).isError).toBeFalsy();
    h.store.update = original;
    await c.close();
  });
});

// ---- the two views --------------------------------------------------------------------------------------------------------
describe("usage views", () => {
  it("/account/api/usage needs a session and shows day x tool counts", async () => {
    h = await makeHarness();
    expect((await fetch(`${h.publicUrl}/account/api/usage`)).status).toBe(401);
    h.usage.record("read_range", true);
    h.usage.record("read_range", false);
    const s = await accountLogin(h, h.username, h.password);
    const r = await fetch(`${h.publicUrl}/account/api/usage`, { headers: { cookie: s.cookie } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { usage: Array<Record<string, unknown>> };
    expect(j.usage).toEqual([{ day: new Date().toISOString().slice(0, 10), tool: "read_range", calls: 2, errors: 1 }]);
  });

  it("the page carries a plain day x tool table with the Vietnamese heading, and every element the script uses exists", async () => {
    h = await makeHarness();
    for (const url of [`${h.publicUrl}/account`]) {
      const html = await (await fetch(url)).text();
      expect(html).toContain("Lượt dùng 30 ngày");
      expect(html).toContain('id="usage-list"');
      expect(html).not.toMatch(/<svg|<canvas|<img /i); // plain tables, no charts
      const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
      const used = new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]!));
      for (const id of used) expect(html, id).toContain(`id="${id}"`);
    }
  });
});
