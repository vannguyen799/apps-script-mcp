// Cross-implementation contract test: the real server adapter talks to the real Apps Script code
// (apps-script/src, loaded by apps-script/test/harness.js) through an in-memory transport.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { AppsScriptClient } from "../src/adapters/apps-script/client.js";
import { AppsScriptGateway } from "../src/adapters/apps-script/gateway.js";
import { attemptPair, formatPairingCode, generatePairingCode } from "../src/adapters/apps-script/pairing.js";
import type { FetchLike } from "../src/adapters/apps-script/transport.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import { SheetsService } from "../src/core/sheets/sheets.service.js";
import { newSecret } from "../src/adapters/apps-script/signing.js";
import { parseSpreadsheetLines, setupLineCount } from "../src/connection/setup-bundle.js";
import type { Harness } from "./helpers.js";
import { fullOAuth, makeHarness } from "./helpers.js";

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
  expect(await attemptPair(pairParams)).toMatchObject({ status: "paired", account: "owner@example.com", scriptId: expect.any(String) });

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

// ---------------------------------------------------------------------------------------------------------------
// DESIGN.md section 9: accounts, several connections, one-paste setup, against the real Apps Script code.
// ---------------------------------------------------------------------------------------------------------------
const REAL_BUNDLE = readFileSync(new globalThis.URL("../../apps-script/Code.gs", import.meta.url), "utf8");

describe("section 9 against the real Apps Script code", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  /** Routes each web app URL to its own in-memory script. */
  const scripts = new Map<string, any>();
  const routing = (async (url: string, init: RequestInit) => {
    const sb = scripts.get(String(url));
    if (!sb) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(sb.doPost(String(init.body))), { status: 200 });
  }) as unknown as FetchLike;
  const newScript = (url: string, scriptId: string, email = "owner@example.com") => {
    const sb = createSandbox({ now: Date.now(), scriptId, activeEmail: email, effectiveEmail: email, webAppUrl: url });
    scripts.set(url, sb);
    return sb;
  };
  const setupBlockOf = (text: string) => JSON.parse(/^var ASMCP_SETUP_ = (.*);$/m.exec(text)![1]!);

  /** The user pastes the personalised Code.gs (the sandbox gets its ASMCP_SETUP_ block), deploys, pastes the URL. */
  async function connectViaSetup(harness: Harness, userId: string, sb: any, url: string) {
    const p = await harness.registry.startPending(userId);
    sb.setSetup(setupBlockOf(harness.registry.personalizedBundle(p.id, userId)));
    await harness.registry.submitUrl(p.id, userId, url, "setup");
    await harness.registry.pollOnce();
    return harness.registry.getPending(p.id, userId)!;
  }

  async function mcp(base: string, token: string): Promise<Client> {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new globalThis.URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  }
  const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text;

  it("the shipped Code.gs carries the placeholder line exactly once", () => {
    expect(setupLineCount(REAL_BUNDLE)).toBe(1);
  });

  it("setup pair: the personalised Code.gs pairs with no code, and the script marks the token consumed", async () => {
    h = await makeHarness({ bundle: REAL_BUNDLE, fetchImpl: routing, realGateways: true, connection: false });
    const url = "https://script.google.com/macros/s/SETUPA/exec";
    const sb = newScript(url, "SCRIPT-A");
    const done = await connectViaSetup(h, h.ownerId, sb, url);
    expect(done).toMatchObject({ state: "connected", updated: false });
    expect(done.connection).toMatchObject({ account: "owner@example.com", scriptId: "SCRIPT-A", url, state: "connected" });

    // Calls now work through the registry against the real script.
    sb.addSpreadsheet({ id: "sales-id", name: "Sales", alias: "sales", access: "write", sheets: { S: [["a", 1]] } });
    const rt = h.registry.resolve(done.connection!.id, h.ownerId)!;
    expect((await rt.service.listSpreadsheets()).map((x) => x.alias)).toEqual(["sales"]);

    // The token is burned on the script side: a second connection attempt with the same block cannot pair.
    const p2 = await h.registry.startPending(h.ownerId);
    sb.setSetup(sb.ctx.ASMCP_SETUP_); // same block again
    await h.registry.submitUrl(p2.id, h.ownerId, url, "setup");
    await h.registry.pollOnce();
    expect(h.registry.getPending(p2.id, h.ownerId)).toMatchObject({ state: "failed" }); // proof is for p2's token, not the block's
  });

  it("wizard: spreadsheets pasted before install are on the allowlist right after pairing (no admin step), and the PAT works", async () => {
    h = await makeHarness({ bundle: REAL_BUNDLE, fetchImpl: routing, realGateways: true, connection: false });
    const url = "https://script.google.com/macros/s/WIZARD/exec";
    const sb = newScript(url, "SCRIPT-W");
    const okId = "1" + "a".repeat(43);
    const missingId = "1" + "b".repeat(43);
    sb.addSpreadsheet({ id: okId, name: "Budget", sheets: { S: [["x", 7]] } }); // exists, NOT on the allowlist yet
    const ids = parseSpreadsheetLines(`https://docs.google.com/spreadsheets/d/${okId}/edit#gid=0\n\n${missingId}\n${okId}`);

    const p = await h.registry.startPending(h.ownerId, { spreadsheets: ids, write: true });
    const block = setupBlockOf(h.registry.personalizedBundle(p.id, h.ownerId));
    expect(block.spreadsheets).toEqual([{ id: okId, access: "write" }, { id: missingId, access: "write" }]);
    sb.setSetup(block);
    await h.registry.submitUrl(p.id, h.ownerId, url, "setup");
    await h.registry.pollOnce();

    const done = h.registry.getPending(p.id, h.ownerId)!;
    expect(done).toMatchObject({ state: "connected", updated: false, allowlist: { added: 1, failed: [missingId] } });
    expect(done.pat).toMatch(/^asmcp_pat_/);
    expect(h.registry.getPending(p.id, h.ownerId)!.pat).toBeNull(); // once
    expect(h.pats.list(h.ownerId)).toHaveLength(1);

    const rt = h.registry.resolve(done.connection!.id, h.ownerId)!;
    expect((await rt.service.listSpreadsheets()).map((x) => x.alias)).toEqual(["Budget"]);
    expect((await rt.service.readRange("Budget", "S!A1:B1")).values).toEqual([["x", "7"]]);
    await rt.service.writeRange("Budget", "S!D1", [["ok"]]);

    // The auto-created PAT reaches the same script over MCP.
    const c = await mcp(h.publicUrl, done.pat!);
    const r = await c.callTool({ name: "read_range", arguments: { spreadsheet: "Budget", range: "S!A1:B1" } });
    expect(r.isError, text(r)).toBeFalsy();
    await c.close();
  });

  it("wizard: re-pairing the same script does not create another PAT, and an older script (no allowlist field) is tolerated", async () => {
    h = await makeHarness({ bundle: REAL_BUNDLE, fetchImpl: routing, realGateways: true, connection: false });
    const url = "https://script.google.com/macros/s/WIZARD2/exec";
    const sb = newScript(url, "SCRIPT-W2");
    const wizard = async () => {
      const p = await h!.registry.startPending(h!.ownerId, { spreadsheets: [], write: false });
      sb.setSetup(setupBlockOf(h!.registry.personalizedBundle(p.id, h!.ownerId)));
      await h!.registry.submitUrl(p.id, h!.ownerId, url, "setup");
      await h!.registry.pollOnce();
      return h!.registry.getPending(p.id, h!.ownerId)!;
    };
    const first = await wizard();
    expect(first.pat).toMatch(/^asmcp_pat_/);
    const second = await wizard();
    expect(second).toMatchObject({ state: "connected", updated: true, pat: null });
    expect(h.pats.list(h.ownerId)).toHaveLength(1);
  });

  it("code pairing with an already-installed script still works through the registry", async () => {
    h = await makeHarness({ bundle: REAL_BUNDLE, fetchImpl: routing, realGateways: true, connection: false });
    const url = "https://script.google.com/macros/s/CODEA/exec";
    const sb = newScript(url, "SCRIPT-CODE");
    const p = await h.registry.startPending(h.ownerId);
    const shown = (await h.registry.submitUrl(p.id, h.ownerId, url, "code")).code!;
    await h.registry.pollOnce();
    expect(h.registry.getPending(p.id, h.ownerId)!.state).toBe("waiting_script");
    sb.enterPairingCode(shown);
    await h.registry.pollOnce();
    expect(h.registry.getPending(p.id, h.ownerId)).toMatchObject({ state: "connected", connection: { scriptId: "SCRIPT-CODE" } });
  });

  it("re-pairing the same script (new deployment URL) keeps the connectionId, and the old OAuth token and PAT still work", async () => {
    h = await makeHarness({ bundle: REAL_BUNDLE, fetchImpl: routing, realGateways: true, connection: false });
    const url1 = "https://script.google.com/macros/s/DEPLOY1/exec";
    const url2 = "https://script.google.com/macros/s/DEPLOY2/exec";
    const sb = newScript(url1, "SCRIPT-A");
    scripts.set(url2, sb); // same project, a new deployment
    sb.addSpreadsheet({ id: "sales-id", name: "Sales", alias: "sales", access: "read", sheets: { S: [["a", 1]] } });

    const first = await connectViaSetup(h, h.ownerId, sb, url1);
    const connectionId = first.connection!.id;
    const { tokens } = await fullOAuth(h, "sheets.read", { username: h.username, password: h.password });
    const { token: pat } = await h.pats.create(h.ownerId, connectionId, "cli", ["sheets.read"]);
    const before = { ...h.registry.get(connectionId)! };

    scripts.delete(url1); // the old deployment is gone
    const second = await connectViaSetup(h, h.ownerId, sb, url2);
    expect(second).toMatchObject({ state: "connected", updated: true });
    expect(second.connection!.id).toBe(connectionId);
    const after = h.registry.get(connectionId)!;
    expect(after.url).toBe(url2);
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.secret).not.toBe(before.secret);
    expect(h.registry.listFor(h.ownerId)).toHaveLength(1);

    for (const token of [tokens.access_token, pat]) {
      const c = await mcp(h.publicUrl, token);
      const r = await c.callTool({ name: "list_spreadsheets", arguments: {} });
      expect(r.isError, text(r)).toBeFalsy();
      expect(JSON.parse(text(r)).spreadsheets.map((x: any) => x.alias)).toEqual(["sales"]);
      await c.close();
    }
  });

  it("two connections to two scripts are isolated: each token only ever reaches its own script", async () => {
    h = await makeHarness({ bundle: REAL_BUNDLE, fetchImpl: routing, realGateways: true, connection: false });
    const mary = await h.addMember("mary", "mary-password-1");
    const urlA = "https://script.google.com/macros/s/ONE/exec";
    const urlB = "https://script.google.com/macros/s/TWO/exec";
    // Same Google account email on both scripts: the email is never a key.
    const sbA = newScript(urlA, "SCRIPT-A", "same@example.com");
    const sbB = newScript(urlB, "SCRIPT-B", "same@example.com");
    sbA.addSpreadsheet({ id: "a-id", name: "Alpha book", alias: "alpha", access: "write", sheets: { S: [["from A"]] } });
    sbB.addSpreadsheet({ id: "b-id", name: "Beta book", alias: "beta", access: "write", sheets: { S: [["from B"]] } });

    const ca = await connectViaSetup(h, h.ownerId, sbA, urlA);
    const cb = await connectViaSetup(h, mary.id, sbB, urlB);
    expect(ca.connection!.id).not.toBe(cb.connection!.id);
    expect(ca.connection!.account).toBe(cb.connection!.account);

    const owner = await fullOAuth(h, "sheets.read sheets.write", { username: h.username, password: h.password });
    const member = await fullOAuth(h, "sheets.read sheets.write", { username: "mary", password: mary.password });
    const names = async (token: string) => {
      const c = await mcp(h!.publicUrl, token);
      const r = await c.callTool({ name: "list_spreadsheets", arguments: {} });
      await c.close();
      return JSON.parse(text(r)).spreadsheets.map((x: any) => x.alias);
    };
    expect(await names(owner.tokens.access_token)).toEqual(["alpha"]);
    expect(await names(member.tokens.access_token)).toEqual(["beta"]);

    // Writes land in the right script only.
    const c = await mcp(h.publicUrl, member.tokens.access_token);
    const w = await c.callTool({ name: "write_range", arguments: { spreadsheet: "beta", range: "S!A1", values: [["written by mary"]] } });
    expect(w.isError, text(w)).toBeFalsy();
    const cross = await c.callTool({ name: "read_range", arguments: { spreadsheet: "alpha", range: "S!A1" } });
    expect(cross.isError).toBe(true); // A's spreadsheet does not exist on B's script
    expect(sbA.sheetsFake.opened).not.toContain("b-id");
    expect(sbB.sheetsFake.opened).not.toContain("a-id");
    await c.close();
  });
});
