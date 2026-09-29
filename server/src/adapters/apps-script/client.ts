import type { GatewayErrorCode } from "../../core/sheets/gateway.js";
import { GATEWAY_ERROR_CODES, GatewayError } from "../../core/sheets/gateway.js";
import type { Logger } from "../../log.js";
import { nullLogger } from "../../log.js";
import { newNonce, signCall, verifyResponseSig } from "./signing.js";
import type { FetchLike } from "./transport.js";
import { DEFAULT_TIMEOUT_MS, parseBody, postJson, readEnvelope } from "./transport.js";

export interface AppsScriptClientOptions {
  url: string;
  instanceId: string;
  secret: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  nonce?: () => string;
  logger?: Logger;
}

const EVAL_MAX_MESSAGE = 2000;
const EVAL_MAX_LOG_LINES = 200;

/** `signed` = the response signature verified. Only then may an EVAL_ERROR carry its long message and logs. */
function wireError(error: { code?: unknown; message?: unknown; logs?: unknown } | undefined, signed = false): GatewayError {
  const code = typeof error?.code === "string" && (GATEWAY_ERROR_CODES as readonly string[]).includes(error.code) ? (error.code as GatewayErrorCode) : "INTERNAL";
  const max = signed && code === "EVAL_ERROR" ? EVAL_MAX_MESSAGE : 300;
  const msg = typeof error?.message === "string" && error.message !== "" ? error.message.slice(0, max) : code;
  if (signed && code === "EVAL_ERROR" && Array.isArray(error?.logs)) {
    const logs = error.logs.filter((l): l is string => typeof l === "string").slice(0, EVAL_MAX_LOG_LINES).map((l) => l.slice(0, EVAL_MAX_MESSAGE));
    return new GatewayError(code, msg, logs);
  }
  return new GatewayError(code, msg);
}

/** Signs calls (DESIGN.md 4.3), sends them, and verifies the response signature before trusting any data. */
export class AppsScriptClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly log: Logger;

  constructor(private readonly opts: AppsScriptClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.nonce = opts.nonce ?? newNonce;
    this.log = opts.logger ?? nullLogger;
  }

  async call(action: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const started = this.now();
    const ts = this.now();
    const nonce = this.nonce();
    const payload = JSON.stringify({ action, params });
    const envelope = {
      v: 1,
      kind: "call",
      instanceId: this.opts.instanceId,
      ts,
      nonce,
      payload,
      sig: signCall(this.opts.secret, this.opts.instanceId, ts, nonce, payload),
    };
    try {
      const raw = await postJson(this.opts.url, envelope, this.fetchImpl, opts.timeoutMs ?? this.timeoutMs);
      const { body, sig } = readEnvelope(raw);

      if (sig === null || sig === undefined) {
        // Unsigned: never data. Only an error code may be surfaced.
        const outcome = parseBody(body);
        if (!outcome.ok && outcome.error) throw wireError(outcome.error);
        throw new GatewayError("INTERNAL", "Rejected an unsigned response from Apps Script.");
      }
      if (!verifyResponseSig(this.opts.secret, nonce, body, sig)) {
        throw new GatewayError("INTERNAL", "Rejected a response with an invalid signature from Apps Script.");
      }
      const outcome = parseBody(body);
      if (!outcome.ok) throw wireError(outcome.error, true);
      this.log.debug("apps_script_call", { action, durationMs: this.now() - started, resultCode: "OK" });
      return outcome.result;
    } catch (e) {
      const resultCode = e instanceof GatewayError ? e.code : "INTERNAL";
      this.log.warn("apps_script_call_failed", { action, durationMs: this.now() - started, resultCode });
      throw e;
    }
  }
}
