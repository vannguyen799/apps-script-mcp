/** Public URL from one line of `cloudflared tunnel --url ...` output (quick tunnel), or null. */
export function parseCloudflaredUrl(line: string): string | null {
  for (const m of line.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)) {
    // cloudflared also mentions api.trycloudflare.com when the request for a quick tunnel fails.
    if (m[1]!.toLowerCase() !== "api") return m[0].toLowerCase();
  }
  return null;
}

/** Public URL from one line of `ngrok --log stdout --log-format json` output, or null. */
export function parseNgrokUrl(line: string): string | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const r = o as { msg?: unknown; url?: unknown };
  if (r.msg !== "started tunnel" || typeof r.url !== "string") return null;
  return /^https:\/\/[^/\s]+$/i.test(r.url) ? r.url.toLowerCase() : null;
}
