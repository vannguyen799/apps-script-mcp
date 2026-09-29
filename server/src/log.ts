import type { LogLevel } from "./config.js";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that are never written, whatever the caller passes (defence in depth). */
const FORBIDDEN = /secret|token|password|passwd|code|body|values|rows|query|cookie|authorization|proof|sig|nonce|cell|payload/i;
/** Allow-listed exceptions to the deny pattern. */
const ALLOWED = new Set(["cellCount", "resultCode", "errorCode", "status", "statusCode", "reason"]);

export function createLogger(level: LogLevel, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, event: string, fields?: LogFields) => {
    if (ORDER[lvl] < min) return;
    const rec: Record<string, unknown> = { ts: new Date().toISOString(), level: lvl, event };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === undefined) continue;
      if (FORBIDDEN.test(k) && !ALLOWED.has(k)) {
        rec[k] = "[redacted]";
        continue;
      }
      if (typeof v === "string" && v.length > 200) rec[k] = v.slice(0, 200) + "...";
      else rec[k] = v;
    }
    write(JSON.stringify(rec));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
