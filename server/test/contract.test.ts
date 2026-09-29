// Cross-implementation contract test: the real server adapter talks to the real Apps Script code
// (apps-script/src, loaded by apps-script/test/harness.js) through an in-memory transport.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AppsScriptClient } from "../src/adapters/apps-script/client.js";
import { AppsScriptGateway } from "../src/adapters/apps-script/gateway.js";
import { attemptPair, formatPairingCode, generatePairingCode } from "../src/adapters/apps-script/pairing.js";
import type { FetchLike } from "../src/adapters/apps-script/transport.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import { SheetsService } from "../src/core/sheets/sheets.service.js";
import { newSecret } from "../src/adapters/apps-script/signing.js";

const require = createRequire(import.meta.url);
const { createSandbox } = require("../../apps-script/test/harness.js");

const URL = "https://script.google.com/macros/s/AKfycbTEST/exec";
const INSTANCE = "0b7f2c1e-6a1d-4c7e-9f3a-2d5b8e4c1a90";

function wire(sb: any, tamper?: (envelope: any) => any): FetchLike {
  return (async (_url: string, init: RequestInit) => {
    let envelope = sb.doPost(String(init.body));
    if (tamper) envelope = tamper(envelope);
    return new Response(JSON.stringify(envelope), { status: 200 });
  }) as unknown as FetchLike;
}

async function pairedSetup(tamper?: (envelope: any) => any) {
  const sb = createSandbox();
  const now = () => sb.clock.now;
  const code = generatePairingCode();
  const secret = newSecret();
  const pairParams = { url: URL, instanceId: INSTANCE, instanceLabel: "test", code, secret, fetchImpl: wire(sb), now };

  expect(await attemptPair(pairParams)).toEqual({ status: "not_ready" });
  sb.enterPairingCode(formatPairingCode(code).toLowerCase());
  expect(await attemptPair(pairParams)).toEqual({ status: "paired", account: "owner@example.com" });

  const client = new AppsScriptClient({ url: URL, instanceId: INSTANCE, secret, fetchImpl: wire(sb, tamper), now });
  const service = new SheetsService(new AppsScriptGateway(client), { now });
  return { sb, client, service, secret };
}

describe("server adapter <-> Apps Script contract", () => {
  it("pairs, then reads, writes, appends, searches and batches through the real script", async () => {
    const { sb, service } = await pairedSetup();
    sb.addSpreadsheet({ id: "sales-id", name: "Sales 2026", alias: "sales", access: "write", sheets: { Sales: [["name", "qty"], ["apple", 3]] } });
    sb.addSpreadsheet({ id: "fin-id", name: "Finance", access: "read", sheets: { Q1: [["x"]] } });

    const list = await service.listSpreadsheets();
    expect(list.map((s) => s.alias).sort()).toEqual(["Finance", "sales"]);

    const meta = await service.getMetadata("Sales 2026");
    expect(meta.sheets[0]).toMatchObject({ name: "Sales", index: 0, lastRow: 2, lastColumn: 2 });

    expect((await service.readRange("sales", "Sales!A1:B2")).values).toEqual([["name", "qty"], ["apple", "3"]]);
    expect((await service.readRange("sales", "Sales!A1:B2", "UNFORMATTED")).values).toEqual([["name", "qty"], ["apple", 3]]);

    const w = await service.writeRange("sales", "Sales!D1", [["a", "b"], ["c", "d"]]);
    expect(w).toMatchObject({ updatedRows: 2, updatedColumns: 2, updatedCells: 4 });

    const a = await service.appendRows("sales", "Sales", [["pear", 5]]);
    expect(a.appendedRows).toBe(1);

    const found = await service.search("sales", { query: "pear" });
    expect(found.matches[0]).toMatchObject({ sheet: "Sales", row: 3, column: 1 });

    const b = await service.batchUpdate("sales", [
      { type: "write", range: "Sales!A10:B10", values: [["x", 1]] },
      { type: "clear", range: "Sales!D1:E2" },
    ]);
    expect(b.results).toHaveLength(2);
  });

  it("enforces read-only access and the allowlist on the Apps Script side", async () => {
    const { sb, client } = await pairedSetup();
    sb.addSpreadsheet({ id: "fin-id", name: "Finance", access: "read", sheets: { Q1: [["x"]] } });
    sb.addSpreadsheet({ id: "secret-id", name: "Not listed", sheets: { S: [["x"]] } });

    await expect(client.call("range.write", { spreadsheetId: "fin-id", range: "Q1!A1", values: [["y"]] })).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    await expect(client.call("range.read", { spreadsheetId: "secret-id", range: "S!A1" })).rejects.toMatchObject({ code: "SPREADSHEET_NOT_AUTHORIZED" });
    expect(sb.sheetsFake.opened).not.toContain("secret-id");
  });

  it("rejects formulas on both layers unless allowed", async () => {
    const { sb, client, service } = await pairedSetup();
    sb.addSpreadsheet({ id: "s", name: "S", access: "write", sheets: { A: [["x"]] } });
    await expect(service.writeRange("S", "A!A1", [["+SUM(A1)"]])).rejects.toBeInstanceOf(GatewayError);
    await expect(client.call("range.write", { spreadsheetId: "s", range: "A!A1", values: [["=1+1"]] })).rejects.toMatchObject({ code: "FORMULA_NOT_ALLOWED" });
  });

  it("rejects a tampered response signature", async () => {
    const { sb, client } = await pairedSetup((env) => ({ ...env, body: env.body.replace("owner@", "evil@") }));
    sb.addSpreadsheet({ id: "s", name: "S", access: "read", sheets: { A: [["x"]] } });
    await expect(client.call("ping")).rejects.toThrow(/invalid signature/);
  });

  it("gets UNAUTHENTICATED with the wrong secret and REQUEST_EXPIRED with a skewed clock", async () => {
    const { sb } = await pairedSetup();
    const wrong = new AppsScriptClient({ url: URL, instanceId: INSTANCE, secret: newSecret(), fetchImpl: wire(sb), now: () => sb.clock.now });
    await expect(wrong.call("ping")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const { sb: sb2, secret } = await pairedSetup();
    const late = new AppsScriptClient({ url: URL, instanceId: INSTANCE, secret, fetchImpl: wire(sb2), now: () => sb2.clock.now - 301_000 });
    await expect(late.call("ping")).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  });

  it("gets REPLAYED when a nonce is reused", async () => {
    const { sb, secret } = await pairedSetup();
    const fixed = new AppsScriptClient({ url: URL, instanceId: INSTANCE, secret, fetchImpl: wire(sb), now: () => sb.clock.now, nonce: () => "AAAAAAAAAAAAAAAAAAAAAA" });
    await fixed.call("ping");
    await expect(fixed.call("ping")).rejects.toMatchObject({ code: "REPLAYED" });
  });

  describe("script evaluation (DESIGN.md section 8)", () => {
    it("is disabled by default: EVAL_DISABLED, and ping says evalEnabled=false", async () => {
      const { sb, client } = await pairedSetup();
      const gateway = new AppsScriptGateway(client);
      expect((await gateway.ping()).evalEnabled).toBe(false);
      await expect(gateway.evaluate("globalThis.__ran = true; return 1;")).rejects.toMatchObject({ code: "EVAL_DISABLED" });
      expect(sb.ctx.__ran).toBeUndefined();
      // Only the owner page can enable it; the server has no way to.
      await expect(client.call("script.enable", { enabled: true })).rejects.toMatchObject({ code: "UNKNOWN_ACTION" });
      await expect(gateway.evaluate("return 1")).rejects.toMatchObject({ code: "EVAL_DISABLED" });
    });

    it("runs end to end through the real Apps Script code once the owner enabled it", async () => {
      const { sb, client } = await pairedSetup();
      const gateway = new AppsScriptGateway(client);
      sb.ctx.admin_setEvalEnabled(true);
      expect((await gateway.ping()).evalEnabled).toBe(true);
      // Not on the allowlist: evaluated code is outside it (that is the documented risk).
      sb.addSpreadsheet({ id: "unlisted", name: "Unlisted", sheets: { S: [["a", 1], ["b", 2]] } });

      const r = await gateway.evaluate(
        'log("opening", args.id); var v = SpreadsheetApp.openById(args.id).getSheetByName("S").getDataRange().getValues(); return { rows: v.length, first: v[0], at: new Date(0) };',
        { id: "unlisted" },
      );
      expect(r.value).toEqual({ rows: 2, first: ["a", 1], at: "1970-01-01T00:00:00.000Z" });
      expect(r.logs).toEqual(["opening unlisted"]);
      expect(typeof r.durationMs).toBe("number");
      expect(sb.sheetsFake.opened).toContain("unlisted");
      expect((await gateway.evaluate("return;")).value).toBeNull();

      // The audit trail on the Apps Script side holds hashes, never the code.
      const audit = sb.ctx.admin_getEvalAudit();
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain("getDataRange");

      sb.ctx.admin_setEvalEnabled(false);
      await expect(gateway.evaluate("return 1")).rejects.toMatchObject({ code: "EVAL_DISABLED" });
    });

    it("surfaces EVAL_ERROR with the message and the logs written before the throw", async () => {
      const { sb, client } = await pairedSetup();
      const gateway = new AppsScriptGateway(client);
      sb.ctx.admin_setEvalEnabled(true);
      const e = (await gateway.evaluate('log("one"); log({ two: 2 }); undefinedFunction();').catch((x: unknown) => x)) as GatewayError;
      expect(e).toBeInstanceOf(GatewayError);
      expect(e.code).toBe("EVAL_ERROR");
      expect(e.message).toMatch(/^ReferenceError: undefinedFunction is not defined/);
      expect(e.logs).toEqual(["one", '{"two":2}']);
      await expect(gateway.evaluate("var o = {}; o.o = o; return o;")).rejects.toMatchObject({ code: "EVAL_ERROR", message: "Return value is not JSON-serializable" });
      await expect(gateway.evaluate('return "x".repeat(5 * 1024 * 1024);')).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    });

    it("rejects a tampered eval response (signature covers value and logs)", async () => {
      const { sb, client } = await pairedSetup((env) => ({ ...env, body: env.body.replace("42", "43") }));
      sb.ctx.admin_setEvalEnabled(true);
      await expect(new AppsScriptGateway(client).evaluate("return 42;")).rejects.toThrow(/invalid signature/);
    });
  });
});
