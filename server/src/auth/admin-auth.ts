import { randomB64Url } from "../util/crypto.js";

export interface AdminSession {
  id: string;
  csrf: string;
  userId: string;
  lastSeen: number;
}

export interface AdminAuthOptions {
  now?: () => number;
  sessionIdleMs?: number;
}

/** In-memory sessions of the owner-only admin UI (DESIGN.md 3.1): 12 h idle expiry. Credentials live in AccountService. */
export class AdminAuth {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(opts: AdminAuthOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.sessionIdleMs ?? 12 * 3600_000;
  }

  createSession(userId: string): AdminSession {
    const s: AdminSession = { id: randomB64Url(32), csrf: randomB64Url(32), userId, lastSeen: this.now() };
    this.sessions.set(s.id, s);
    return s;
  }

  getSession(id: string | undefined): AdminSession | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const t = this.now();
    if (t - s.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeen = t;
    return s;
  }

  destroySession(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  destroyUserSessions(userId: string): void {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }
}
