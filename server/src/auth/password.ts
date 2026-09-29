import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { safeEqualStr } from "../util/crypto.js";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
/** scrypt with N=2^15, r=8 needs ~32 MiB; Node's default maxmem is exactly 32 MiB, so raise it. */
const MAXMEM = 128 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

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

let dummyHash: Promise<string> | undefined;

/** Burns the same scrypt work as a real check, for usernames that do not exist (no user-enumeration timing). Always false. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPasswordHash(typeof password === "string" ? password : "", await dummyHash);
  return false;
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

/** Lowercases and validates; returns null when not acceptable (DESIGN.md 9.1). */
export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const u = input.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}
