import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../src/log.js";
import type { StateBackend } from "../src/store/backend.js";
import { LocalStateBackend } from "../src/store/local-backend.js";
import { openStateStore } from "../src/store/open-store.js";
import { PostgresStateBackend } from "../src/store/postgres-backend.js";
import { STATE_VERSION, StateStore, emptyState } from "../src/store/state-store.js";

/** A backend held in memory that stores the serialised document, like a database row would. */
class MemoryBackend implements StateBackend {
  doc: string | null = null;
  saves = 0;
  closed = false;
  failNext = false;
  async load(): Promise<unknown | null> {
    return this.doc === null ? null : (JSON.parse(this.doc) as unknown);
  }
  async save(doc: unknown): Promise<void> {
    const json = JSON.stringify(doc);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.doc = json;
    this.saves++;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function capture() {
  const lines: Array<{ level: string; event: string; fields?: unknown }> = [];
  const log: Logger = {
    debug: () => {},
    info: (event, fields) => lines.push({ level: "info", event, fields }),
    warn: (event, fields) => lines.push({ level: "warn", event, fields }),
    error: (event, fields) => lines.push({ level: "error", event, fields }),
  };
  return { lines, log, events: () => lines.map((l) => l.event) };
}

const v1Doc = () => ({
  version: 1,
  instanceId: "0b7f2c1e-6a1d-4c7e-9f3a-2d5b8e4c1a90",
  admin: { passwordHash: "scrypt$1$1$1$c2FsdA==$a2V5", setupTokenHash: null },
  publicBaseUrl: "https://mcp.example.com",
  link: { url: "https://script.google.com/macros/s/V1LINK/exec", secret: "S".repeat(43), account: "old@example.com", pairedAt: 5 },
  oauth: { clients: {}, grants: { g1: { id: "g1", clientId: "c1", scopes: ["sheets.read"], createdAt: 1 } }, accessTokens: {}, refreshTokens: {} },
  pats: { hash1: { id: "p1", label: "laptop", scopes: ["sheets.read"], createdAt: 2, lastUsedAt: null, hint: "asmcp_pat_x" } },
});

describe("StateStore over a backend", () => {
  it("starts empty, persists a fresh v2 document, and writes every update through", async () => {
    const b = new MemoryBackend();
    const s = new StateStore(b);
    await s.load();
    expect(s.state.version).toBe(STATE_VERSION);
    expect(JSON.parse(b.doc!).version).toBe(2);
    await s.update((st) => {
      st.publicBaseUrl = "https://mcp.example.com";
    });
    expect(JSON.parse(b.doc!).publicBaseUrl).toBe("https://mcp.example.com");
    const again = new StateStore(b);
    await again.load();
    expect(again.state.publicBaseUrl).toBe("https://mcp.example.com");
    expect(again.state.instanceId).toBe(s.state.instanceId);
  });

  it("serialises writes: concurrent updates all land, in order, each write a snapshot", async () => {
    const b = new MemoryBackend();
    const s = new StateStore(b);
    await s.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.update((st) => {
          st.sessions[`h${i}`] = { userId: "u", createdAt: i, expiresAt: 9e15 };
        }),
      ),
    );
    expect(Object.keys(JSON.parse(b.doc!).sessions)).toHaveLength(20);
  });

  it("a failed write rejects the update and is logged without the reason text", async () => {
    const c = capture();
    const b = new MemoryBackend();
    const s = new StateStore(b, c.log);
    await s.load();
    b.failNext = true;
    await expect(
      s.update((st) => {
        st.publicBaseUrl = "https://x.example.com";
      }),
    ).rejects.toThrow("disk full");
    expect(c.lines.find((l) => l.event === "state_write_failed")?.fields).toEqual({ reason: "Error" });
    await s.update(() => {}); // the store keeps working
  });

  it("fills defaults for a v2 document that lacks collections, adds usage, and refuses a newer version", async () => {
    const b = new MemoryBackend();
    b.doc = JSON.stringify({ version: 2, instanceId: "abc", publicBaseUrl: null });
    const s = new StateStore(b);
    await s.load();
    expect(s.state.instanceId).toBe("abc");
    expect(s.state.oauth.grants).toEqual({});
    expect(s.state.usage).toEqual({});
    b.doc = JSON.stringify({ ...emptyState(), version: 3 });
    await expect(new StateStore(b).load()).rejects.toThrow(/version 3/);
  });

  it("close() flushes and closes the backend", async () => {
    const b = new MemoryBackend();
    const s = new StateStore(b);
    await s.load();
    await s.close();
    expect(b.closed).toBe(true);
  });
});

describe("one-time import of state.json into an empty database", () => {
  it("imports once, logs state_imported_from_file, and never writes to the file", async () => {
    const c = capture();
    const primary = new MemoryBackend();
    const file = new MemoryBackend();
    file.doc = JSON.stringify({ ...emptyState(), publicBaseUrl: "https://from-file.example.com" });
    const original = file.doc;
    const s = new StateStore(primary, c.log, { importFrom: file });
    await s.load();
    expect(s.state.publicBaseUrl).toBe("https://from-file.example.com");
    expect(JSON.parse(primary.doc!).publicBaseUrl).toBe("https://from-file.example.com");
    expect(c.events()).toContain("state_imported_from_file");
    expect(file.doc).toBe(original);
    expect(file.saves).toBe(0);

    // the database is now the source of truth: a changed file is ignored, nothing is imported twice
    file.doc = JSON.stringify({ ...emptyState(), publicBaseUrl: "https://changed-file.example.com" });
    const c2 = capture();
    const s2 = new StateStore(primary, c2.log, { importFrom: file });
    await s2.load();
    expect(s2.state.publicBaseUrl).toBe("https://from-file.example.com");
    expect(c2.events()).not.toContain("state_imported_from_file");
  });

  it("still migrates a v1 file on import (owner, connection, grants, PATs), leaving the file alone", async () => {
    const c = capture();
    const primary = new MemoryBackend();
    const file = new MemoryBackend();
    file.doc = JSON.stringify(v1Doc());
    const original = file.doc;
    const s = new StateStore(primary, c.log, { importFrom: file });
    await s.load();
    const st = s.state;
    expect(st.version).toBe(2);
    const owner = Object.values(st.users)[0]!;
    expect(owner).toMatchObject({ username: "admin", role: "owner" });
    const conn = Object.values(st.connections)[0]!;
    expect(conn).toMatchObject({ userId: owner.id, instanceId: v1Doc().instanceId, account: "old@example.com" });
    expect(st.oauth.grants.g1).toMatchObject({ userId: owner.id, connectionId: conn.id });
    expect(st.pats.hash1).toMatchObject({ userId: owner.id, connectionId: conn.id });
    expect(JSON.parse(primary.doc!).version).toBe(2);
    expect(file.doc).toBe(original);
    expect(c.lines.find((l) => l.event === "state_imported_from_file")?.fields).toEqual({ migrated: true });
    expect(c.events()).not.toContain("state_migrated"); // no .v1.bak: the file is not touched at all
  });

  it("starts empty when there is nothing to import, and does not import over an existing database", async () => {
    const primary = new MemoryBackend();
    const s = new StateStore(primary, undefined, { importFrom: new MemoryBackend() });
    await s.load();
    expect(Object.keys(s.state.users)).toHaveLength(0);

    const db = new MemoryBackend();
    db.doc = JSON.stringify({ ...emptyState(), publicBaseUrl: "https://db.example.com" });
    const file = new MemoryBackend();
    file.doc = JSON.stringify({ ...emptyState(), publicBaseUrl: "https://file.example.com" });
    const s2 = new StateStore(db, undefined, { importFrom: file });
    await s2.load();
    expect(s2.state.publicBaseUrl).toBe("https://db.example.com");
  });

  it("a damaged source aborts startup instead of starting empty", async () => {
    const file: StateBackend = { load: () => Promise.reject(new SyntaxError("bad json")), save: async () => {}, close: async () => {} };
    await expect(new StateStore(new MemoryBackend(), undefined, { importFrom: file }).load()).rejects.toThrow("bad json");
  });
});

describe("local file backend", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const mk = async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "asmcp-local-"));
    dirs.push(d);
    return d;
  };

  it("openStateStore without DATABASE_URL uses DATA_DIR/state.json at mode 0600", async () => {
    const dir = await mk();
    const s = await openStateStore({ dataDir: dir, databaseUrl: undefined }, capture().log);
    await s.load();
    expect(s.filePath).toBe(path.join(dir, "state.json"));
    expect((await stat(s.filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(s.filePath, "utf8")).version).toBe(2);
  });

  it("a v1 file is migrated with the untouched original kept as state.json.v1.bak", async () => {
    const dir = await mk();
    const raw = JSON.stringify(v1Doc());
    await writeFile(path.join(dir, "state.json"), raw);
    const s = new StateStore(dir);
    await s.load();
    expect(s.state.version).toBe(2);
    expect(await readFile(path.join(dir, "state.json.v1.bak"), "utf8")).toBe(raw);
    expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).version).toBe(2);
  });

  it("a corrupt state.json is a hard error", async () => {
    const dir = await mk();
    await writeFile(path.join(dir, "state.json"), "{not json");
    await expect(new StateStore(dir).load()).rejects.toThrow();
  });
});

// ---- PostgreSQL adapter: needs a real database. CI runs it against a postgres service; locally set TEST_DATABASE_URL. ----
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL adapter (TEST_DATABASE_URL)", () => {
  const backends: PostgresStateBackend[] = [];
  const dirs: string[] = [];
  const raw = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  afterAll(() => raw.end());
  afterEach(async () => {
    for (const b of backends.splice(0)) await b.close();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const fresh = async () => {
    await raw.query("DROP TABLE IF EXISTS asmcp_state");
    const b = await PostgresStateBackend.connect(TEST_DATABASE_URL!);
    backends.push(b);
    return b;
  };

  it("creates the table, loads null when empty, and round-trips a document", async () => {
    const b = await fresh();
    expect(await b.load()).toBeNull();
    await b.save({ a: 1, nested: { list: [1, 2, 3] } });
    expect(await b.load()).toEqual({ a: 1, nested: { list: [1, 2, 3] } });
  });

  it("save is an upsert on a single row", async () => {
    const b = await fresh();
    await b.save({ n: 1 });
    await b.save({ n: 2 });
    await b.save({ n: 3 });
    expect(await b.load()).toEqual({ n: 3 });
    const r = await raw.query("SELECT id, updated_at FROM asmcp_state");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(1);
    expect(r.rows[0].updated_at).toBeInstanceOf(Date);
    await expect(raw.query("INSERT INTO asmcp_state (id, doc, updated_at) VALUES (2, '{}', now())")).rejects.toThrow(); // id = 1 only
  });

  it("connect is idempotent (an existing table and its data are kept)", async () => {
    const b = await fresh();
    await b.save({ keep: "me" });
    const again = await PostgresStateBackend.connect(TEST_DATABASE_URL!);
    backends.push(again);
    expect(await again.load()).toEqual({ keep: "me" });
  });

  it("StateStore: imports state.json once into the empty table (v1 migrated), then the database wins", async () => {
    const b = await fresh();
    const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-pg-"));
    dirs.push(dir);
    const rawFile = JSON.stringify(v1Doc());
    await writeFile(path.join(dir, "state.json"), rawFile);
    const c = capture();
    const s = new StateStore(b, c.log, { importFrom: new LocalStateBackend(dir) });
    await s.load();
    expect(Object.values(s.state.users)[0]).toMatchObject({ username: "admin", role: "owner" });
    expect(c.events()).toContain("state_imported_from_file");
    expect(await readFile(path.join(dir, "state.json"), "utf8")).toBe(rawFile);
    await s.update((st) => {
      st.publicBaseUrl = "https://changed.example.com";
    });
    const s2 = new StateStore(b, capture().log, { importFrom: new LocalStateBackend(dir) });
    await s2.load();
    expect(s2.state.publicBaseUrl).toBe("https://changed.example.com");
  });
});
