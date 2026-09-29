import { GatewayError } from "./gateway.js";

export interface ParsedRange {
  sheet: string;
  /** The cell part as written, without the sheet. */
  ref: string;
  kind: "cell" | "range" | "columns" | "rows";
  /** null for unbounded dimensions (whole columns / rows). */
  rows: number | null;
  cols: number | null;
}

const MAX_COL = 18278; // ZZZ
const MAX_ROW = 10_000_000;
const HINT = "Use A1 notation that includes the sheet name, e.g. Sheet1!A1:F100, 'My Sheet'!A:C or Sales!B2.";

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,8})$/;
const COLS = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/;
const ROWS = /^\$?(\d{1,8}):\$?(\d{1,8})$/;

function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function bad(message: string): never {
  throw new GatewayError("INVALID_RANGE", message);
}

function checkCell(col: number, row: number, ref: string): void {
  if (col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) bad(`Range "${ref}" is out of bounds. ${HINT}`);
}

/** Splits "'My Sheet'!A1:B2" into sheet name and cell reference. */
function splitSheet(range: string): { sheet: string; ref: string } {
  if (range.startsWith("'")) {
    let i = 1;
    let name = "";
    for (;;) {
      if (i >= range.length) bad(`Unterminated quoted sheet name in "${range}". ${HINT}`);
      const ch = range[i]!;
      if (ch === "'") {
        if (range[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += ch;
      i += 1;
    }
    if (range[i + 1] !== "!") bad(`Expected "!" after the quoted sheet name in "${range}". ${HINT}`);
    return { sheet: name, ref: range.slice(i + 2) };
  }
  const bang = range.indexOf("!");
  if (bang < 0) bad(`Range "${range}" has no sheet name. ${HINT}`);
  return { sheet: range.slice(0, bang), ref: range.slice(bang + 1) };
}

export function parseA1(input: unknown): ParsedRange {
  if (typeof input !== "string" || input.trim() === "") bad(`Range must be a non-empty string. ${HINT}`);
  const range = (input as string).trim();
  if (range.length > 300) bad("Range is too long.");
  const { sheet, ref } = splitSheet(range);
  if (sheet.trim() === "") bad(`Sheet name must not be empty. ${HINT}`);
  if (sheet.length > 100) bad("Sheet name is too long.");

  const parts = ref.split(":");
  const [a, b] = parts;
  if (parts.length > 2) bad(`Unsupported range "${ref}". Accepted forms: A1, A1:B2, A:C, 2:5. ${HINT}`);
  if (parts.length === 2) {
    const m1 = CELL.exec(a ?? "");
    const m2 = CELL.exec(b ?? "");
    if (m1 && m2) {
      const c1 = colNum(m1[1]!), r1 = Number(m1[2]);
      const c2 = colNum(m2[1]!), r2 = Number(m2[2]);
      checkCell(c1, r1, ref);
      checkCell(c2, r2, ref);
      return { sheet, ref, kind: "range", rows: Math.abs(r2 - r1) + 1, cols: Math.abs(c2 - c1) + 1 };
    }
    const mc = COLS.exec(ref);
    if (mc) {
      const c1 = colNum(mc[1]!), c2 = colNum(mc[2]!);
      checkCell(c1, 1, ref);
      checkCell(c2, 1, ref);
      return { sheet, ref, kind: "columns", rows: null, cols: Math.abs(c2 - c1) + 1 };
    }
    const mr = ROWS.exec(ref);
    if (mr) {
      const r1 = Number(mr[1]), r2 = Number(mr[2]);
      checkCell(1, r1, ref);
      checkCell(1, r2, ref);
      return { sheet, ref, kind: "rows", rows: Math.abs(r2 - r1) + 1, cols: null };
    }
    bad(`Unsupported range "${ref}". Accepted forms: A1, A1:B2, A:C, 2:5. ${HINT}`);
  }
  const m = CELL.exec(ref);
  if (!m) bad(`Unsupported range "${ref}". Accepted forms: A1, A1:B2, A:C, 2:5. ${HINT}`);
  checkCell(colNum(m![1]!), Number(m![2]), ref);
  return { sheet, ref, kind: "cell", rows: 1, cols: 1 };
}
