import { randomInt } from "node:crypto";
import { GatewayError } from "../../core/sheets/gateway.js";
import { signSetupProof, verifyPairProof } from "./signing.js";
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
  | { status: "paired"; account: string; scriptId: string | null; scriptName: string | null }
  | { status: "not_ready" }
  | { status: "invalid" }
  | { status: "bad_proof" }
  /** REQUEST_EXPIRED: the two clocks disagree by more than 5 minutes (not counted as an attempt on the script side). */
  | { status: "clock_skew" }
  /** LIMIT_EXCEEDED: the script already holds 20 pairings. */
  | { status: "limit" }
  | { status: "failed"; message: string };

interface PairCommon {
  url: string;
  instanceId: string;
  instanceLabel: string;
  secret: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface PairParams extends PairCommon {
  /** Normalised code. */
  code: string;
}

export interface SetupPairParams extends PairCommon {
  /** The pending connection's setup token (the one embedded in the personalised Code.gs). */
  token: string;
}

/** Sends one pair request and interprets the answer (DESIGN.md 4.2 steps 3-5; 9.3 for the setup variant). */
async function sendPair(p: PairCommon, request: Record<string, unknown>, ts: number): Promise<PairAttempt> {
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
    if (code === "REQUEST_EXPIRED") return { status: "clock_skew" };
    if (code === "LIMIT_EXCEEDED") return { status: "limit" };
    return { status: "failed", message: typeof code === "string" ? code : "Pairing failed." };
  }
  const r = outcome.result as { account?: unknown; proof?: unknown; scriptId?: unknown; scriptName?: unknown } | undefined;
  if (!r || typeof r.account !== "string" || !verifyPairProof(p.secret, p.instanceId, ts, r.proof)) {
    return { status: "bad_proof" };
  }
  return {
    status: "paired",
    account: r.account,
    scriptId: typeof r.scriptId === "string" && r.scriptId !== "" ? r.scriptId : null,
    scriptName: typeof r.scriptName === "string" && r.scriptName !== "" ? r.scriptName.slice(0, 100) : null,
  };
}

/** One code-pairing poll. */
export async function attemptPair(p: PairParams): Promise<PairAttempt> {
  const ts = (p.now ?? Date.now)();
  return sendPair(
    p,
    { v: 1, kind: "pair", instanceId: p.instanceId, instanceLabel: p.instanceLabel.slice(0, 64), pairingCode: p.code, secret: p.secret, ts },
    ts,
  );
}

/** Builds the setup pair request of DESIGN.md 9.3. Exported so tests can drive the Apps Script side with the server's own code. */
export function buildSetupPairRequest(p: { instanceId: string; instanceLabel: string; secret: string; token: string; ts: number }): Record<string, unknown> {
  return {
    v: 1,
    kind: "pair",
    mode: "setup",
    instanceId: p.instanceId,
    instanceLabel: p.instanceLabel.slice(0, 64),
    secret: p.secret,
    ts: p.ts,
    setupProof: signSetupProof(p.token, p.instanceId, p.ts, p.secret),
  };
}

/** One setup-pairing poll (no code: the personalised script proves it knows the token). */
export async function attemptSetupPair(p: SetupPairParams): Promise<PairAttempt> {
  const ts = (p.now ?? Date.now)();
  return sendPair(p, buildSetupPairRequest({ instanceId: p.instanceId, instanceLabel: p.instanceLabel, secret: p.secret, token: p.token, ts }), ts);
}
