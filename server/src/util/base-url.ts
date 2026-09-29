/**
 * Normalises a public base URL to a bare origin (no path/query/hash, no trailing slash).
 * Returns null when it is not acceptable as an OAuth issuer.
 * https is required, except http on localhost / 127.0.0.1 (development).
 */
export function normalizeBaseUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  return u.origin;
}
