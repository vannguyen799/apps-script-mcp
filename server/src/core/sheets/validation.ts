import { parseA1 } from "./a1.js";
import type { BatchOperation, CellValue } from "./gateway.js";
import { GatewayError } from "./gateway.js";

export const LIMITS = {
  readCells: 100_000,
  writeCellsPerOp: 20_000,
  writeCellsPerBatch: 50_000,
  opsPerBatch: 50,
  searchLimit: 500,
  stringChars: 50_000,
  queryChars: 1_000,
  sheetNameChars: 100,
} as const;

/**
 * A string is a formula when it starts with "=", or starts with "+", "-" or "@" and is not a plain number
 * ("-5" and "+1.5" are fine; "+SUM(A1)", "-cmd" and "@x" are formulas). Mirrors the Apps Script side.
 */
export function looksLikeFormula(s: string): boolean {
  if (s.startsWith("=")) return true;
  const c = s[0];
  if (c === "+" || c === "-" || c === "@") return Number.isNaN(Number(s.trim()));
  return false;
}

export interface ValuesShape {
  rows: number;
  cols: number;
  cells: number;
}

/** Validates a rectangular, non-empty 2-D array of cell values; formulas need `allowFormulas`. */
export function validateValues(values: unknown, allowFormulas: boolean, label = "values"): ValuesShape {
  if (!Array.isArray(values) || values.length === 0) {
    throw new GatewayError("INVALID_VALUE", `${label} must be a non-empty array of rows.`);
  }
  const first = values[0];
  if (!Array.isArray(first) || first.length === 0) {
    throw new GatewayError("INVALID_VALUE", `${label} rows must be non-empty arrays.`);
  }
  const width = first.length;
  let cells = 0;
  for (let r = 0; r < values.length; r++) {
    const row: unknown = values[r];
    if (!Array.isArray(row)) throw new GatewayError("INVALID_VALUE", `${label}[${r}] is not an array.`);
    if (row.length !== width) {
      throw new GatewayError(
        "INVALID_VALUE",
        `${label} must be rectangular: row ${r} has ${row.length} cells but row 0 has ${width}. Rows are never padded.`,
      );
    }
    for (let c = 0; c < row.length; c++) {
      const v: unknown = row[c];
      if (v === null || typeof v === "boolean") continue;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new GatewayError("INVALID_VALUE", `${label}[${r}][${c}] is not a finite number.`);
      } else if (typeof v === "string") {
        if (v.length > LIMITS.stringChars) {
          throw new GatewayError("INVALID_VALUE", `${label}[${r}][${c}] exceeds ${LIMITS.stringChars} characters.`);
        }
        if (looksLikeFormula(v) && !allowFormulas) {
          throw new GatewayError(
            "FORMULA_NOT_ALLOWED",
            `${label}[${r}][${c}] looks like a formula (starts with "=", or "+", "-", "@" without being a number). Set allow_formulas=true if you really intend to write a formula.`,
          );
        }
      } else {
        throw new GatewayError("INVALID_VALUE", `${label}[${r}][${c}] must be a string, number, boolean or null.`);
      }
    }
    cells += width;
    if (cells > LIMITS.writeCellsPerOp) {
      throw new GatewayError("LIMIT_EXCEEDED", `A single write may contain at most ${LIMITS.writeCellsPerOp} cells.`);
    }
  }
  return { rows: values.length, cols: width, cells };
}

export function validateSheetName(sheet: unknown, label = "sheet"): string {
  if (typeof sheet !== "string" || sheet.trim() === "") {
    throw new GatewayError("INVALID_RANGE", `${label} must be a non-empty sheet name.`);
  }
  if (sheet.length > LIMITS.sheetNameChars) throw new GatewayError("INVALID_RANGE", `${label} is too long.`);
  return sheet;
}

/** Validates a read range (sheet name required, size limit for bounded ranges). */
export function validateReadRange(range: string): void {
  const p = parseA1(range);
  if (p.rows !== null && p.cols !== null && p.rows * p.cols > LIMITS.readCells) {
    throw new GatewayError("LIMIT_EXCEEDED", `A read may cover at most ${LIMITS.readCells} cells; ${range} covers ${p.rows * p.cols}.`);
  }
}

/** Write semantics: single cell = anchor; otherwise range size must equal the values' size. */
export function validateWrite(range: string, values: unknown, allowFormulas: boolean, label = "values"): ValuesShape {
  const p = parseA1(range);
  const shape = validateValues(values, allowFormulas, label);
  if (p.kind !== "cell") {
    if (p.rows === null || p.cols === null) {
      throw new GatewayError(
        "INVALID_RANGE",
        `Write range "${range}" must be bounded (e.g. Sheet1!A1:C3) or a single anchor cell (e.g. Sheet1!A1).`,
      );
    }
    if (p.rows !== shape.rows || p.cols !== shape.cols) {
      throw new GatewayError(
        "RANGE_SIZE_MISMATCH",
        `Range ${range} is ${p.rows}x${p.cols} but values are ${shape.rows}x${shape.cols}. Use a single anchor cell or a range of exactly the same size.`,
      );
    }
  }
  return shape;
}

/** Validates every batch operation; nothing is sent unless all pass. Returns total written cells. */
export function validateBatch(operations: unknown, allowFormulas: boolean): number {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new GatewayError("INVALID_VALUE", "operations must be a non-empty array.");
  }
  if (operations.length > LIMITS.opsPerBatch) {
    throw new GatewayError("LIMIT_EXCEEDED", `A batch may contain at most ${LIMITS.opsPerBatch} operations.`);
  }
  let total = 0;
  operations.forEach((raw: unknown, i) => {
    const op = raw as Partial<BatchOperation> | null;
    const label = `operations[${i}]`;
    try {
      if (!op || typeof op !== "object") throw new GatewayError("INVALID_VALUE", "must be an object.");
      switch (op.type) {
        case "write":
          total += validateWrite(op.range as string, op.values, allowFormulas, "values").cells;
          break;
        case "append":
          validateSheetName(op.sheet);
          total += validateValues(op.rows, allowFormulas, "rows").cells;
          break;
        case "clear":
          parseA1(op.range);
          break;
        default:
          throw new GatewayError("INVALID_VALUE", `unknown type; expected "write", "append" or "clear".`);
      }
    } catch (e) {
      if (e instanceof GatewayError) throw new GatewayError(e.code, `${label}: ${e.message}`);
      throw e;
    }
  });
  if (total > LIMITS.writeCellsPerBatch) {
    throw new GatewayError("LIMIT_EXCEEDED", `A batch may write at most ${LIMITS.writeCellsPerBatch} cells in total (got ${total}).`);
  }
  return total;
}

export function validateSearch(query: unknown, limit: unknown, sheet: unknown): void {
  if (typeof query !== "string" || query === "") throw new GatewayError("INVALID_VALUE", "query must be a non-empty string.");
  if (query.length > LIMITS.queryChars) throw new GatewayError("INVALID_VALUE", `query is longer than ${LIMITS.queryChars} characters.`);
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw new GatewayError("INVALID_VALUE", "limit must be a positive integer.");
    if (limit > LIMITS.searchLimit) throw new GatewayError("LIMIT_EXCEEDED", `limit may be at most ${LIMITS.searchLimit}.`);
  }
  if (sheet !== undefined) validateSheetName(sheet);
}

export type { CellValue };
