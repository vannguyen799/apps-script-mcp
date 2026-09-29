import { createHmac, randomUUID } from "node:crypto";
import type { PersistedState, StateStore, StoredUser, UserRole } from "../store/state-store.js";
import { randomB64Url, safeEqualStr, sha256Hex } from "../util/crypto.js";
import type { FailureLimiter } from "../util/rate-limit.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, normalizeUsername, verifyAgainstDummy, verifyPasswordHash } from "./password.js";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const INVITE_TTL_MS = 7 * 24 * 3600_000;
const MAX_SESSIONS_PER_USER = 50;

export type AccountErrorCode =
  | "BAD_SETUP_TOKEN"
  | "ALREADY_SETUP"
  | "WEAK_PASSWORD"
  | "BAD_USERNAME"
  | "USERNAME_TAKEN"
  | "BAD_INVITE"
  | "BAD_CREDENTIALS"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "FORBIDDEN";

export class AccountError extends Error {
  constructor(
    public readonly code: AccountErrorCode,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface UserView {
  id: string;
  username: string;
  role: UserRole;
  createdAt: number;
}

export interface InviteView {
  id: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
}

export interface PublicSession {
  user: StoredUser;
  csrf: string;
  /** Raw cookie value, only ever held by the caller that presented it. */
  id: string;
}

export interface AccountServiceDeps {
  store: StateStore;
  /** 5 failures / 15 min per client IP. */
  ipLimiter: FailureLimiter;
  /** 5 failures / 15 min per username. */
  userLimiter: FailureLimiter;
  now?: () => number;
}

const view = (u: StoredUser): UserView => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt });

/** Per-session CSRF token: derived from the cookie value, so nothing extra is stored and it cannot be guessed without the cookie. */
export function csrfForSession(sessionId: string): string {
  return createHmac("sha256", sessionId).update("asmcp-csrf-v1").digest("base64url");
}

function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError("WEAK_PASSWORD", `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new AccountError("WEAK_PASSWORD", "Mật khẩu quá dài.");
}

function checkUsername(username: unknown): string {
  const u = normalizeUsername(username);
  if (!u) throw new AccountError("BAD_USERNAME", "Tên đăng nhập gồm 3-32 ký tự: chữ thường, số, dấu chấm, gạch dưới hoặc gạch ngang.");
  return u;
}

/** Users, first-run owner setup, invites, public sessions and login (DESIGN.md 9.1). */
export class AccountService {
  private readonly store: StateStore;
  private readonly now: () => number;

  constructor(private readonly deps: AccountServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
  }

  // ---- users ------------------------------------------------------------
  needsSetup(): boolean {
    return !Object.values(this.store.state.users).some((u) => u.role === "owner");
  }

  getUser(id: string): StoredUser | undefined {
    return this.store.state.users[id];
  }

  findByUsername(username: string): StoredUser | undefined {
    const n = normalizeUsername(username);
    return n ? Object.values(this.store.state.users).find((u) => u.username === n) : undefined;
  }

  listUsers(): UserView[] {
    return Object.values(this.store.state.users)
      .map(view)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---- first-run setup ---------------------------------------------------
  /**
   * When no owner exists, mints a fresh one-time setup token, persists only its hash and returns the plaintext for
   * the caller to print once. Called on every start while unconfigured.
   */
  async ensureSetupToken(): Promise<string | null> {
    if (!this.needsSetup()) return null;
    const token = randomB64Url(24);
    await this.store.update((s) => {
      s.admin.setupTokenHash = sha256Hex(token);
    });
    return token;
  }

  async completeSetup(setupToken: string, username: string, password: string): Promise<StoredUser> {
    if (!this.needsSetup()) throw new AccountError("ALREADY_SETUP", "Đã thiết lập chủ sở hữu.");
    const hash = this.store.state.admin.setupTokenHash;
    if (typeof setupToken !== "string" || !hash || !safeEqualStr(sha256Hex(setupToken.trim()), hash)) {
      throw new AccountError("BAD_SETUP_TOKEN", "Setup token không hợp lệ.");
    }
    const name = checkUsername(username);
    checkPassword(password);
    const passwordHash = await hashPassword(password);
    const user: StoredUser = { id: randomUUID(), username: name, passwordHash, role: "owner", createdAt: this.now(), lastConnectionId: null };
    await this.store.update((s) => {
      if (Object.values(s.users).some((u) => u.role === "owner")) throw new AccountError("ALREADY_SETUP", "Đã thiết lập chủ sở hữu.");
      s.users[user.id] = user;
      s.admin.setupTokenHash = null;
    });
    return user;
  }

  // ---- login -------------------------------------------------------------
  /**
   * Both limiters are consulted before any password work. An unknown user and a wrong password give the same error,
   * and an unknown user still pays a full scrypt (dummy hash). With `requireRole`, a valid member trying the owner-only
   * admin UI gets the same generic failure.
   */
  async login(username: unknown, password: unknown, ip: string, opts: { requireRole?: UserRole } = {}): Promise<StoredUser> {
    const name = typeof username === "string" ? username.trim().toLowerCase().slice(0, 64) : "";
    const ipKey = `ip:${ip}`;
    const userKey = `user:${name}`;
    const wait = Math.max(this.deps.ipLimiter.blockedFor(ipKey), this.deps.userLimiter.blockedFor(userKey));
    if (wait > 0) throw new AccountError("RATE_LIMITED", "Thử sai quá nhiều lần. Hãy thử lại sau.", wait);

    const user = normalizeUsername(name) ? this.findByUsername(name) : undefined;
    const pw = typeof password === "string" ? password : "";
    const ok = user ? await verifyPasswordHash(pw, user.passwordHash) : await verifyAgainstDummy(pw);
    if (!user || !ok || (opts.requireRole && user.role !== opts.requireRole)) {
      this.deps.ipLimiter.recordFailure(ipKey);
      this.deps.userLimiter.recordFailure(userKey);
      throw new AccountError("BAD_CREDENTIALS", "Tên đăng nhập hoặc mật khẩu không đúng.");
    }
    this.deps.userLimiter.reset(userKey);
    return user;
  }

  // ---- public sessions ---------------------------------------------------
  /** Returns the raw cookie value; only its hash is persisted. */
  async createSession(userId: string): Promise<{ id: string; csrf: string; expiresAt: number }> {
    const id = randomB64Url(32);
    const t = this.now();
    const expiresAt = t + SESSION_TTL_MS;
    await this.store.update((s) => {
      this.pruneSessions(s, t);
      const mine = Object.entries(s.sessions)
        .filter(([, v]) => v.userId === userId)
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [h] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER + 1))) delete s.sessions[h];
      s.sessions[sha256Hex(id)] = { userId, createdAt: t, expiresAt };
    });
    return { id, csrf: csrfForSession(id), expiresAt };
  }

  getSession(id: string | undefined): PublicSession | undefined {
    if (!id || id.length > 200) return undefined;
    const rec = this.store.state.sessions[sha256Hex(id)];
    if (!rec || rec.expiresAt <= this.now()) return undefined;
    const user = this.store.state.users[rec.userId];
    if (!user) return undefined;
    return { user, csrf: csrfForSession(id), id };
  }

  async destroySession(id: string | undefined): Promise<void> {
    if (!id) return;
    await this.store.update((s) => {
      delete s.sessions[sha256Hex(id)];
    });
  }

  async destroyUserSessions(userId: string): Promise<void> {
    await this.store.update((s) => {
      for (const [h, v] of Object.entries(s.sessions)) if (v.userId === userId) delete s.sessions[h];
    });
  }

  private pruneSessions(s: PersistedState, t: number): void {
    for (const [h, v] of Object.entries(s.sessions)) if (v.expiresAt <= t) delete s.sessions[h];
  }

  // ---- invites -----------------------------------------------------------
  async createInvite(createdBy: string): Promise<{ token: string; invite: InviteView }> {
    const token = randomB64Url(32);
    const t = this.now();
    const rec = { id: randomUUID(), createdBy, createdAt: t, expiresAt: t + INVITE_TTL_MS };
    await this.store.update((s) => {
      for (const [h, i] of Object.entries(s.invites)) if (i.expiresAt <= t) delete s.invites[h];
      s.invites[sha256Hex(token)] = rec;
    });
    return { token, invite: this.inviteView(rec) };
  }

  private inviteView(i: { id: string; createdAt: number; expiresAt: number; createdBy: string }): InviteView {
    return { id: i.id, createdAt: i.createdAt, expiresAt: i.expiresAt, createdBy: this.store.state.users[i.createdBy]?.username ?? "" };
  }

  listInvites(): InviteView[] {
    const t = this.now();
    return Object.values(this.store.state.invites)
      .filter((i) => i.expiresAt > t)
      .map((i) => this.inviteView(i))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteInvite(id: string): Promise<boolean> {
    let found = false;
    await this.store.update((s) => {
      for (const [h, i] of Object.entries(s.invites)) {
        if (i.id === id) {
          delete s.invites[h];
          found = true;
        }
      }
    });
    return found;
  }

  /** Single use: the invite is consumed in the same synchronous step that creates the user. */
  async acceptInvite(token: unknown, username: unknown, password: unknown): Promise<StoredUser> {
    const th = typeof token === "string" && token.length > 0 && token.length <= 200 ? sha256Hex(token) : "";
    const known = th ? this.store.state.invites[th] : undefined;
    if (!known || known.expiresAt <= this.now()) throw new AccountError("BAD_INVITE", "Lời mời không hợp lệ hoặc đã hết hạn.");
    const name = checkUsername(username);
    checkPassword(password);
    const passwordHash = await hashPassword(password);
    const user: StoredUser = { id: randomUUID(), username: name, passwordHash, role: "member", createdAt: this.now(), lastConnectionId: null };
    await this.store.update((s) => {
      const inv = s.invites[th];
      if (!inv || inv.expiresAt <= this.now()) throw new AccountError("BAD_INVITE", "Lời mời không hợp lệ hoặc đã hết hạn.");
      if (Object.values(s.users).some((u) => u.username === name)) throw new AccountError("USERNAME_TAKEN", "Tên đăng nhập đã tồn tại.");
      delete s.invites[th];
      s.users[user.id] = user;
    });
    return user;
  }

  // ---- removal -----------------------------------------------------------
  /** Deletes a member and everything of theirs: sessions, connections, pending connections, grants, tokens and PATs. */
  async deleteMember(userId: string): Promise<boolean> {
    const u = this.store.state.users[userId];
    if (!u) return false;
    if (u.role === "owner") throw new AccountError("FORBIDDEN", "Không thể xóa tài khoản chủ sở hữu.");
    await this.store.update((s) => {
      delete s.users[userId];
      for (const [h, v] of Object.entries(s.sessions)) if (v.userId === userId) delete s.sessions[h];
      for (const [id, c] of Object.entries(s.connections)) if (c.userId === userId) delete s.connections[id];
      for (const [id, p] of Object.entries(s.pendingConnections)) if (p.userId === userId) delete s.pendingConnections[id];
      for (const [id, g] of Object.entries(s.oauth.grants)) if (g.userId === userId) delete s.oauth.grants[id];
      for (const [h, a] of Object.entries(s.oauth.accessTokens)) if (a.userId === userId) delete s.oauth.accessTokens[h];
      for (const [h, r] of Object.entries(s.oauth.refreshTokens)) if (r.userId === userId) delete s.oauth.refreshTokens[h];
      for (const [h, p] of Object.entries(s.pats)) if (p.userId === userId) delete s.pats[h];
    });
    return true;
  }
}
