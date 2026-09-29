import type { Request } from "express";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOfHeader(host: string | undefined): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(":");
  return i < 0 ? h : h.slice(0, i);
}

/**
 * DESIGN.md 9.1: `Origin`, when present, must equal the public base origin.
 * Two additions, neither of which a cross-site page can exploit: when no public base is configured yet, and when the
 * request itself is addressed to a loopback host, an Origin equal to the Host is accepted (local use of /account
 * while the public base is a tunnel hostname). A DNS-rebinding page never has a loopback Host.
 */
export function originAllowed(req: Request, publicBase: string | undefined): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (publicBase && parsed.origin === publicBase) return true;
  const host = (req.headers.host ?? "").toLowerCase();
  if (!publicBase) return parsed.host.toLowerCase() === host;
  return LOOPBACK.has(hostnameOfHeader(host)) && parsed.host.toLowerCase() === host;
}
