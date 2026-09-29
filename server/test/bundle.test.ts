import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BundleError, SETUP_LINE, loadBundle, parseSpreadsheetLines, personalizeBundle, setupLineCount } from "../src/connection/setup-bundle.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import type { Logger } from "../src/log.js";

const BLOCK = { server: "https://mcp.example.com", token: "T".repeat(43), expiresAt: 1_800_000_000_000 };
const BUNDLE = `// asmcp\n${SETUP_LINE}\nfunction doPost(e) { return 1; }\n`;

describe("Code.gs personalisation (DESIGN.md 9.2)", () => {
  it("replaces the exact line once with the JSON block, leaving everything else byte for byte", () => {
    const out = personalizeBundle(BUNDLE, BLOCK);
    expect(out).toBe(`// asmcp\nvar ASMCP_SETUP_ = {"server":"https://mcp.example.com","token":"${"T".repeat(43)}","expiresAt":1800000000000};\nfunction doPost(e) { return 1; }\n`);
    expect(setupLineCount(out)).toBe(0);
    expect(personalizeBundle(BUNDLE, { ...BLOCK, server: "local" })).toContain('"server":"local"');
  });

  it("fails closed unless the line appears exactly once", () => {
    expect(() => personalizeBundle("function x() {}\n", BLOCK)).toThrow(BundleError);
    expect(() => personalizeBundle(`${SETUP_LINE}\n${SETUP_LINE}\n`, BLOCK)).toThrow(BundleError);
    expect(() => personalizeBundle(`${BUNDLE}\n${SETUP_LINE}\n`, BLOCK)).toThrow(BundleError);
  });

  it("only an exact whole line counts (indented, commented or extended variants do not)", () => {
    for (const near of [`  ${SETUP_LINE}`, `${SETUP_LINE} // x`, `// ${SETUP_LINE}`, "var ASMCP_SETUP_ = null", "var  ASMCP_SETUP_ = null;", `x ${SETUP_LINE}`]) {
      expect(setupLineCount(`a\n${near}\nb\n`), near).toBe(0);
      expect(() => personalizeBundle(`a\n${near}\nb\n`, BLOCK), near).toThrow(BundleError);
    }
    // a near-miss next to the real line does not disturb it
    const out = personalizeBundle(`// ${SETUP_LINE}\n${SETUP_LINE}\n`, BLOCK);
    expect(out.startsWith(`// ${SETUP_LINE}\nvar ASMCP_SETUP_ = {`)).toBe(true);
  });

  it("handles CRLF bundles", () => {
    const out = personalizeBundle(`a\r\n${SETUP_LINE}\r\nb\r\n`, BLOCK);
    expect(out).toMatch(/^a\r\nvar ASMCP_SETUP_ = \{.*\};\r\nb\r\n$/);
  });

  it("does not interpret replacement patterns in the values ($&, $1, quotes, backslashes)", () => {
    const out = personalizeBundle(BUNDLE, { server: 'https://a.example.com/"$&$1\\', token: "$&$`$'", expiresAt: 1 });
    const line = out.split("\n").find((l) => l.startsWith("var ASMCP_SETUP_"))!;
    const parsed = JSON.parse(line.slice("var ASMCP_SETUP_ = ".length, -1));
    expect(parsed).toEqual({ server: 'https://a.example.com/"$&$1\\', token: "$&$`$'", expiresAt: 1 });
    expect(out.split("\n")).toHaveLength(BUNDLE.split("\n").length);
  });

  it("the token in the block is exactly what the script's proof check needs (43 base64url chars for a real pending)", async () => {
    const { ConnectionRegistry } = await import("../src/connection/connection-registry.js");
    const { StateStore } = await import("../src/store/state-store.js");
    const d = await mkdtemp(path.join(os.tmpdir(), "asmcp-bundle-"));
    try {
      const store = new StateStore(d);
      await store.load();
      const r = new ConnectionRegistry({ store, instanceLabel: "t", bundle: BUNDLE, baseUrl: () => "https://mcp.example.com" });
      const p = await r.startPending("u1");
      expect(store.state.pendingConnections[p.id]!.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // a bundle without the line is never served
      const broken = new ConnectionRegistry({ store, instanceLabel: "t", bundle: "function x() {}" });
      expect(() => broken.personalizedBundle(p.id, "u1")).toThrow(/không hợp lệ/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("loadBundle", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "asmcp-load-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const logger = () => {
    const lines: string[] = [];
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (e, f) => lines.push(`warn ${e} ${JSON.stringify(f)}`),
      error: (e, f) => lines.push(`error ${e} ${JSON.stringify(f)}`),
    };
    return { log, lines };
  };

  it("returns the text when the placeholder is there exactly once", async () => {
    const f = path.join(dir, "Code.gs");
    await writeFile(f, BUNDLE);
    expect(await loadBundle(f, logger().log)).toBe(BUNDLE);
  });

  it("returns null (option 1 hidden) and logs when the file is missing, has no placeholder, or has it twice", async () => {
    const l = logger();
    expect(await loadBundle(path.join(dir, "nope.gs"), l.log)).toBeNull();
    const none = path.join(dir, "none.gs");
    await writeFile(none, "function x() {}");
    expect(await loadBundle(none, l.log)).toBeNull();
    const twice = path.join(dir, "twice.gs");
    await writeFile(twice, `${SETUP_LINE}\n${SETUP_LINE}\n`);
    expect(await loadBundle(twice, l.log)).toBeNull();
    expect(l.lines.map((x) => x.split(" ").slice(0, 2).join(" "))).toEqual(["warn bundle_missing", "error bundle_unusable", "error bundle_unusable"]);
    expect(l.lines.join("\n")).not.toContain("function x");
  });
});

describe("wizard spreadsheet input (DESIGN.md 12)", () => {
  const A = "1" + "a".repeat(43);
  const B = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

  it("accepts URL forms and bare ids, in order, ignoring blank lines", () => {
    const text = [
      `https://docs.google.com/spreadsheets/d/${A}/edit#gid=0`,
      "",
      `  docs.google.com/spreadsheets/d/${B}  `,
      `https://docs.google.com/spreadsheets/d/${"c".repeat(30)}`,
      "d".repeat(25),
      "\r",
    ].join("\r\n");
    expect(parseSpreadsheetLines(text)).toEqual([A, B, "c".repeat(30), "d".repeat(25)]);
    expect(parseSpreadsheetLines("")).toEqual([]);
    expect(parseSpreadsheetLines("  \n\n")).toEqual([]);
    expect(parseSpreadsheetLines(undefined)).toEqual([]);
  });

  it("drops duplicates whatever their form", () => {
    expect(parseSpreadsheetLines(`${A}\nhttps://docs.google.com/spreadsheets/d/${A}/edit\n${A}`)).toEqual([A]);
  });

  it("rejects invalid lines together, by 1-based line number (blank lines count)", () => {
    const run = () => parseSpreadsheetLines(`${A}\n\nhttps://example.com/nothing\nshort\n${"a".repeat(101)}\nhttps://docs.google.com/spreadsheets/d/abc/edit\nhas space ${"a".repeat(30)}`);
    expect(run).toThrow(GatewayError);
    expect(run).toThrow(/Dòng 3, 4, 5, 6, 7 /);
    expect(() => parseSpreadsheetLines(`${A}\n$$$$$$$$$$$$$$$$$$$$$$$$$$$`)).toThrow(/Dòng 2 /);
  });

  it("allows 50 distinct spreadsheets and rejects 51; duplicates do not count", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`.padEnd(30, "x"));
    expect(parseSpreadsheetLines(ids(50).join("\n"))).toHaveLength(50);
    expect(parseSpreadsheetLines([...ids(50), ...ids(50)].join("\n"))).toHaveLength(50);
    expect(() => parseSpreadsheetLines(ids(51).join("\n"))).toThrow(/50/);
  });

  it("puts the spreadsheets into ASMCP_SETUP_ as JSON, and omits the key when there are none to carry", () => {
    const sheets = [{ id: A, access: "write" as const }, { id: B, access: "read" as const }];
    const out = personalizeBundle(BUNDLE, { ...BLOCK, spreadsheets: sheets });
    const line = out.split("\n").find((l) => l.startsWith("var ASMCP_SETUP_"))!;
    expect(JSON.parse(line.slice("var ASMCP_SETUP_ = ".length, -1))).toEqual({ ...BLOCK, spreadsheets: sheets });
    expect(out.split("\n")).toHaveLength(BUNDLE.split("\n").length);
    expect(personalizeBundle(BUNDLE, { ...BLOCK, spreadsheets: [] })).toContain('"spreadsheets":[]');
    expect(personalizeBundle(BUNDLE, BLOCK)).not.toContain("spreadsheets");
  });
});
