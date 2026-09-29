import { randomInt } from "node:crypto";
import { GatewayError } from "../../core/sheets/gateway.js";
import { verifyPairProof } from "./signing.js";
import type { FetchLike } from "./transport.js";
import { DEFAULT_TIMEOUT_MS, parseBody, postJson, readEnvelope } from "./transport.js";

export const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_POLL_MS = 4_000;
export const APPS_SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export function generatePairingCode(): string {
  let s = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) s += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return s;
}

/** XXXX-XXXX */
export function formatPairingCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** Uppercase and drop every char outside [A-Z0-9]. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type PairAttempt =
  | { status: "paired"; account: string }
  | { status: "not_ready" }
  | { status: "invalid" }
  | { status: "bad_proof" }
  | { status: "failed"; message: string };

export interface PairParams {
  url: string;
  instanceId: string;
  instanceLabel: string;
  /** Normalised code. */
  code: string;
  secret: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

/** One pairing poll (DESIGN.md 4.2 steps 3-5). */
export async function attemptPair(p: PairParams): Promise<PairAttempt> {
  const ts = (p.now ?? Date.now)();
  const request = {
    v: 1,
    kind: "pair",
    instanceId: p.instanceId,
    instanceLabel: p.instanceLabel.slice(0, 64),
    pairingCode: p.code,
    secret: p.secret,
    ts,
  };
  let outcome;
  try {
    const raw = await postJson(p.url, request, p.fetchImpl ?? fetch, p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    outcome = parseBody(readEnvelope(raw).body);
  } catch (e) {
    return { status: "failed", message: e instanceof GatewayError ? e.message : "Pairing request failed." };
  }
  if (!outcome.ok) {
    const code = outcome.error?.code;
    if (code === "PAIRING_NOT_READY") return { status: "not_ready" };
    if (code === "PAIRING_INVALID") return { status: "invalid" };
    return { status: "failed", message: typeof code === "string" ? code : "Pairing failed." };
  }
  const r = outcome.result as { account?: unknown; proof?: unknown } | undefined;
  if (!r || typeof r.account !== "string" || !verifyPairProof(p.secret, p.instanceId, ts, r.proof)) {
    return { status: "bad_proof" };
  }
  return { status: "paired", account: r.account };
}
