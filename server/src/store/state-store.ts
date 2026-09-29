import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";

export const STATE_VERSION = 2;

export type UserRole = "owner" | "member";

export interface StoredUser {
  id: string;
  /** Lowercase, ^[a-z0-9._-]{3,32}$ */
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
  /** Connection last approved on the OAuth consent page; preselected next time. */
  lastConnectionId?: string | null;
}

/** Keyed by SHA-256 hex of the invite token; the token itself is never stored. */
export interface StoredInvite {
  id: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

/** Keyed by SHA-256 hex of the cookie value. */
export interface StoredSession {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoredConnection {
  id: string;
  userId: string;
  label: string;
  url: string;
  /** Fresh UUID per connection (one script may pair with several servers and vice versa). */
  instanceId: string;
  secret: string;
  account: string;
  /** Stable id of the Apps Script project; null for a connection paired with a script that does not report it. */
  scriptId: string | null;
  pairedAt: number;
  lastOkAt: number | null;
  lastError: string | null;
  evalEnabled: boolean | null;
}

export interface PendingConnection {
  id: string;
  userId: string;
  instanceId: string;
  secret: string;
  setupToken: string;
  expiresAt: number;
  /** Set once the user pasted the web app URL. */
  url?: string;
  /** "setup" = personalised Code.gs (no code); "code" = an already-installed script and an 8-char code. */
  mode?: "setup" | "code";
  /** Normalised code (no dash), mode "code" only. */
  code?: string;
  codeExpiresAt?: number;
}

export interface StoredClient {
  client_id: string;
  client_id_issued_at?: number;
  redirect_uris: string[];
  client_name?: string;
  [k: string]: unknown;
}

export interface StoredGrant {
  id: string;
  clientId: string;
  userId: string;
  connectionId: string;
  scopes: string[];
  createdAt: number;
}

export interface StoredAccessToken {
  grantId: string;
  clientId: string;
  userId: string;
  connectionId: string;
  scopes: string[];
  expiresAt: number;
}

export interface StoredRefreshToken {
  grantId: string;
  clientId: string;
  userId: string;
  connectionId: string;
  expiresAt: number;
  /** Set once the token has been exchanged; presenting it again revokes the whole grant. */
  rotated?: boolean;
}

export interface StoredPat {
  id: string;
  userId: string;
  connectionId: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  /** First characters of the token, for recognition in the UI. */
  hint: string;
}

export interface PersistedState {
  version: 2;
  instanceId: string;
  admin: { setupTokenHash: string | null };
  publicBaseUrl: string | null;
  users: Record<string, StoredUser>;
  invites: Record<string, StoredInvite>;
  sessions: Record<string, StoredSession>;
  connections: Record<string, StoredConnection>;
  pendingConnections: Record<string, PendingConnection>;
  oauth: {
    clients: Record<string, StoredClient>;
    grants: Record<string, StoredGrant>;
    /** keyed by SHA-256 hex of the token */
    accessTokens: Record<string, StoredAccessToken>;
    refreshTokens: Record<string, StoredRefreshToken>;
  };
  /** keyed by SHA-256 hex of the token */
  pats: Record<string, StoredPat>;
}

export function emptyState(): PersistedState {
  return {
    version: 2,
    instanceId: randomUUID(),
    admin: { setupTokenHash: null },
    publicBaseUrl: null,
    users: {},
    invites: {},
    sessions: {},
    connections: {},
    pendingConnections: {},
    oauth: { clients: {}, grants: {}, accessTokens: {}, refreshTokens: {} },
    pats: {},
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * DESIGN.md 9.5. v1 -> v2:
 * - the admin password becomes the owner user `admin`;
 * - the single link becomes a connection owned by the owner (label = account email). It keeps the v1 instanceId,
 *   because the script side has its pairing recorded under that id;
 * - grants, tokens and PATs are bound to that connection (with no link there is nothing to bind to, so they are dropped);
 * - a pending single-link pairing is dropped.
 * Pure: no I/O.
 */
export function migrateV1(v1: Obj, now: number = Date.now()): PersistedState {
  const base = emptyState();
  const admin = isObj(v1.admin) ? v1.admin : {};
  const oauth = isObj(v1.oauth) ? v1.oauth : {};
  const out: PersistedState = {
    ...base,
    instanceId: typeof v1.instanceId === "string" ? v1.instanceId : base.instanceId,
    admin: { setupTokenHash: typeof admin.setupTokenHash === "string" ? admin.setupTokenHash : null },
    publicBaseUrl: typeof v1.publicBaseUrl === "string" ? v1.publicBaseUrl : null,
    oauth: { ...base.oauth, clients: (isObj(oauth.clients) ? oauth.clients : {}) as Record<string, StoredClient> },
  };

  let ownerId: string | null = null;
  if (typeof admin.passwordHash === "string") {
    ownerId = randomUUID();
    out.users[ownerId] = { id: ownerId, username: "admin", passwordHash: admin.passwordHash, role: "owner", createdAt: now, lastConnectionId: null };
    out.admin.setupTokenHash = null;
  }

  const link = isObj(v1.link) ? v1.link : null;
  let connectionId: string | null = null;
  if (ownerId && link && typeof link.url === "string" && typeof link.secret === "string") {
    connectionId = randomUUID();
    const account = typeof link.account === "string" ? link.account : "";
    out.connections[connectionId] = {
      id: connectionId,
      userId: ownerId,
      label: account || "Apps Script",
      url: link.url,
      instanceId: out.instanceId,
      secret: link.secret,
      account,
      scriptId: null,
      pairedAt: typeof link.pairedAt === "number" ? link.pairedAt : now,
      lastOkAt: null,
      lastError: null,
      evalEnabled: null,
    };
    out.users[ownerId]!.lastConnectionId = connectionId;
  }

  if (ownerId && connectionId) {
    const bind = { userId: ownerId, connectionId };
    for (const [id, g] of Object.entries((isObj(oauth.grants) ? oauth.grants : {}) as Record<string, StoredGrant>)) out.oauth.grants[id] = { ...g, ...bind };
    for (const [h, a] of Object.entries((isObj(oauth.accessTokens) ? oauth.accessTokens : {}) as Record<string, StoredAccessToken>)) out.oauth.accessTokens[h] = { ...a, ...bind };
    for (const [h, r] of Object.entries((isObj(oauth.refreshTokens) ? oauth.refreshTokens : {}) as Record<string, StoredRefreshToken>)) out.oauth.refreshTokens[h] = { ...r, ...bind };
    for (const [h, p] of Object.entries((isObj(v1.pats) ? v1.pats : {}) as Record<string, StoredPat>)) out.pats[h] = { ...p, ...bind };
  }
  return out;
}

/** Fills defaults for any missing collection of a v2 file (forward-tolerant), rejects a newer version. */
function normalizeV2(parsed: Obj): PersistedState {
  const base = emptyState();
  const oauth = isObj(parsed.oauth) ? parsed.oauth : {};
  const admin = isObj(parsed.admin) ? parsed.admin : {};
  return {
    ...base,
    ...(parsed as Partial<PersistedState>),
    version: 2,
    instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : base.instanceId,
    admin: { setupTokenHash: typeof admin.setupTokenHash === "string" ? admin.setupTokenHash : null },
    users: (parsed.users ?? {}) as PersistedState["users"],
    invites: (parsed.invites ?? {}) as PersistedState["invites"],
    sessions: (parsed.sessions ?? {}) as PersistedState["sessions"],
    connections: (parsed.connections ?? {}) as PersistedState["connections"],
    pendingConnections: (parsed.pendingConnections ?? {}) as PersistedState["pendingConnections"],
    oauth: { ...base.oauth, ...(oauth as Partial<PersistedState["oauth"]>) },
    pats: (parsed.pats ?? {}) as PersistedState["pats"],
  };
}

export function upgradeState(parsed: unknown, now: number = Date.now()): { state: PersistedState; migrated: boolean } {
  if (!isObj(parsed)) throw new Error("state.json is not a JSON object");
  const v = parsed.version;
  if (v === undefined || v === 1) return { state: migrateV1(parsed, now), migrated: true };
  if (v === STATE_VERSION) return { state: normalizeV2(parsed), migrated: false };
  throw new Error(`state.json has version ${String(v)}, which this server does not understand`);
}

/**
 * JSON-file state with atomic (tmp + rename) writes at mode 0600.
 * `update` mutates the in-memory state synchronously, then queues a serialized write.
 */
export class StateStore {
  private data: PersistedState = emptyState();
  private chain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(
    dir: string,
    private readonly log: Logger = nullLogger,
  ) {
    this.file = path.join(dir, "state.json");
  }

  get state(): PersistedState {
    return this.data;
  }

  get filePath(): string {
    return this.file;
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let raw: string | undefined;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (raw === undefined) {
      this.data = emptyState();
      await this.flush();
      return;
    }
    // A corrupt file is a hard error: silently resetting would drop credentials.
    const { state, migrated } = upgradeState(JSON.parse(raw));
    this.data = state;
    if (migrated) {
      // Keep the untouched v1 file next to the new one; the migration is one-way.
      const backup = `${this.file}.v1.bak`;
      await copyFile(this.file, backup);
      await chmod(backup, 0o600);
      await this.flush();
      this.log.info("state_migrated", { from: 1, to: STATE_VERSION });
    }
  }

  async update(mutator: (s: PersistedState) => void): Promise<void> {
    mutator(this.data); // synchronous: callers rely on check-then-mutate being atomic
    await this.flush();
  }

  flush(): Promise<void> {
    const run = this.chain.then(() => this.writeOnce());
    this.chain = run.catch((e) => {
      this.log.error("state_write_failed", { reason: e instanceof Error ? e.name : "unknown" });
    });
    return run;
  }

  private async writeOnce(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data);
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(json, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
}
