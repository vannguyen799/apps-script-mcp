import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export const randomB64Url = (bytes: number): string => randomBytes(bytes).toString("base64url");

/** Constant-time string comparison that does not leak length (compares SHA-256 digests). */
export function safeEqualStr(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Constant-time comparison of two lowercase-hex MACs of the same expected length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
