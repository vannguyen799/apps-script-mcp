import { readFile } from "node:fs/promises";
import { GatewayError } from "../core/sheets/gateway.js";
import type { Logger } from "../log.js";

/** DESIGN.md 9.2: this exact line, once, on its own line in the bundle. */
export const SETUP_LINE = "var ASMCP_SETUP_ = null;";

export class BundleError extends Error {}

export interface SetupBlock {
  /** The public base URL, or the string "local". */
  server: string;
  token: string;
  expiresAt: number;
  /** Wizard only (DESIGN.md 12): the script adds these to its allowlist on the setup pair. */
  spreadsheets?: SetupSpreadsheet[];
}

export interface SetupSpreadsheet {
  id: string;
  access: "read" | "write";
}

export const MAX_SETUP_SPREADSHEETS = 50;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{25,100}$/;
const SHEET_URL_RE = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/;

/**
 * DESIGN.md 12: one spreadsheet per line, either a link containing /spreadsheets/d/<id> or a bare id. Blank lines are
 * ignored, duplicates dropped; invalid lines are rejected together, by their 1-based line number.
 */
export function parseSpreadsheetLines(text: unknown): string[] {
  const ids: string[] = [];
  const bad: number[] = [];
  (typeof text === "string" ? text : "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const id = SHEET_URL_RE.exec(line)?.[1] ?? line;
    if (!SHEET_ID_RE.test(id)) bad.push(i + 1);
    else if (!ids.includes(id)) ids.push(id);
  });
  if (bad.length) throw new GatewayError("BAD_REQUEST", `Dòng ${bad.join(", ")} không phải link hoặc ID Google Sheet hợp lệ.`);
  if (ids.length > MAX_SETUP_SPREADSHEETS) throw new GatewayError("BAD_REQUEST", `Tối đa ${MAX_SETUP_SPREADSHEETS} bảng tính.`);
  return ids;
}

export const setupLineCount = (bundle: string): number => bundle.split(/\r?\n/).filter((l) => l === SETUP_LINE).length;

/**
 * Replaces the placeholder line with the personalised block. Fails closed: anything but exactly one occurrence throws,
 * so a bundle that cannot carry the token is never served. Line based (no regexp replacement), so nothing in the
 * token or server string can be interpreted as a replacement pattern.
 */
export function personalizeBundle(bundle: string, block: SetupBlock): string {
  if (setupLineCount(bundle) !== 1) throw new BundleError(`the bundle must contain the line "${SETUP_LINE}" exactly once`);
  const data = { server: block.server, token: block.token, expiresAt: block.expiresAt, ...(block.spreadsheets ? { spreadsheets: block.spreadsheets } : {}) };
  const replacement = `var ASMCP_SETUP_ = ${JSON.stringify(data)};`;
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
