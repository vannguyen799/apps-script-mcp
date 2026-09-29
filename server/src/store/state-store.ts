import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";

export interface AppsScriptLink {
  url: string;
  secret: string;
  account: string;
  pairedAt: number;
}

export interface PendingPairing {
  url: string;
  /** Normalised code (no dash). */
  code: string;
  secret: string;
  expiresAt: number;
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
  scopes: string[];
  createdAt: number;
}

export interface StoredAccessToken {
  grantId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

export interface StoredRefreshToken {
  grantId: string;
  clientId: string;
  expiresAt: number;
  /** Set once the token has been exchanged; presenting it again revokes the whole grant. */
  rotated?: boolean;
}

export interface StoredPat {
  id: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  /** First characters of the token, for recognition in the UI. */
  hint: string;
}

export interface PersistedState {
  version: 1;
  instanceId: string;
  admin: { passwordHash: string | null; setupTokenHash: string | null };
  publicBaseUrl: string | null;
  link: AppsScriptLink | null;
  pending: PendingPairing | null;
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
    version: 1,
    instanceId: randomUUID(),
    admin: { passwordHash: null, setupTokenHash: null },
    publicBaseUrl: null,
    link: null,
    pending: null,
    oauth: { clients: {}, grants: {}, accessTokens: {}, refreshTokens: {} },
    pats: {},
  };
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
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const base = emptyState();
    this.data = {
      ...base,
      ...parsed,
      version: 1,
      admin: { ...base.admin, ...(parsed.admin ?? {}) },
      oauth: { ...base.oauth, ...(parsed.oauth ?? {}) },
      pats: parsed.pats ?? {},
      instanceId: parsed.instanceId ?? base.instanceId,
    } as PersistedState;
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
