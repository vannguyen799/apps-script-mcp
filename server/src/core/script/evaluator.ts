/** Port: opt-in script evaluation (DESIGN.md section 8). Separate from SheetsGateway so a Google-API backend can simply omit it. */

export interface EvalResult {
  value: unknown;
  logs: string[];
  durationMs: number;
}

export interface ScriptEvaluator {
  evaluate(code: string, args?: unknown): Promise<EvalResult>;
}

/** Apps Script limits (section 8.1), checked here too so a bad call fails fast. */
export const EVAL_MAX_CODE_CHARS = 100_000;
/** Apps Script itself stops a run after 6 minutes; the transport waits a little longer than that. */
export const EVAL_TIMEOUT_MS = 6.5 * 60_000;

export function isScriptEvaluator(x: unknown): x is ScriptEvaluator {
  return typeof x === "object" && x !== null && typeof (x as { evaluate?: unknown }).evaluate === "function";
}
