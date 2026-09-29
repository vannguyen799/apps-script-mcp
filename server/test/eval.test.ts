import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { AppsScriptClient } from "../src/adapters/apps-script/client.js";
import { AppsScriptGateway } from "../src/adapters/apps-script/gateway.js";
import { EVAL_TIMEOUT_MS } from "../src/core/script/evaluator.js";
import { DEFAULT_SCOPES, SCOPE_EVAL, SUPPORTED_SCOPES } from "../src/auth/scopes.js";
import { renderConsentPage } from "../src/auth/consent-page.js";
import { GatewayError } from "../src/core/sheets/gateway.js";
import { createPublicApp } from "../src/http/public-app.js";
import type { Logger } from "../src/log.js";
import type { Harness } from "./helpers.js";
import { accountLogin, authorizeForCode, fullOAuth, makeHarness, pkcePair, tokenRequest } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function mcpClient(base: string, token: string): Promise<Client> {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text;

describe("script.eval scope: opt-in only", () => {
  it("DEFAULT_SCOPES is still exactly sheets.read + sheets.write, while script.eval is supported", () => {
    expect(DEFAULT_SCOPES).toEqual(["sheets.read", "sheets.write"]);
    expect(SCOPE_EVAL).toBe("script.eval");
    expect([...SUPPORTED_SCOPES]).toContain("script.eval");
  });

  it("an OAuth client requesting no scope gets the defaults, even if it registered a scope containing script.eval (DCR)", async () => {
    h = await makeHarness({ withEvaluator: true });
    const reg = await fetch(`${h.publicUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/cb"],
        client_name: "Greedy",
        token_endpoint_auth_method: "none",
        scope: "sheets.read sheets.write script.eval",
      }),
    });
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const { code, verifier, redirect } = await authorizeForCode(h, clientId, undefined);
    const r = await tokenRequest(h, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId });
    expect(r.status).toBe(200);
    const tokens = (await r.json()) as { scope: string; access_token: string };
    expect(tokens.scope.split(" ").sort()).toEqual(["sheets.read", "sheets.write"]);
    const info = await h.provider.verifyAccessToken(tokens.access_token);
    expect(info.scopes).not.toContain("script.eval");
  });

  it("OAuth metadata does not advertise script.eval (clients may request every advertised scope)", async () => {
    h = await makeHarness();
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const j = (await (await fetch(`${h.publicUrl}${path}`)).json()) as { scopes_supported?: string[] };
      expect(j.scopes_supported, path).toEqual(["sheets.read", "sheets.write"]);
    }
  });

  it("script.eval is granted only when requested explicitly, and the refresh cannot add it", async () => {
    h = await makeHarness({ withEvaluator: true });
    const { clientId, tokens } = await fullOAuth(h, "sheets.read script.eval");
    expect(tokens.scope.split(" ").sort()).toEqual(["script.eval", "sheets.read"]);
    const widen = await tokenRequest(h, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, scope: "sheets.read sheets.write script.eval" });
    expect(widen.status).toBe(400);

    const plain = await fullOAuth(h, "sheets.read sheets.write");
    expect(plain.tokens.scope).not.toContain("script.eval");
  });

  it("PATs: script.eval is opt-in; a PAT without it does not gain it", async () => {
    h = await makeHarness();
    const { token: plain } = await h.pats.create(h.ownerId, h.connectionId, "plain", ["sheets.read", "sheets.write"]);
    const { token: evalPat } = await h.pats.create(h.ownerId, h.connectionId, "eval", ["sheets.read", "script.eval"]);
    expect((await h.provider.verifyAccessToken(plain)).scopes).toEqual(["sheets.read", "sheets.write"]);
    expect((await h.provider.verifyAccessToken(evalPat)).scopes).toEqual(["sheets.read", "script.eval"]);
    await expect(h.pats.create(h.ownerId, h.connectionId, "bad", ["script.exec"])).rejects.toThrow(/script\.eval/);
  });

  it("the account API creates a PAT with script.eval when asked, bound to the user's connection", async () => {
    h = await makeHarness();
    const { cookie, csrf } = await accountLogin(h, h.username, h.password);
    const r = await fetch(`${h.publicUrl}/account/api/pats`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ label: "eval", connectionId: h.connectionId, scopes: ["script.eval"] }),
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { pat: { scopes: string[]; connectionId: string } }).pat).toMatchObject({ scopes: ["script.eval"], connectionId: h.connectionId });
  });
});

describe("consent page", () => {
  const view = (scopes: string[]) => ({ clientName: "C", redirectHost: "localhost:9999", scopes, nonce: "n", styleNonce: "s", action: "/oauth/consent", login: {} });

  it("shows a red warning when script.eval is requested, and not otherwise", () => {
    const withEval = renderConsentPage(view(["sheets.read", "script.eval"]));
    expect(withEval).toContain("script.eval");
    expect(withEval).toContain('class="danger"');
    expect(withEval).toContain("prompt injection");
    expect(withEval).toContain("KHÔNG áp dụng");
    const plain = renderConsentPage(view(["sheets.read", "sheets.write"]));
    expect(plain).not.toContain("script.eval");
    expect(plain).not.toContain('class="danger"');
    expect(plain).not.toContain("prompt injection");
  });

  it("the live /authorize page carries the warning only for a script.eval request", async () => {
    h = await makeHarness({ withEvaluator: true });
    const reg = await fetch(`${h.publicUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"], client_name: "Test Client", token_endpoint_auth_method: "none" }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const page = async (scope?: string) => {
      const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://localhost:9999/cb", code_challenge: pkcePair().challenge, code_challenge_method: "S256" });
      if (scope) q.set("scope", scope);
      return (await fetch(`${h!.publicUrl}/authorize?${q}`)).text();
    };
    const asked = await page("sheets.read script.eval");
    expect(asked).toContain('class="danger"');
    expect(asked).toContain("<code>script.eval</code>");
    expect(await page()).not.toContain("script.eval");
    expect(await page("sheets.read")).not.toContain('class="danger"');
  });
});

describe("run_apps_script tool", () => {
  it("is rejected without the script.eval scope (OAuth token and PAT) and never reaches the evaluator", async () => {
    h = await makeHarness({ withEvaluator: true });
    const { tokens } = await fullOAuth(h); // default scopes
    const { token: pat } = await h.pats.create(h.ownerId, h.connectionId, "sheets only", ["sheets.read", "sheets.write"]);
    for (const token of [tokens.access_token, pat]) {
      const c = await mcpClient(h.publicUrl, token);
      const r = await c.callTool({ name: "run_apps_script", arguments: { code: "return 1;" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("INSUFFICIENT_SCOPE");
      expect(text(r)).toContain("script.eval");
      await c.close();
    }
    expect(h.evaluator.calls).toEqual([]);
  });

  it("is allowed with the scope: passes code and args, returns value, logs and duration", async () => {
    h = await makeHarness({ withEvaluator: true });
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "eval", ["script.eval"]);
    h.evaluator.handler = async (_code, args) => ({ value: { echo: args }, logs: ["l1", "l2"], durationMs: 12 });
    const c = await mcpClient(h.publicUrl, token);
    const r = await c.callTool({ name: "run_apps_script", arguments: { code: "return args;", args: { a: [1, 2] } } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ value: { echo: { a: [1, 2] } }, logs: ["l1", "l2"], durationMs: 12 });
    expect(h.evaluator.calls).toEqual([{ code: "return args;", args: { a: [1, 2] } }]);

    await c.callTool({ name: "run_apps_script", arguments: { code: "return 1;" } });
    expect(h.evaluator.calls[1]).toEqual({ code: "return 1;", args: undefined });

    // Schema limits are enforced before the evaluator.
    const empty = await c.callTool({ name: "run_apps_script", arguments: { code: "" } }).catch((e: Error) => e);
    const tooLong = await c.callTool({ name: "run_apps_script", arguments: { code: "x".repeat(100_001) } }).catch((e: Error) => e);
    for (const r2 of [empty, tooLong]) expect((r2 as { isError?: boolean }).isError === true || r2 instanceof Error).toBe(true);
    expect(h.evaluator.calls).toHaveLength(2);
    await c.close();
  });

  it("is registered only when an evaluator is available", async () => {
    h = await makeHarness(); // no evaluator
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "eval", ["sheets.read", "script.eval"]);
    let c = await mcpClient(h.publicUrl, token);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("run_apps_script");
    const r = await c.callTool({ name: "run_apps_script", arguments: { code: "return 1;" } }).catch((e: Error) => e);
    expect((r as { isError?: boolean }).isError === true || r instanceof Error).toBe(true);
    await c.close();
    await h.close();

    h = await makeHarness({ withEvaluator: true });
    const { token: t2 } = await h.pats.create(h.ownerId, h.connectionId, "eval", ["script.eval"]);
    c = await mcpClient(h.publicUrl, t2);
    const tools = (await c.listTools()).tools;
    expect(tools).toHaveLength(9);
    const tool = tools.find((t) => t.name === "run_apps_script")!;
    expect(tool.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true, readOnlyHint: false });
    for (const needle of ["BODY of a function", "args", "log(", "return", "6 minutes", "EVAL_DISABLED", "allowlist", "prompt injection"]) {
      expect(tool.description, needle).toContain(needle);
    }
    expect(JSON.stringify(tool.inputSchema)).toContain('"code"');
    await c.close();
  });

  it("maps EVAL_DISABLED to a message saying where to enable it, and EVAL_ERROR to its message plus logs", async () => {
    h = await makeHarness({ withEvaluator: true });
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "eval", ["script.eval"]);
    const c = await mcpClient(h.publicUrl, token);
    h.evaluator.handler = async () => {
      throw new GatewayError("EVAL_DISABLED", "Script evaluation is disabled.");
    };
    const off = await c.callTool({ name: "run_apps_script", arguments: { code: "return 1;" } });
    expect(off.isError).toBe(true);
    expect(text(off)).toContain("EVAL_DISABLED");
    expect(text(off)).toContain("Chạy Apps Script (nâng cao)");
    expect(text(off)).toContain("owner");

    h.evaluator.handler = async () => {
      throw new GatewayError("EVAL_ERROR", "TypeError: x is not a function", ["step 1", "step 2"]);
    };
    const err = await c.callTool({ name: "run_apps_script", arguments: { code: "x()" } });
    expect(err.isError).toBe(true);
    expect(text(err)).toContain("EVAL_ERROR: TypeError: x is not a function");
    expect(text(err)).toContain("step 1\nstep 2");

    h.evaluator.handler = async () => {
      throw new GatewayError("LIMIT_EXCEEDED", "Return value exceeds 4194304 characters");
    };
    expect(text(await c.callTool({ name: "run_apps_script", arguments: { code: "x" } }))).toContain("LIMIT_EXCEEDED");
    await c.close();
  });

  it("logs only the tool name, duration and result code: never code, args, values or eval error messages", async () => {
    h = await makeHarness({ withEvaluator: true });
    const lines: Array<{ level: string; event: string; fields?: unknown }> = [];
    const logger: Logger = {
      debug: (event, fields) => lines.push({ level: "debug", event, fields }),
      info: (event, fields) => lines.push({ level: "info", event, fields }),
      warn: (event, fields) => lines.push({ level: "warn", event, fields }),
      error: (event, fields) => lines.push({ level: "error", event, fields }),
    };
    const app = createPublicApp({ provider: h.provider, baseUrl: h.baseUrl, accounts: h.accounts, registry: h.registry, pats: h.pats, ipLimiter: h.ipLimiter, evaluatorAvailable: true, trustProxy: false, logger });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "eval", ["script.eval"]);
    const c = await mcpClient(base, token);
    await c.callTool({ name: "run_apps_script", arguments: { code: "return 'CODE-SECRET';", args: { k: "ARG-SECRET" } } });
    h.evaluator.handler = async () => {
      throw new GatewayError("EVAL_ERROR", "Error: ERR-SECRET", ["LOG-SECRET"]);
    };
    await c.callTool({ name: "run_apps_script", arguments: { code: "throw 1;" } });
    await c.close();
    srv.closeAllConnections();
    srv.close();

    const calls = lines.filter((l) => l.event === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fields).toMatchObject({ tool: "run_apps_script", resultCode: "OK" });
    expect(calls[1]!.fields).toMatchObject({ tool: "run_apps_script", resultCode: "EVAL_ERROR" });
    const all = JSON.stringify(lines);
    for (const secret of ["CODE-SECRET", "ARG-SECRET", "ERR-SECRET", "LOG-SECRET", "throw 1"]) expect(all).not.toContain(secret);
  });
});

describe("connection registry: eval state", () => {
  it("reports evalEnabled from the last ping (null when unknown) and forgets it when the connection is removed", async () => {
    h = await makeHarness();
    const gw = h.gateway;
    const id = h.connectionId;
    const ping = (evalEnabled?: boolean) => () => Promise.resolve({ account: "me@example.com", backendVersion: "1", spreadsheetCount: 0, ...(evalEnabled === undefined ? {} : { evalEnabled }) });
    expect(h.registry.getView(id)!.evalEnabled).toBeNull();
    gw.ping = ping(true);
    expect((await h.registry.ping(id)).evalEnabled).toBe(true);
    gw.ping = ping(false);
    expect((await h.registry.ping(id)).evalEnabled).toBe(false);
    gw.ping = () => Promise.reject(new GatewayError("INTERNAL", "down"));
    expect((await h.registry.ping(id)).evalEnabled).toBeNull();
    gw.ping = ping(); // an older script
    expect((await h.registry.ping(id)).evalEnabled).toBeNull();
    gw.ping = ping(true);
    await h.registry.ping(id);
    expect(await h.registry.remove(id, h.ownerId)).toBe(true);
    expect(h.registry.getView(id)).toBeUndefined();
  });

  it("its evaluator fails cleanly when the backend cannot evaluate, and a removed connection resolves to nothing", async () => {
    h = await makeHarness(); // plain FakeGateway has no evaluate()
    const rt = h.registry.resolve(h.connectionId, h.ownerId)!;
    await expect(rt.evaluator.evaluate("return 1")).rejects.toMatchObject({ code: "UNKNOWN_ACTION" });
    await h.registry.remove(h.connectionId, h.ownerId);
    expect(h.registry.resolve(h.connectionId, h.ownerId)).toBeUndefined();
  });
});

describe("Apps Script client and eval errors", () => {
  const client = (body: unknown) =>
    new AppsScriptClient({
      url: "https://script.google.com/macros/s/AK/exec",
      instanceId: "i",
      secret: "s".repeat(43),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        void init;
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });

  it("an UNSIGNED EVAL_ERROR is truncated and never carries logs (only verified responses may)", async () => {
    const unsigned = { body: JSON.stringify({ ok: false, error: { code: "EVAL_ERROR", message: "m".repeat(1000), logs: ["forged"] } }), sig: null };
    const e = await client(unsigned).call("script.eval", { code: "x" }).catch((x: GatewayError) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect((e as GatewayError).code).toBe("EVAL_ERROR");
    expect((e as GatewayError).message).toHaveLength(300);
    expect((e as GatewayError).logs).toBeUndefined();
  });

  it("the gateway gives script.eval the long timeout, sends args only when given, and checks the code size", async () => {
    const seen: Array<{ action: string; params: unknown; opts: unknown }> = [];
    const gw = new AppsScriptGateway({
      call: async (action, params, opts) => {
        seen.push({ action, params, opts });
        return { value: undefined, logs: ["a", 2], durationMs: 5 };
      },
    });
    expect(await gw.evaluate("return 1;")).toEqual({ value: null, logs: ["a", "2"], durationMs: 5 });
    await gw.evaluate("return args;", { x: 1 });
    expect(seen[0]).toEqual({ action: "script.eval", params: { code: "return 1;" }, opts: { timeoutMs: EVAL_TIMEOUT_MS } });
    expect(seen[1]!.params).toEqual({ code: "return args;", args: { x: 1 } });
    expect(EVAL_TIMEOUT_MS).toBeGreaterThan(6 * 60_000);
    await expect(gw.evaluate("x".repeat(100_001))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(seen).toHaveLength(2);
    const bad = new AppsScriptGateway({ call: async () => ({ value: 1 }) });
    await expect(bad.evaluate("return 1;")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
