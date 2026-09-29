import { readFile } from "node:fs/promises";
import type { Logger } from "../log.js";

/** DESIGN.md 9.2: this exact line, once, on its own line in the bundle. */
export const SETUP_LINE = "var ASMCP_SETUP_ = null;";

export class BundleError extends Error {}

export interface SetupBlock {
  /** The public base URL, or the string "local". */
  server: string;
  token: string;
  expiresAt: number;
}

export const setupLineCount = (bundle: string): number => bundle.split(/\r?\n/).filter((l) => l === SETUP_LINE).length;

/**
 * Replaces the placeholder line with the personalised block. Fails closed: anything but exactly one occurrence throws,
 * so a bundle that cannot carry the token is never served. Line based (no regexp replacement), so nothing in the
 * token or server string can be interpreted as a replacement pattern.
 */
export function personalizeBundle(bundle: string, block: SetupBlock): string {
  if (setupLineCount(bundle) !== 1) throw new BundleError(`the bundle must contain the line "${SETUP_LINE}" exactly once`);
  const replacement = `var ASMCP_SETUP_ = ${JSON.stringify({ server: block.server, token: block.token, expiresAt: block.expiresAt })};`;
  return bundle
    .split("\n")
    .map((l) => (l === SETUP_LINE || l === `${SETUP_LINE}\r` ? replacement + (l.endsWith("\r") ? "\r" : "") : l))
    .join("\n");
}

/** Reads the shipped Code.gs. Returns null (option 1 hidden) when it is missing or unusable. */
export async function loadBundle(file: string, log: Logger): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    log.warn("bundle_missing", { reason: "unreadable" });
    return null;
  }
  const n = setupLineCount(text);
  if (n !== 1) {
    log.error("bundle_unusable", { reason: n === 0 ? "placeholder_missing" : "placeholder_repeated" });
    return null;
  }
  return text;
}
