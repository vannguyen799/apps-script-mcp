import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/auth/accounts.js";
import { verifyPasswordHash } from "../src/auth/password.js";
import { resetOwnerPassword } from "../src/auth/accounts.js";
import { loadConfig } from "../src/config.js";
import { StateStore } from "../src/store/state-store.js";
import { FailureLimiter } from "../src/util/rate-limit.js";
import type { Harness } from "./helpers.js";
import { makeHarness } from "./helpers.js";

const dirs: string[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-boot-"));
  dirs.push(dir);
  const store = new StateStore(dir);
  await store.load();
  const accounts = new AccountService({ store, ipLimiter: new FailureLimiter(5, 60_000), userLimiter: new FailureLimiter(5, 60_000) });
  return { dir, store, accounts };
}

describe("owner bootstrap from ADMIN_USERNAME / ADMIN_PASSWORD (DESIGN.md 10.3)", () => {
  it("creates the owner when there is none: hashed password, nothing printed for an env password", async () => {
    const { store, accounts } = await fresh();
    expect(accounts.needsSetup()).toBe(true);
    const printed: string[] = [];
    const u = await accounts.bootstrapOwner("Boss.One", "a-long-enough-password", (l) => printed.push(l));
    expect(u).toMatchObject({ username: "boss.one", role: "owner" });
    expect(accounts.needsSetup()).toBe(false);
    expect(u!.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(JSON.stringify(store.state)).not.toContain("a-long-enough-password");
    expect(await verifyPasswordHash("a-long-enough-password", u!.passwordHash)).toBe(true);
    expect(printed).toEqual([]);
    await expect(accounts.login("boss.one", "a-long-enough-password", "1.1.1.1")).resolves.toMatchObject({ role: "owner" });
  });

  it("without ADMIN_PASSWORD it generates 20 [A-Za-z0-9] characters, prints them once, and stores only the hash", async () => {
    const { store, dir, accounts } = await fresh();
    const printed: string[] = [];
    const u = await accounts.bootstrapOwner("admin", undefined, (l) => printed.push(l));
    expect(printed).toHaveLength(1);
    const m = /^Admin login: admin \/ ([A-Za-z0-9]{20})  \(đổi mật khẩu trong \/account\)$/.exec(printed[0]!);
    expect(m).not.toBeNull();
    const pw = m![1]!;
    expect(await verifyPasswordHash(pw, u!.passwordHash)).toBe(true);
    expect(JSON.stringify(store.state)).not.toContain(pw);
    expect(await readFile(path.join(dir, "state.json"), "utf8")).not.toContain(pw);
    // a second start: an owner exists, nothing is printed, nothing changes
    const again = new StateStore(dir);
    await again.load();
    const accounts2 = new AccountService({ store: again, ipLimiter: new FailureLimiter(5, 60_000), userLimiter: new FailureLimiter(5, 60_000) });
    expect(await accounts2.bootstrapOwner("admin", undefined, (l) => printed.push(l))).toBeNull();
    expect(printed).toHaveLength(1);
    expect(await verifyPasswordHash(pw, again.state.users[u!.id]!.passwordHash)).toBe(true);
  });

  it("generated passwords differ between runs", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { accounts } = await fresh();
      await accounts.bootstrapOwner("admin", undefined, (l) => seen.add(l));
    }
    expect(seen.size).toBe(3);
  });

  it("creates the owner only once and never overwrites an existing password, whoever is named", async () => {
    const { store, accounts } = await fresh();
    const first = await accounts.bootstrapOwner("admin", "first-password-123");
    expect(await accounts.bootstrapOwner("admin", "second-password-456")).toBeNull();
    expect(await accounts.bootstrapOwner("someone-else", "third-password-789")).toBeNull();
    expect(Object.keys(store.state.users)).toEqual([first!.id]);
    expect(await verifyPasswordHash("first-password-123", store.state.users[first!.id]!.passwordHash)).toBe(true);
    expect(await verifyPasswordHash("second-password-456", store.state.users[first!.id]!.passwordHash)).toBe(false);
  });

  it("does not touch an owner that survives a restart", async () => {
    const { dir, accounts } = await fresh();
    const owner = (await accounts.bootstrapOwner("admin", "chosen-in-the-ui-1"))!;
    const again = new StateStore(dir);
    await again.load();
    const accounts2 = new AccountService({ store: again, ipLimiter: new FailureLimiter(5, 60_000), userLimiter: new FailureLimiter(5, 60_000) });
    expect(await accounts2.bootstrapOwner("admin", "env-password-12345")).toBeNull();
    expect(await verifyPasswordHash("chosen-in-the-ui-1", again.state.users[owner.id]!.passwordHash)).toBe(true);
  });

  it("rejects a short password (startup error) and creates nothing", async () => {
    const { store, accounts } = await fresh();
    await expect(accounts.bootstrapOwner("admin", "123456789")).rejects.toThrow(/at least 10/);
    expect(Object.keys(store.state.users)).toHaveLength(0);
    expect(accounts.needsSetup()).toBe(true);
    expect(await accounts.bootstrapOwner("admin", "1234567890")).toMatchObject({ username: "admin" }); // exactly 10 is fine
  });

  it("rejects an unusable username", async () => {
    const { accounts } = await fresh();
    for (const bad of ["ab", "A B", "x".repeat(33), "évil"]) await expect(accounts.bootstrapOwner(bad, "a-long-enough-password")).rejects.toThrow(/ADMIN_USERNAME/);
  });

  it("later starts ignore the variables entirely: a short password is no error once the owner exists", async () => {
    const { accounts } = await fresh();
    await accounts.bootstrapOwner("admin", "a-long-enough-password");
    expect(await accounts.bootstrapOwner("admin", "short")).toBeNull();
  });

  it("the bootstrapped owner can use /account and the admin UI", async () => {
    h = await makeHarness({ setup: false });
    await h.accounts.bootstrapOwner("boss", "a-long-enough-password");
    const acc = await fetch(`${h.publicUrl}/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "boss", password: "a-long-enough-password" }) });
    expect(acc.status).toBe(200);
    const adm = await fetch(`${h.adminUrl}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "boss", password: "a-long-enough-password" }) });
    expect(adm.status).toBe(200);
    const session = (await (await fetch(`${h.adminUrl}/api/session`, { headers: { cookie: (adm.headers.get("set-cookie") ?? "").split(";")[0]! } })).json()) as { authenticated: boolean };
    expect(session).toMatchObject({ authenticated: true });
  });
});

describe("reset-password CLI logic", () => {
  it("gives the owner a new random password and removes every session; needs an owner", async () => {
    const { dir, store, accounts } = await fresh();
    expect(await resetOwnerPassword(store)).toBeNull();
    const owner = (await accounts.bootstrapOwner("boss", "old-password-12345"))!;
    await accounts.createSession(owner.id);
    await accounts.createSession(owner.id);
    expect(Object.keys(store.state.sessions)).toHaveLength(2);
    const r = (await resetOwnerPassword(store))!;
    expect(r.username).toBe("boss");
    expect(r.password).toMatch(/^[A-Za-z0-9]{20}$/);
    // what the next start of the server sees, straight from the local file
    const reopened = new StateStore(dir);
    await reopened.load();
    expect(reopened.state.sessions).toEqual({});
    const hash = reopened.state.users[owner.id]!.passwordHash;
    expect(await verifyPasswordHash(r.password, hash)).toBe(true);
    expect(await verifyPasswordHash("old-password-12345", hash)).toBe(false);
  });
});

describe("config (the only place that reads the environment)", () => {
  it("ADMIN_USERNAME defaults to admin; ADMIN_PASSWORD is kept exactly as given (no trimming) and empty means unset", () => {
    expect(loadConfig({})).toMatchObject({ adminUsername: "admin", adminPassword: undefined, databaseUrl: undefined });
    expect(loadConfig({ ADMIN_USERNAME: "  boss  ", ADMIN_PASSWORD: "  pw with spaces  " })).toMatchObject({ adminUsername: "boss", adminPassword: "  pw with spaces  " });
    expect(loadConfig({ ADMIN_USERNAME: "", ADMIN_PASSWORD: "" })).toMatchObject({ adminUsername: "admin", adminPassword: undefined });
  });

  it("DATABASE_URL must be a postgres URL; empty means local files", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://u:p@db:5432/asmcp?sslmode=require" }).databaseUrl).toBe("postgres://u:p@db:5432/asmcp?sslmode=require");
    expect(loadConfig({ DATABASE_URL: "postgresql://u@db/asmcp" }).databaseUrl).toBe("postgresql://u@db/asmcp");
    expect(loadConfig({ DATABASE_URL: "  " }).databaseUrl).toBeUndefined();
    expect(() => loadConfig({ DATABASE_URL: "mysql://u@db/x" })).toThrow(/postgres/);
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow(/postgres/);
  });
});
