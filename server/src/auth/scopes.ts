export const SCOPE_READ = "sheets.read";
export const SCOPE_WRITE = "sheets.write";
/** Opt-in (DESIGN.md section 8): arbitrary Apps Script code. Never part of DEFAULT_SCOPES or of what the metadata advertises. */
export const SCOPE_EVAL = "script.eval";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_EVAL] as const;
/** Granted when a client requests no scope. Deliberately excludes SCOPE_EVAL: it must be requested explicitly. */
export const DEFAULT_SCOPES: string[] = [SCOPE_READ, SCOPE_WRITE];
/** What OAuth metadata advertises as scopes_supported. Clients may request everything advertised, so this stays the defaults. */
export const ADVERTISED_SCOPES: string[] = DEFAULT_SCOPES;

export function isSupportedScope(s: string): boolean {
  return (SUPPORTED_SCOPES as readonly string[]).includes(s);
}
