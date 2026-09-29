import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { randomB64Url, safeEqualStr, sha256Hex } from "../util/crypto.js";
import type { StateStore } from "../store/state-store.js";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
/** scrypt with N=2^15, r=8 needs ~32 MiB; Node's default maxmem is exactly 32 MiB, so raise it. */
const MAXMEM = 128 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Encoded as scrypt$N$r$p$<salt b64>$<key b64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPasswordHash(password: string, encoded: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = encoded.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !key || password.length > MAX_PASSWORD_LENGTH) return false;
  const derived = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return safeEqualStr(derived.toString("base64"), key);
}

export class AdminAuthError extends Error {
  constructor(
    public readonly code: "BAD_SETUP_TOKEN" | "WEAK_PASSWORD" | "ALREADY_SETUP",
    message: string,
  ) {
    super(message);
  }
}

export interface AdminSession {
  id: string;
  csrf: string;
  lastSeen: number;
}

export interface AdminAuthOptions {
  now?: () => number;
  sessionIdleMs?: number;
}

export class AdminAuth {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(
    private readonly store: StateStore,
    opts: AdminAuthOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.sessionIdleMs ?? 12 * 3600_000;
  }

  needsSetup(): boolean {
    return this.store.state.admin.passwordHash === null;
  }

  /**
   * When no password exists, mints a fresh one-time setup token, persists only its hash and returns the
   * plaintext for the caller to print once. Called on every start while unconfigured (the previous token is lost
   * by design: only its hash was kept).
   */
  async ensureSetupToken(): Promise<string | null> {
    if (!this.needsSetup()) return null;
    const token = randomB64Url(24);
    await this.store.update((s) => {
      s.admin.setupTokenHash = sha256Hex(token);
    });
    return token;
  }

  async completeSetup(setupToken: string, password: string): Promise<AdminSession> {
    if (!this.needsSetup()) throw new AdminAuthError("ALREADY_SETUP", "Admin password is already set.");
    const hash = this.store.state.admin.setupTokenHash;
    if (typeof setupToken !== "string" || !hash || !safeEqualStr(sha256Hex(setupToken.trim()), hash)) {
      throw new AdminAuthError("BAD_SETUP_TOKEN", "Setup token is invalid.");
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new AdminAuthError("WEAK_PASSWORD", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) throw new AdminAuthError("WEAK_PASSWORD", "Password is too long.");
    const passwordHash = await hashPassword(password);
    await this.store.update((s) => {
      s.admin.passwordHash = passwordHash;
      s.admin.setupTokenHash = null;
    });
    return this.createSession();
  }

  async verifyPassword(password: unknown): Promise<boolean> {
    const h = this.store.state.admin.passwordHash;
    if (!h || typeof password !== "string") return false;
    return verifyPasswordHash(password, h);
  }

  createSession(): AdminSession {
    const s: AdminSession = { id: randomB64Url(32), csrf: randomB64Url(32), lastSeen: this.now() };
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
}
