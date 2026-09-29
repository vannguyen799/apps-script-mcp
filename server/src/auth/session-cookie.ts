import type { Request, Response } from "express";
import { parseCookies } from "../util/http.js";

export const SESSION_COOKIE = "asmcp_sess";
const MAX_AGE_S = 30 * 24 * 3600;

export const readSessionId = (req: Request): string | undefined => parseCookies(req.headers.cookie)[SESSION_COOKIE];

/** DESIGN.md 9.1: HttpOnly; SameSite=Lax (the OAuth redirect from Claude is a cross-site top-level GET); Path=/; Secure when the public base is https. */
export function setSessionCookie(res: Response, id: string, secure: boolean): void {
  res.append("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure ? "; Secure" : ""}`);
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
}
