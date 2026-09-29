import { createHmac } from "node:crypto";
import { randomB64Url, safeEqualHex } from "../../util/crypto.js";

/** DESIGN.md 4.1: the HMAC key is the UTF-8 bytes of the base64url secret *string*; output is lowercase hex. */
export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(message, "utf8").digest("hex");
}

export const newSecret = (): string => randomB64Url(32); // 43 chars
export const newNonce = (): string => randomB64Url(16); // 22 chars

export const callMessage = (instanceId: string, ts: number, nonce: string, payload: string): string =>
  `v1\ncall\n${instanceId}\n${ts}\n${nonce}\n${payload}`;

export const signCall = (secret: string, instanceId: string, ts: number, nonce: string, payload: string): string =>
  hmacHex(secret, callMessage(instanceId, ts, nonce, payload));

export const responseMessage = (nonce: string, body: string): string => `v1\nresp\n${nonce}\n${body}`;

export const signResponse = (secret: string, nonce: string, body: string): string => hmacHex(secret, responseMessage(nonce, body));

export function verifyResponseSig(secret: string, nonce: string, body: string, sig: unknown): boolean {
  return typeof sig === "string" && safeEqualHex(signResponse(secret, nonce, body), sig);
}

export const pairAckMessage = (instanceId: string, ts: number): string => `v1\npair-ack\n${instanceId}\n${ts}`;

export const signPairAck = (secret: string, instanceId: string, ts: number): string => hmacHex(secret, pairAckMessage(instanceId, ts));

export function verifyPairProof(secret: string, instanceId: string, ts: number, proof: unknown): boolean {
  return typeof proof === "string" && safeEqualHex(signPairAck(secret, instanceId, ts), proof);
}
