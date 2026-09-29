import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAT_PREFIX } from "../src/auth/pat.js";
import type { Harness } from "./helpers.js";
import { authorizeForCode, fullOAuth, makeHarness, registerClient, tokenRequest } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

async function mcpClient(token: string): Promise<Client> {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${h.publicUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text;

describe("public HTTP surface", () => {
  it("/mcp without a token -> 401 with resource_metadata header", async () => {
    const r = await fetch(`${h.publicUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${h.publicUrl}/.well-known/oauth-protected-resource"`);
  });

  it("/mcp with an invalid token -> 401; GET without token -> 401", async () => {
    const r = await fetch(`${h.publicUrl}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect((await fetch(`${h.publicUrl}/mcp`)).status).toBe(401);
  });

  it("/healthz is open", async () => {
    const r = await fetch(`${h.publicUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("serves metadata, including the root protected-resource alias", async () => {
    const as = (await (await fetch(`${h.publicUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(`${h.publicUrl}/`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${h.publicUrl}/register`);
    const prm = (await (await fetch(`${h.publicUrl}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${h.publicUrl}/mcp`);
    const prm2 = await fetch(`${h.publicUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(prm2.status).toBe(200);
  });
});

describe("OAuth metadata without a base URL", () => {
  it("returns 503 public_base_url_not_configured but /mcp still works with a PAT", async () => {
    await h.close();
    h = await makeHarness({ baseUrl: false });
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/authorize", "/token", "/register"]) {
      const r = await fetch(`${h.publicUrl}${p}`);
      expect(r.status, p).toBe(503);
      expect(((await r.json()) as { error: string }).error).toBe("public_base_url_not_configured");
    }
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "p", ["sheets.read"]);
    const c = await mcpClient(token);
    expect((await c.listTools()).tools).toHaveLength(8);
    await c.close();
    const unauth = await fetch(`${h.publicUrl}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).not.toContain("resource_metadata");
  });
});

describe("dynamic client registration", () => {
  const reg = (uris: string[]) =>
    fetch(`${h.publicUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: uris, client_name: "c", token_endpoint_auth_method: "none" }),
    });
  it("accepts https and loopback http, rejects other schemes and remote http", async () => {
    expect((await reg(["https://claude.ai/api/mcp/auth_callback"])).status).toBe(201);
    expect((await reg(["http://localhost:1234/cb"])).status).toBe(201);
    expect((await reg(["http://127.0.0.1/cb"])).status).toBe(201);
    expect((await reg(["http://evil.example.com/cb"])).status).toBe(400);
    expect((await reg(["myapp://cb"])).status).toBe(400);
    expect((await reg(["https://ok.example.com/cb", "http://evil.example.com/cb"])).status).toBe(400);
  });
  it("always registers public clients (no secret stored or returned)", async () => {
    const r = (await (await reg(["https://a.example.com/cb"])).json()) as Record<string, unknown>;
    expect(r.client_secret).toBeUndefined();
    expect(r.token_endpoint_auth_method).toBe("none");
  });
});

describe("authorization code + PKCE", () => {
  it("issues tokens for a valid code and verifier; code is single use", async () => {
    const clientId = await registerClient(h);
    const { code, verifier, redirect } = await authorizeForCode(h, clientId, "sheets.read");
    const params = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId };
    const ok = await tokenRequest(h, params);
    expect(ok.status).toBe(200);
    const t = (await ok.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number };
    expect(t.scope).toBe("sheets.read");
    expect(t.expires_in).toBe(3600);
    expect(t.access_token).not.toBe(t.refresh_token);
    const again = await tokenRequest(h, params);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier and burns the code", async () => {
    const clientId = await registerClient(h);
    const { code, verifier, redirect } = await authorizeForCode(h, clientId, undefined);
    const bad = await tokenRequest(h, { grant_type: "authorization_code", code, code_verifier: "x".repeat(50), redirect_uri: redirect, client_id: clientId });
    expect(bad.status).toBe(400);
    const retry = await tokenRequest(h, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId });
    expect(retry.status).toBe(400);
  });

  it("binds the code to redirect_uri and client_id", async () => {
    const clientId = await registerClient(h);
    const other = await registerClient(h, "http://localhost:9999/other");
    const a = await authorizeForCode(h, clientId, undefined);
    const wrongRedirect = await tokenRequest(h, { grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: "http://localhost:9999/other", client_id: clientId });
    expect(wrongRedirect.status).toBe(400);
    const b = await authorizeForCode(h, clientId, undefined);
    const wrongClient = await tokenRequest(h, { grant_type: "authorization_code", code: b.code, code_verifier: b.verifier, redirect_uri: b.redirect, client_id: other });
    expect(wrongClient.status).toBe(400);
  });

  it("defaults to both scopes when none requested; unknown scope is an error redirect", async () => {
    const { tokens } = await fullOAuth(h);
    expect(tokens.scope.split(" ").sort()).toEqual(["sheets.read", "sheets.write"]);
    const clientId = await registerClient(h);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://localhost:9999/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256", scope: "drive" });
    const r = await fetch(`${h.publicUrl}/authorize?${q}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  it("deny redirects with access_denied (no login needed)", async () => {
    const clientId = await registerClient(h);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://localhost:9999/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s" });
    const html = await (await fetch(`${h.publicUrl}/authorize?${q}`)).text();
    expect(html).toContain("Test Client");
    expect(html).toContain("localhost:9999");
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1]!;
    const r = await fetch(`${h.publicUrl}/oauth/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce, action: "deny" }) });
    const u = new URL(r.headers.get("location")!);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("s");
  });
});

describe("refresh token rotation", () => {
  const refresh = (clientId: string, rt: string, extra: Record<string, string> = {}) => tokenRequest(h, { grant_type: "refresh_token", refresh_token: rt, client_id: clientId, ...extra });

  it("rotates on every use and revokes the whole grant on reuse of a rotated token", async () => {
    const { clientId, tokens } = await fullOAuth(h);
    const r1 = await refresh(clientId, tokens.refresh_token);
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(t1.refresh_token).not.toBe(tokens.refresh_token);
    const r2 = await refresh(clientId, t1.refresh_token);
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()) as { access_token: string; refresh_token: string };
    // Replay the first (already rotated) token: rejected, and the grant dies.
    const replay = await refresh(clientId, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await refresh(clientId, t2.refresh_token)).status).toBe(400);
    await expect(h.provider.verifyAccessToken(t2.access_token)).rejects.toThrow();
    await expect(h.provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    expect(h.provider.listGrants()).toHaveLength(0);
  });

  it("cannot widen scope on refresh but can narrow it", async () => {
    const { clientId, tokens } = await fullOAuth(h, "sheets.read");
    expect((await refresh(clientId, tokens.refresh_token, { scope: "sheets.read sheets.write" })).status).toBe(400);
    const { clientId: c2, tokens: t2 } = await fullOAuth(h);
    const narrowed = await refresh(c2, t2.refresh_token, { scope: "sheets.read" });
    expect(narrowed.status).toBe(200);
    expect(((await narrowed.json()) as { scope: string }).scope).toBe("sheets.read");
  });

  it("another client cannot use the refresh token", async () => {
    const { tokens } = await fullOAuth(h);
    const other = await registerClient(h, "http://localhost:9999/other");
    expect((await refresh(other, tokens.refresh_token)).status).toBe(400);
  });

  it("revocation endpoint kills the grant when given the refresh token", async () => {
    const { clientId, tokens } = await fullOAuth(h);
    const r = await fetch(`${h.publicUrl}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }) });
    expect(r.status).toBe(200);
    await expect(h.provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("only SHA-256 hashes of tokens are persisted", async () => {
    const { tokens } = await fullOAuth(h);
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "cli", ["sheets.read"]);
    await h.store.flush();
    const raw = await readFile(h.store.filePath, "utf8");
    for (const secret of [tokens.access_token, tokens.refresh_token, token, h.password]) expect(raw).not.toContain(secret);
    expect(raw).toContain("scrypt$");
  });
});

describe("scope enforcement on MCP tools", () => {
  it("a read-only OAuth token can read but a write tool returns isError without touching the gateway", async () => {
    const { tokens } = await fullOAuth(h, "sheets.read");
    const c = await mcpClient(tokens.access_token);
    const read = await c.callTool({ name: "read_range", arguments: { spreadsheet: "sales", range: "Sheet1!A1:B1" } });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(text(read))).toEqual({ range: "Sheet1!A1:B1", values: [["a", 1]] });

    const w = await c.callTool({ name: "write_range", arguments: { spreadsheet: "sales", range: "Sheet1!A1", values: [[1]] } });
    expect(w.isError).toBe(true);
    expect(text(w)).toContain("sheets.write");
    for (const name of ["append_rows", "batch_update"]) {
      const args = name === "append_rows" ? { spreadsheet: "sales", sheet: "S", rows: [[1]] } : { spreadsheet: "sales", operations: [{ type: "clear", range: "S!A1" }] };
      expect((await c.callTool({ name, arguments: args })).isError).toBe(true);
    }
    expect(h.gateway.calls.some((x) => ["writeRange", "appendRows", "batchUpdate"].includes(x.method))).toBe(false);
    await c.close();
  });

  it("a write-scoped token writes, and tools surface gateway/validation errors as isError", async () => {
    const { tokens } = await fullOAuth(h, "sheets.read sheets.write");
    const c = await mcpClient(tokens.access_token);
    const w = await c.callTool({ name: "write_range", arguments: { spreadsheet: "sales", range: "Sheet1!A1", values: [[1, 2]] } });
    expect(w.isError).toBeFalsy();
    expect(h.gateway.calls.some((x) => x.method === "writeRange")).toBe(true);
    const ro = await c.callTool({ name: "append_rows", arguments: { spreadsheet: "Read Only Book", sheet: "S", rows: [[1]] } });
    expect(ro.isError).toBe(true);
    expect(text(ro)).toContain("WRITE_NOT_ALLOWED");
    const noSheet = await c.callTool({ name: "read_range", arguments: { spreadsheet: "sales", range: "A1:B2" } });
    expect(noSheet.isError).toBe(true);
    expect(text(noSheet)).toContain("sheet name");
    const formula = await c.callTool({ name: "write_range", arguments: { spreadsheet: "sales", range: "S!A1", values: [["=1"]] } });
    expect(text(formula)).toContain("FORMULA_NOT_ALLOWED");
    await c.close();
  });

  it("lists the 8 tools with annotations", async () => {
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "t", ["sheets.read"]);
    const c = await mcpClient(token);
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["append_rows", "batch_update", "get_metadata", "list_sheets", "list_spreadsheets", "read_range", "search", "write_range"]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.read_range!.annotations?.readOnlyHint).toBe(true);
    expect(by.write_range!.annotations?.destructiveHint).toBe(true);
    expect(by.append_rows!.annotations?.destructiveHint).toBe(false);
    expect(by.read_range!.description).toContain("sheet name");
    await c.close();
  });
});

describe("personal access tokens", () => {
  it("prefix, shown once, hashed, verified, revocable, lastUsedAt tracked", async () => {
    const { token, pat } = await h.pats.create(h.ownerId, h.connectionId, "laptop", ["sheets.read", "sheets.write"]);
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    expect(JSON.stringify(h.store.state)).not.toContain(token);
    expect(Object.keys(h.store.state.pats)[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(h.pats.list()[0]).not.toHaveProperty("token");
    expect(h.pats.list()[0]!.lastUsedAt).toBeNull();
    const info = await h.provider.verifyAccessToken(token);
    expect(info.scopes).toEqual(["sheets.read", "sheets.write"]);
    expect(h.pats.list()[0]!.lastUsedAt).not.toBeNull();
    expect(await h.pats.revoke(pat.id)).toBe(true);
    await expect(h.provider.verifyAccessToken(token)).rejects.toThrow();
    await expect(h.provider.verifyAccessToken(PAT_PREFIX + "forged")).rejects.toThrow();
  });
  it("rejects bad labels and scopes", async () => {
    await expect(h.pats.create(h.ownerId, h.connectionId, "", ["sheets.read"])).rejects.toThrow();
    await expect(h.pats.create(h.ownerId, h.connectionId, "x", ["drive"])).rejects.toThrow();
    await expect(h.pats.create(h.ownerId, h.connectionId, "x", [])).rejects.toThrow();
  });
});

describe("rate limit", () => {
  it("120/min per token, 429 after that", async () => {
    await h.close();
    h = await makeHarness();
    // rebuild a public app with a tiny limit
    const { createPublicApp } = await import("../src/http/public-app.js");
    const app = createPublicApp({ provider: h.provider, baseUrl: h.baseUrl, accounts: h.accounts, registry: h.registry, pats: h.pats, usage: h.usage, ipLimiter: h.ipLimiter, trustProxy: false, mcpRateLimitPerMin: 3 });
    const srv = app.listen(0);
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as { port: number }).port;
    const { token } = await h.pats.create(h.ownerId, h.connectionId, "t", ["sheets.read"]);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
    srv.closeAllConnections();
    srv.close();
  });
});
