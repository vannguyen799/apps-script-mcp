export const SCOPE_READ = "sheets.read";
export const SCOPE_WRITE = "sheets.write";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;
export const DEFAULT_SCOPES: string[] = [SCOPE_READ, SCOPE_WRITE];

export function isSupportedScope(s: string): boolean {
  return (SUPPORTED_SCOPES as readonly string[]).includes(s);
}
