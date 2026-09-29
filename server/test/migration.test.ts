import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/auth/accounts.js";
import { GsmcpOAuthProvider } from "../src/auth/oauth-provider.js";
import { hashPassword } from "../src/auth/password.js";
import { PatService, PAT_PREFIX } from "../src/auth/pat.js";
import { ConnectionRegistry } from "../src/connection/connection-registry.js";
import { StateStore, migrateV1, upgradeState } from "../src/store/state-store.js";
import { sha256Hex } from "../src/util/crypto.js";
import { FailureLimiter } from "../src/util/rate-limit.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-mig-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ACCESS = "v1-access-token-plain";
const REFRESH = "v1-refresh-token-plain";
const PAT = `${PAT_PREFIX}v1-pat-plain-value`;
const V1_INSTANCE = "0b7f2c1e-6a1d-4c7e-9f3a-2d5b8e4c1a90";
const LINK = { url: "https://script.google.com/macros/s/V1LINK/exec", secret: "S".repeat(43), account: "old.owner@example.com", pairedAt: 1_700_000_000_000 };

/** A realistic v1 state.json (DESIGN.md 7 before section 9). */
async function v1Fixture(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    version: 1,
    instanceId: V1_INSTANCE,
    admin: { passwordHash: await hashPassword("old-admin-password"), setupTokenHash: null },
    publicBaseUrl: "https://mcp.example.com",
    link: LINK,
    pending: { url: "https://script.google.com/macros/s/PENDING/exec", code: "ABCD2345", secret: "P".repeat(43), expiresAt: 1 },
    oauth: {
      clients: { c1: { client_id: "c1", redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" } },
      grants: { g1: { id: "g1", clientId: "c1", scopes: ["sheets.read", "sheets.write"], createdAt: 5 } },
      accessTokens: { [sha256Hex(ACCESS)]: { grantId: "g1", clientId: "c1", scopes: ["sheets.read", "sheets.write"], expiresAt: Date.now() + 3600_000 } },
      refreshTokens: { [sha256Hex(REFRESH)]: { grantId: "g1", clientId: "c1", expiresAt: Date.now() + 86_400_000 } },
    },
    pats: { [sha256Hex(PAT)]: { id: "p1", label: "laptop", scopes: ["sheets.read"], createdAt: 7, lastUsedAt: null, hint: "asmcp_pat_v1-p" } },
    ...over,
  };
}

async function loadFrom(state: Record<string, unknown>): Promise<{ store: StateStore; original: string }> {
  const original = JSON.stringify(state);
  await writeFile(path.join(dir, "state.json"), original);
  const store = new StateStore(dir);
  await store.load();
  return { store, original };
}

describe("state migration v1 -> v2 (DESIGN.md 9.5)", () => {
  it("turns the admin password into the owner user `admin`", async () => {
    const fixture = await v1Fixture();
    const { store } = await loadFrom(fixture);
    expect(store.state.version).toBe(2);
    const users = Object.values(store.state.users);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: "admin", role: "owner", passwordHash: (fixture.admin as { passwordHash: string }).passwordHash });
    // and the old password still logs in
    const accounts = new AccountService({ store, ipLimiter: new FailureLimiter(), userLimiter: new FailureLimiter() });
    expect(accounts.needsSetup()).toBe(false);
    expect((await accounts.login("admin", "old-admin-password", "1.1.1.1")).role).toBe("owner");
  });

  it("turns the single link into a connection owned by the owner, labelled with the account email, keeping the v1 instanceId", async () => {
    const { store } = await loadFrom(await v1Fixture());
    const owner = Object.values(store.state.users)[0]!;
    const conns = Object.values(store.state.connections);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      userId: owner.id,
      label: LINK.account,
      url: LINK.url,
      secret: LINK.secret,
      account: LINK.account,
      pairedAt: LINK.pairedAt,
      // the script recorded its pairing under this id, so the connection must keep using it
      instanceId: V1_INSTANCE,
      scriptId: null,
      lastError: null,
    });
    expect(owner.lastConnectionId).toBe(conns[0]!.id);
  });

  it("binds existing grants, tokens and PATs to that connection, and they keep verifying", async () => {
    const { store } = await loadFrom(await v1Fixture());
    const owner = Object.values(store.state.users)[0]!;
    const connectionId = Object.keys(store.state.connections)[0]!;
    expect(store.state.oauth.grants.g1).toMatchObject({ userId: owner.id, connectionId, clientId: "c1" });
    expect(Object.values(store.state.oauth.accessTokens)[0]).toMatchObject({ userId: owner.id, connectionId });
    expect(Object.values(store.state.oauth.refreshTokens)[0]).toMatchObject({ userId: owner.id, connectionId });
    expect(Object.values(store.state.pats)[0]).toMatchObject({ userId: owner.id, connectionId, label: "laptop" });
    expect(store.state.oauth.clients.c1).toBeDefined();

    const accounts = new AccountService({ store, ipLimiter: new FailureLimiter(), userLimiter: new FailureLimiter() });
    const pats = new PatService(store);
    const registry = new ConnectionRegistry({ store, instanceLabel: "t" });
    const provider = new GsmcpOAuthProvider({ store, accounts, connections: registry, pats, baseUrl: () => "https://mcp.example.com" });
    expect((await provider.verifyAccessToken(ACCESS)).extra).toMatchObject({ kind: "oauth", userId: owner.id, connectionId });
    expect((await provider.verifyAccessToken(PAT)).extra).toMatchObject({ kind: "pat", userId: owner.id, connectionId });
    expect(registry.resolve(connectionId, owner.id)).toBeDefined();
  });

  it("drops a pending single-link pairing and keeps base URL and OAuth clients", async () => {
    const { store } = await loadFrom(await v1Fixture());
    expect(JSON.stringify(store.state)).not.toContain("PENDING");
    expect(store.state.pendingConnections).toEqual({});
    expect(store.state.publicBaseUrl).toBe("https://mcp.example.com");
    expect(store.state.instanceId).toBe(V1_INSTANCE);
    expect(store.state).not.toHaveProperty("link");
    expect(store.state).not.toHaveProperty("pending");
  });

  it("rewrites the file as v2 (mode 0600), keeps a copy of the v1 file, and is idempotent", async () => {
    const { store, original } = await loadFrom(await v1Fixture());
    await store.flush();
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.link).toBeUndefined();
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    const bak = path.join(dir, "state.json.v1.bak");
    expect(await readFile(bak, "utf8")).toBe(original);
    expect((await stat(bak)).mode & 0o777).toBe(0o600);

    const again = new StateStore(dir);
    await again.load();
    expect(again.state).toEqual(store.state);
    expect(await readFile(bak, "utf8")).toBe(original); // not overwritten by the second load
  });

  it("v1 without a link: nothing to bind to, so grants, tokens and PATs are dropped; the owner still exists", async () => {
    const { store } = await loadFrom(await v1Fixture({ link: null }));
    expect(Object.values(store.state.users)).toHaveLength(1);
    expect(store.state.connections).toEqual({});
    expect(store.state.oauth.grants).toEqual({});
    expect(store.state.oauth.accessTokens).toEqual({});
    expect(store.state.oauth.refreshTokens).toEqual({});
    expect(store.state.pats).toEqual({});
  });

  it("v1 that never finished setup: no users, and the setup token hash survives", async () => {
    const { store } = await loadFrom(
      await v1Fixture({ admin: { passwordHash: null, setupTokenHash: "a".repeat(64) }, link: null, pending: null, oauth: {}, pats: {} }),
    );
    expect(store.state.users).toEqual({});
    expect(store.state.admin.setupTokenHash).toBe("a".repeat(64));
    const accounts = new AccountService({ store, ipLimiter: new FailureLimiter(), userLimiter: new FailureLimiter() });
    expect(accounts.needsSetup()).toBe(true);
  });

  it("is a pure function, and a file without a version is treated as v1", async () => {
    const fixture = await v1Fixture();
    const before = JSON.stringify(fixture);
    const a = migrateV1(fixture, 42);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(Object.values(a.users)[0]!.createdAt).toBe(42);
    const { version: _v, ...noVersion } = fixture;
    expect(upgradeState(noVersion).migrated).toBe(true);
  });

  it("refuses a state file from a newer version", () => {
    expect(() => upgradeState({ version: 3 })).toThrow(/version 3/);
    expect(() => upgradeState([])).toThrow();
  });

  it("a fresh install starts at v2 with no migration and no backup", async () => {
    const store = new StateStore(dir);
    await store.load();
    expect(store.state.version).toBe(2);
    const fs = await import("node:fs/promises");
    expect(await fs.readdir(dir)).toEqual(["state.json"]);
  });
});
