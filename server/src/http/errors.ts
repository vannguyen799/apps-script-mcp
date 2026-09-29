import { AccountError } from "../auth/accounts.js";
import { GatewayError } from "../core/sheets/gateway.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const ACCOUNT_STATUS: Record<string, number> = {
  WEAK_PASSWORD: 400,
  BAD_USERNAME: 400,
  BAD_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
};

/** Shared JSON error mapping of both HTTP apps. Returns undefined for anything unexpected. */
export function mapKnownError(err: unknown): { status: number; code: string; message: string; retryAfterSec?: number } | undefined {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message, retryAfterSec: err.retryAfterSec };
  if (err instanceof AccountError) return { status: ACCOUNT_STATUS[err.code] ?? 400, code: err.code, message: err.message, retryAfterSec: err.retryAfterSec };
  if (err instanceof GatewayError) {
    const status = err.code === "BAD_REQUEST" ? 400 : err.code === "NOT_CONNECTED" ? 409 : 502;
    return { status, code: err.code, message: err.message };
  }
  const st = (err as { status?: number } | null)?.status;
  if (st === 400 || st === 413) return { status: st, code: "BAD_REQUEST", message: "Invalid request body." };
  return undefined;
}
