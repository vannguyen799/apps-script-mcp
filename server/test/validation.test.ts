import { describe, expect, it } from "vitest";
import { parseA1 } from "../src/core/sheets/a1.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import {
  LIMITS,
  looksLikeFormula,
  validateBatch,
  validateReadRange,
  validateSearch,
  validateValues,
  validateWrite,
} from "../src/core/sheets/validation.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof GatewayError ? e.code : "OTHER";
  }
  return "NONE";
};

describe("A1 parsing", () => {
  it("requires the sheet name", () => {
    expect(code(() => parseA1("A1:B2"))).toBe("INVALID_RANGE");
    expect(code(() => parseA1("!A1"))).toBe("INVALID_RANGE");
    expect(code(() => parseA1("''!A1"))).toBe("INVALID_RANGE");
    expect(code(() => parseA1(""))).toBe("INVALID_RANGE");
  });

  it("accepts the four forms, quoted and unquoted sheet names", () => {
    expect(parseA1("Sheet1!A1")).toMatchObject({ sheet: "Sheet1", kind: "cell", rows: 1, cols: 1 });
    expect(parseA1("Sheet1!A1:B3")).toMatchObject({ kind: "range", rows: 3, cols: 2 });
    expect(parseA1("'My Sheet'!A:C")).toMatchObject({ sheet: "My Sheet", kind: "columns", rows: null, cols: 3 });
    expect(parseA1("Sales!2:5")).toMatchObject({ kind: "rows", rows: 4, cols: null });
    expect(parseA1("'Bob''s'!$A$1:$C$2")).toMatchObject({ sheet: "Bob's", rows: 2, cols: 3 });
    expect(parseA1("A1!A1")).toMatchObject({ sheet: "A1" });
  });

  it("rejects malformed refs", () => {
    for (const r of ["S!", "S!A", "S!1A", "S!A1:", "S!A1:B", "S!AAAA1", "S!A0", "S!A1:B2:C3", "S!ZZZZ:A", "'S!A1", "'S'A1"]) {
      expect(code(() => parseA1(r)), r).toBe("INVALID_RANGE");
    }
  });

  it("treats A1:A1 as a bounded 1x1 range, not an anchor", () => {
    expect(parseA1("S!A1:A1")).toMatchObject({ kind: "range", rows: 1, cols: 1 });
  });
});

describe("values shape and formulas", () => {
  it("accepts rectangular grids of primitives", () => {
    expect(validateValues([["a", 1, true, null]], false)).toEqual({ rows: 1, cols: 4, cells: 4 });
  });
  it("rejects empty, ragged, and non-primitive", () => {
    expect(code(() => validateValues([], false))).toBe("INVALID_VALUE");
    expect(code(() => validateValues([[]], false))).toBe("INVALID_VALUE");
    expect(code(() => validateValues([[1, 2], [3]], false))).toBe("INVALID_VALUE");
    expect(code(() => validateValues([[{}]], false))).toBe("INVALID_VALUE");
    expect(code(() => validateValues([[Number.NaN]], false))).toBe("INVALID_VALUE");
    expect(code(() => validateValues([["x".repeat(LIMITS.stringChars + 1)]], false))).toBe("INVALID_VALUE");
  });
  it("formula rule: '=' always; + - @ unless numeric", () => {
    for (const f of ["=SUM(A1)", "+SUM(A1)", "-cmd", "@x", "=1"]) expect(looksLikeFormula(f), f).toBe(true);
    for (const n of ["-5", "+1.5", "-0.25", "hello", "a=b", "", " =x"]) expect(looksLikeFormula(n), n).toBe(false);
    expect(code(() => validateValues([["=1+1"]], false))).toBe("FORMULA_NOT_ALLOWED");
    expect(code(() => validateValues([["-cmd"]], false))).toBe("FORMULA_NOT_ALLOWED");
    expect(code(() => validateValues([["-5", "+1.5"]], false))).toBe("NONE");
    expect(code(() => validateValues([["=1+1"]], true))).toBe("NONE");
  });
  it("per-operation cell limit", () => {
    const big = Array.from({ length: 201 }, () => Array.from({ length: 100 }, () => 1));
    expect(code(() => validateValues(big, false))).toBe("LIMIT_EXCEEDED");
    const ok = Array.from({ length: 200 }, () => Array.from({ length: 100 }, () => 1));
    expect(code(() => validateValues(ok, false))).toBe("NONE");
  });
});

describe("write semantics", () => {
  it("single cell anchors and expands", () => {
    expect(validateWrite("S!B2", [[1, 2], [3, 4]], false).cells).toBe(4);
  });
  it("range size must equal values size", () => {
    expect(code(() => validateWrite("S!A1:B2", [[1, 2]], false))).toBe("RANGE_SIZE_MISMATCH");
    expect(code(() => validateWrite("S!A1:A1", [[1, 2]], false))).toBe("RANGE_SIZE_MISMATCH");
    expect(code(() => validateWrite("S!A1:B2", [[1, 2], [3, 4]], false))).toBe("NONE");
  });
  it("unbounded ranges are INVALID_RANGE for writes", () => {
    expect(code(() => validateWrite("S!A:C", [[1, 2, 3]], false))).toBe("INVALID_RANGE");
    expect(code(() => validateWrite("S!2:5", [[1]], false))).toBe("INVALID_RANGE");
  });
  it("write needs a sheet name", () => {
    expect(code(() => validateWrite("A1", [[1]], false))).toBe("INVALID_RANGE");
  });
});

describe("read, batch and search limits", () => {
  it("read cell limit applies to bounded ranges only", () => {
    expect(code(() => validateReadRange("S!A1:Z5000"))).toBe("LIMIT_EXCEEDED");
    expect(code(() => validateReadRange("S!A:Z"))).toBe("NONE");
    expect(code(() => validateReadRange("S!A1:J10000"))).toBe("NONE");
  });
  it("batch validates every operation, with the failing index in the message", () => {
    const ops = [
      { type: "write", range: "S!A1", values: [[1]] },
      { type: "append", sheet: "S", rows: [[1, 2], [3]] },
    ];
    let msg = "";
    try {
      validateBatch(ops, false);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("operations[1]");
    expect(code(() => validateBatch(ops.slice(0, 1), false))).toBe("NONE");
  });
  it("batch: 50 ops max, 50000 cells total, clear is free", () => {
    const op = { type: "write", range: "S!A1", values: [[1]] };
    expect(code(() => validateBatch(Array(51).fill(op), false))).toBe("LIMIT_EXCEEDED");
    expect(code(() => validateBatch(Array(50).fill(op), false))).toBe("NONE");
    const chunk = { type: "append", sheet: "S", rows: Array.from({ length: 200 }, () => Array.from({ length: 100 }, () => 1)) };
    expect(code(() => validateBatch([chunk, chunk, chunk], false))).toBe("LIMIT_EXCEEDED");
    expect(code(() => validateBatch([chunk, chunk, { type: "clear", range: "S!A:Z" }], false))).toBe("NONE");
    expect(code(() => validateBatch([], false))).toBe("INVALID_VALUE");
    expect(code(() => validateBatch([{ type: "drop" }], false))).toBe("INVALID_VALUE");
  });
  it("search limit", () => {
    expect(code(() => validateSearch("x", 501, undefined))).toBe("LIMIT_EXCEEDED");
    expect(code(() => validateSearch("x", 500, "Sheet1"))).toBe("NONE");
    expect(code(() => validateSearch("", undefined, undefined))).toBe("INVALID_VALUE");
  });
});
