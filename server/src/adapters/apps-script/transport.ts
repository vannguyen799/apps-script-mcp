import { GatewayError } from "../../core/sheets/gateway.js";

export type FetchLike = typeof fetch;

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * POSTs JSON text as text/plain (avoids a CORS-style preflight and matches Apps Script's doPost),
 * follows Google's 302, and returns the parsed JSON envelope. Never logs or includes bodies in errors.
 */
export async function postJson(url: string, payload: unknown, fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new GatewayError("INTERNAL", timeout ? `Apps Script did not answer within ${Math.round(timeoutMs / 1000)} s.` : "Could not reach Apps Script.");
  }
  if (!res.ok) throw new GatewayError("INTERNAL", `Apps Script answered HTTP ${res.status}.`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(
      "INTERNAL",
      "Apps Script returned a non-JSON response. Check that the web app is deployed with access set to 'Anyone' and that the URL ends in /exec.",
    );
  }
}

/** Accepts the documented {body, sig} envelope; also tolerates a bare {ok,...} object (treated as unsigned). */
export function readEnvelope(raw: unknown): { body: string; sig: unknown } {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.body === "string") return { body: o.body, sig: o.sig ?? null };
    if (typeof o.ok === "boolean") return { body: JSON.stringify(o), sig: null };
  }
  throw new GatewayError("INTERNAL", "Malformed response from Apps Script.");
}

export interface WireOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export function parseBody(body: string): WireOutcome {
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === "object" && typeof (v as WireOutcome).ok === "boolean") return v as WireOutcome;
  } catch {
    /* fallthrough */
  }
  throw new GatewayError("INTERNAL", "Malformed response body from Apps Script.");
}
