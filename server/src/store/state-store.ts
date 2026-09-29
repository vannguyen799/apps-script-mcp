import { randomUUID } from "node:crypto";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { StateBackend } from "./backend.js";
import { LocalStateBackend } from "./local-backend.js";

export const STATE_VERSION = 2;

/** The product has a single account, the owner (older files may still hold members; they are dropped on load). */
export type UserRole = "owner";

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

/** Tool calls per UTC day and tool (DESIGN.md 10.2): `usage[day][tool]`. Kept for 30 days. */
export type UsageState = Record<string, Record<string, { calls: number; errors: number }>>;

export interface PersistedState {
  version: 2;
  instanceId: string;
  publicBaseUrl: string | null;
  users: Record<string, StoredUser>;
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
  usage: UsageState;
}

export function emptyState(): PersistedState {
  return {
    version: 2,
    instanceId: randomUUID(),
    publicBaseUrl: null,
    users: {},
    sessions: {},
    connections: {},
    pendingConnections: {},
    oauth: { clients: {}, grants: {}, accessTokens: {}, refreshTokens: {} },
    pats: {},
    usage: {},
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
    publicBaseUrl: typeof v1.publicBaseUrl === "string" ? v1.publicBaseUrl : null,
    oauth: { ...base.oauth, clients: (isObj(oauth.clients) ? oauth.clients : {}) as Record<string, StoredClient> },
  };

  let ownerId: string | null = null;
  if (typeof admin.passwordHash === "string") {
    ownerId = randomUUID();
    out.users[ownerId] = { id: ownerId, username: "admin", passwordHash: admin.passwordHash, role: "owner", createdAt: now, lastConnectionId: null };
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
  const out: PersistedState = {
    ...base,
    ...(parsed as Partial<PersistedState>),
    version: 2,
    instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : base.instanceId,
    users: (parsed.users ?? {}) as PersistedState["users"],
    sessions: (parsed.sessions ?? {}) as PersistedState["sessions"],
    connections: (parsed.connections ?? {}) as PersistedState["connections"],
    pendingConnections: (parsed.pendingConnections ?? {}) as PersistedState["pendingConnections"],
    oauth: { ...base.oauth, ...(oauth as Partial<PersistedState["oauth"]>) },
    pats: (parsed.pats ?? {}) as PersistedState["pats"],
    usage: (isObj(parsed.usage) ? parsed.usage : {}) as UsageState,
  };
  delete (out as { invites?: unknown }).invites; // invites no longer exist
  delete (out as { admin?: unknown }).admin; // the setup-token hash no longer exists
  return out;
}

/**
 * Single-owner product: removes every user that is not the owner, with everything of theirs (sessions, connections, pending
 * connections, grants, tokens and PATs). Returns how many users were removed.
 */
export function pruneToOwner(s: PersistedState): number {
  const gone = new Set(Object.values(s.users).filter((u) => (u.role as string) !== "owner").map((u) => u.id));
  if (gone.size === 0) return 0;
  for (const id of gone) delete s.users[id];
  for (const [h, v] of Object.entries(s.sessions)) if (gone.has(v.userId)) delete s.sessions[h];
  for (const [id, c] of Object.entries(s.connections)) if (gone.has(c.userId)) delete s.connections[id];
  for (const [id, p] of Object.entries(s.pendingConnections)) if (gone.has(p.userId)) delete s.pendingConnections[id];
  for (const [id, g] of Object.entries(s.oauth.grants)) if (gone.has(g.userId)) delete s.oauth.grants[id];
  for (const [h, a] of Object.entries(s.oauth.accessTokens)) if (gone.has(a.userId)) delete s.oauth.accessTokens[h];
  for (const [h, r] of Object.entries(s.oauth.refreshTokens)) if (gone.has(r.userId)) delete s.oauth.refreshTokens[h];
  for (const [h, p] of Object.entries(s.pats)) if (gone.has(p.userId)) delete s.pats[h];
  return gone.size;
}

export function upgradeState(parsed: unknown, now: number = Date.now()): { state: PersistedState; migrated: boolean } {
  if (!isObj(parsed)) throw new Error("state.json is not a JSON object");
  const v = parsed.version;
  if (v === undefined || v === 1) return { state: migrateV1(parsed, now), migrated: true };
  if (v === STATE_VERSION) return { state: normalizeV2(parsed), migrated: false };
  throw new Error(`state.json has version ${String(v)}, which this server does not understand`);
}

export interface StateStoreOptions {
  /** Read once when the primary backend is empty (first start on PostgreSQL): the old DATA_DIR/state.json. Never written. */
  importFrom?: StateBackend;
}

/**
 * The state document in memory plus a serialized write-through to a StateBackend (DESIGN.md 10.1). `new StateStore(dir)` keeps
 * the local atomic JSON file (mode 0600). `update` mutates the in-memory state synchronously, then queues the write.
 */
export class StateStore {
  private data: PersistedState = emptyState();
  private chain: Promise<void> = Promise.resolve();
  private readonly backend: StateBackend;

  constructor(
    target: string | StateBackend,
    private readonly log: Logger = nullLogger,
    private readonly opts: StateStoreOptions = {},
  ) {
    this.backend = typeof target === "string" ? new LocalStateBackend(target) : target;
  }

  get state(): PersistedState {
    return this.data;
  }

  /** Path of state.json for the local backend, "" otherwise. */
  get filePath(): string {
    return this.backend instanceof LocalStateBackend ? this.backend.filePath : "";
  }

  async load(): Promise<void> {
    let raw = await this.backend.load();
    let imported = false;
    if (raw === null && this.opts.importFrom) {
      raw = await this.opts.importFrom.load();
      imported = raw !== null;
    }
    if (raw === null) {
      this.data = emptyState();
      await this.flush();
      return;
    }
    const { state, migrated } = upgradeState(raw);
    const hadStaleKeys = isObj(raw) && (raw.invites !== undefined || (raw.version === STATE_VERSION && raw.admin !== undefined)); // stale keys to drop
    const removed = pruneToOwner(state);
    this.data = state;
    if (migrated && !imported) {
      // Keep the untouched v1 file next to the new one; the migration is one-way.
      await this.backend.backupOriginal?.(".v1.bak");
      this.log.info("state_migrated", { from: 1, to: STATE_VERSION });
    }
    if (imported) this.log.info("state_imported_from_file", { migrated });
    if (removed > 0) this.log.info("users_pruned", { count: removed });
    if (imported || migrated || removed > 0 || hadStaleKeys) await this.flush();
  }

  async update(mutator: (s: PersistedState) => void): Promise<void> {
    mutator(this.data); // synchronous: callers rely on check-then-mutate being atomic
    await this.flush();
  }

  flush(): Promise<void> {
    const run = this.chain.then(() => this.backend.save(this.data));
    this.chain = run.catch((e) => {
      this.log.error("state_write_failed", { reason: e instanceof Error ? e.name : "unknown" });
    });
    return run;
  }

  /** Flushes the last write and releases the backend (database connections). */
  async close(): Promise<void> {
    await this.flush().catch(() => {});
    await this.backend.close();
  }
}
