import { randomUUID } from "node:crypto";
import { randomB64Url, sha256Hex } from "../util/crypto.js";
import type { StateStore, StoredPat } from "../store/state-store.js";
import { isSupportedScope } from "./scopes.js";

export const PAT_PREFIX = "asmcp_pat_";
const LAST_USED_PERSIST_MS = 60_000;

export interface PatView {
  id: string;
  userId: string;
  connectionId: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  hint: string;
}

/** Personal access tokens: shown once, persisted only as SHA-256 hashes. */
export class PatService {
  private lastPersist = 0;

  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** The PAT is bound to `{userId, connectionId}`; the connection must be the user's own (DESIGN.md 9.4). */
  async create(userId: string, connectionId: string, label: string, scopes: string[]): Promise<{ token: string; pat: PatView }> {
    if (this.store.state.connections[connectionId]?.userId !== userId) throw new Error("Kết nối Apps Script không hợp lệ.");
    const clean = typeof label === "string" ? label.trim().slice(0, 64) : "";
    if (!clean) throw new Error("Label is required.");
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string" && isSupportedScope(s))) {
      throw new Error("Scopes must be a non-empty subset of sheets.read, sheets.write, script.eval.");
    }
    const token = PAT_PREFIX + randomB64Url(32);
    const rec: StoredPat = {
      id: randomUUID(),
      userId,
      connectionId,
      label: clean,
      scopes: [...new Set(scopes)],
      createdAt: this.now(),
      lastUsedAt: null,
      hint: token.slice(0, PAT_PREFIX.length + 4),
    };
    await this.store.update((s) => {
      s.pats[sha256Hex(token)] = rec;
    });
    return { token, pat: rec };
  }

  /** All PATs when `userId` is omitted (all of them), else only that user's. */
  list(userId?: string): PatView[] {
    return Object.values(this.store.state.pats)
      .filter((p) => userId === undefined || p.userId === userId)
      .map((p) => ({ id: p.id, userId: p.userId, connectionId: p.connectionId, label: p.label, scopes: p.scopes, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, hint: p.hint }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** `userId` limits revocation to that user's own PATs; omit it to revoke any. */
  async revoke(id: string, userId?: string): Promise<boolean> {
    let found = false;
    await this.store.update((s) => {
      for (const [h, p] of Object.entries(s.pats)) {
        if (p.id === id && (userId === undefined || p.userId === userId)) {
          delete s.pats[h];
          found = true;
        }
      }
    });
    return found;
  }

  /** Returns the PAT record for a presented token, tracking lastUsedAt (persisted at most once a minute). */
  verify(token: string): StoredPat | undefined {
    if (!token.startsWith(PAT_PREFIX)) return undefined;
    const rec = this.store.state.pats[sha256Hex(token)];
    if (!rec) return undefined;
    const t = this.now();
    rec.lastUsedAt = t;
    if (t - this.lastPersist > LAST_USED_PERSIST_MS) {
      this.lastPersist = t;
      void this.store.flush().catch(() => {});
    }
    return rec;
  }
}
