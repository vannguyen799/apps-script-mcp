import { describe, expect, it } from "vitest";
import type { SpreadsheetInfo } from "../src/core/sheets/gateway.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import { SheetsService } from "../src/core/sheets/sheets.service.js";
import { FakeGateway } from "./helpers.js";

const info = (id: string, name: string, alias: string | null = null, access: "read" | "write" = "write"): SpreadsheetInfo => ({ id, name, alias, access, url: "u" });

function setup(list: SpreadsheetInfo[]) {
  const gw = new FakeGateway();
  gw.spreadsheets = list;
  let t = 1_000_000;
  const svc = new SheetsService(gw, { now: () => t });
  return { gw, svc, tick: (ms: number) => (t += ms), listCalls: () => gw.calls.filter((c) => c.method === "listSpreadsheets").length };
}

describe("spreadsheet reference resolution", () => {
  it("alias wins over name, name over id", async () => {
    const { svc } = setup([info("a1", "Budget", "q1"), info("b2", "q1", null), info("q1", "Other", null)]);
    expect((await svc.resolve("q1")).id).toBe("a1");
    expect((await svc.resolve("Budget")).id).toBe("a1");
  });
  it("alias is case-insensitive; name is exact; falls back to ID", async () => {
    const { svc } = setup([info("a1", "Budget", "Sales"), info("zzz", "Other")]);
    expect((await svc.resolve("sales")).id).toBe("a1");
    await expect(svc.resolve("budget")).rejects.toMatchObject({ code: "SPREADSHEET_NOT_AUTHORIZED" });
    expect((await svc.resolve("zzz")).id).toBe("zzz");
  });
  it("ambiguous name lists the candidates", async () => {
    const { svc } = setup([info("id-1", "Report"), info("id-2", "Report")]);
    const e = (await svc.resolve("Report").catch((x: unknown) => x)) as GatewayError;
    expect(e).toBeInstanceOf(GatewayError);
    expect(e.message).toContain("ambiguous");
    expect(e.message).toContain("id-1");
    expect(e.message).toContain("id-2");
    expect((await svc.resolve("id-2")).id).toBe("id-2");
  });
  it("unknown reference mentions what is authorized", async () => {
    const { svc } = setup([info("a1", "Budget", "q1")]);
    await expect(svc.resolve("nope")).rejects.toThrow(/q1/);
  });
  it("caches the list for 30 s and refreshes on a miss after 2 s", async () => {
    const { svc, tick, listCalls } = setup([info("a1", "Budget")]);
    await svc.resolve("Budget");
    tick(1000);
    await svc.resolve("a1");
    expect(listCalls()).toBe(1);
    tick(31_000);
    await svc.resolve("Budget");
    expect(listCalls()).toBe(2);
    await expect(svc.resolve("missing")).rejects.toThrow();
    expect(listCalls()).toBe(2); // fresh cache, no forced refresh
    tick(3000);
    await expect(svc.resolve("missing")).rejects.toThrow();
    expect(listCalls()).toBe(3); // stale-ish cache: one forced refresh on miss
  });
});

describe("access and validation before the gateway", () => {
  it("blocks writes on read-only spreadsheets without calling the gateway", async () => {
    const { svc, gw } = setup([info("r", "RO", null, "read")]);
    await expect(svc.writeRange("RO", "S!A1", [[1]])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    await expect(svc.appendRows("RO", "S", [[1]])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    await expect(svc.batchUpdate("RO", [{ type: "clear", range: "S!A1" }])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    expect(gw.calls.some((c) => c.method === "writeRange")).toBe(false);
    expect((await svc.readRange("RO", "S!A1:B2")).range).toBe("S!A1:B2");
  });
  it("validates before touching the network", async () => {
    const { svc, gw } = setup([info("w", "W")]);
    await expect(svc.readRange("W", "A1:B2")).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(svc.writeRange("W", "S!A1", [[1], [1, 2]])).rejects.toMatchObject({ code: "INVALID_VALUE" });
    await expect(svc.writeRange("W", "S!A1", [["=1"]])).rejects.toMatchObject({ code: "FORMULA_NOT_ALLOWED" });
    expect(gw.calls).toHaveLength(0);
  });
  it("passes resolved id and camelCase params through", async () => {
    const { svc, gw } = setup([info("w", "W", "alias")]);
    await svc.writeRange("alias", "S!A1", [["=1"]], true);
    await svc.search("alias", { query: "x", matchCase: true });
    expect(gw.calls.find((c) => c.method === "writeRange")!.arg).toMatchObject({ spreadsheetId: "w", allowFormulas: true });
    expect(gw.calls.find((c) => c.method === "search")!.arg).toMatchObject({ spreadsheetId: "w", matchCase: true });
  });
});
