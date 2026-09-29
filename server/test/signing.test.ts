import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppsScriptClient } from "../src/adapters/apps-script/client.js";
import { AppsScriptGateway } from "../src/adapters/apps-script/gateway.js";
import {
  APPS_SCRIPT_URL_RE,
  PAIRING_ALPHABET,
  attemptPair,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
} from "../src/adapters/apps-script/pairing.js";
import { hmacHex, newNonce, newSecret, signCall, signPairAck, signResponse } from "../src/adapters/apps-script/signing.js";
import { GatewayError } from "../src/core/sheets/gateway.js";

const SECRET = "A".repeat(43);
const INSTANCE = "11111111-2222-3333-4444-555555555555";

const manual = (secret: string, msg: string) => createHmac("sha256", Buffer.from(secret, "utf8")).update(msg, "utf8").digest("hex");

describe("signing vectors", () => {
  it("call signature equals a manual HMAC over the spec'd message", () => {
    const payload = '{"action":"ping","params":{}}';
    const expected = manual(SECRET, `v1\ncall\n${INSTANCE}\n1700000000000\nNONCENONCENONCENONCE12\n${payload}`);
    expect(signCall(SECRET, INSTANCE, 1700000000000, "NONCENONCENONCENONCE12", payload)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the UTF-8 bytes of the secret string, not its base64url decoding", () => {
    const decodedKey = createHmac("sha256", Buffer.from(SECRET, "base64url")).update("m").digest("hex");
    expect(hmacHex(SECRET, "m")).not.toBe(decodedKey);
    expect(hmacHex(SECRET, "m")).toBe(manual(SECRET, "m"));
  });

  it("response and pair-ack messages", () => {
    expect(signResponse(SECRET, "n", "{}")).toBe(manual(SECRET, "v1\nresp\nn\n{}"));
    expect(signPairAck(SECRET, INSTANCE, 42)).toBe(manual(SECRET, `v1\npair-ack\n${INSTANCE}\n42`));
  });

  it("generates 43-char secrets and 22-char nonces matching the wire regex", () => {
    expect(newSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

/** Fake Apps Script: verifies the request signature then answers like the real thing. */
function fakeScript(mode: "good" | "unsigned-data" | "bad-sig" | "unsigned-error" | "wrong-nonce" | "signed-error") {
  const seen: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>)["content-type"]).toBe("text/plain;charset=utf-8");
    expect(init.redirect).toBe("follow");
    const req = JSON.parse(init.body as string) as { instanceId: string; ts: number; nonce: string; payload: string; sig: string };
    seen.push(req);
    expect(req.sig).toBe(manual(SECRET, `v1\ncall\n${req.instanceId}\n${req.ts}\n${req.nonce}\n${req.payload}`));
    const ok = JSON.stringify({ ok: true, result: { account: "me@example.com", scriptVersion: 3, spreadsheetCount: 2 } });
    let env: { body: string; sig: string | null };
    switch (mode) {
      case "good":
        env = { body: ok, sig: manual(SECRET, `v1\nresp\n${req.nonce}\n${ok}`) };
        break;
      case "unsigned-data":
        env = { body: ok, sig: null };
        break;
      case "bad-sig":
        env = { body: ok, sig: manual("B".repeat(43), `v1\nresp\n${req.nonce}\n${ok}`) };
        break;
      case "wrong-nonce":
        env = { body: ok, sig: manual(SECRET, `v1\nresp\nOTHERNONCE\n${ok}`) };
        break;
      case "unsigned-error": {
        const b = JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED", message: "nope" } });
        env = { body: b, sig: null };
        break;
      }
      case "signed-error": {
        const b = JSON.stringify({ ok: false, error: { code: "SPREADSHEET_NOT_AUTHORIZED", message: "not allowed" } });
        env = { body: b, sig: manual(SECRET, `v1\nresp\n${req.nonce}\n${b}`) };
        break;
      }
    }
    return new Response(JSON.stringify(env), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const client = (fetchImpl: typeof fetch) => new AppsScriptClient({ url: "https://script.google.com/macros/s/abc/exec", instanceId: INSTANCE, secret: SECRET, fetchImpl });

describe("AppsScriptClient response verification", () => {
  it("returns data for a correctly signed response", async () => {
    const s = fakeScript("good");
    const r = await new AppsScriptGateway(client(s.fetchImpl)).ping();
    expect(r).toEqual({ account: "me@example.com", backendVersion: "3", spreadsheetCount: 2 });
    expect(JSON.parse(s.seen[0]!.payload as string)).toEqual({ action: "ping", params: {} });
  });

  it("never treats an unsigned ok response as data", async () => {
    await expect(client(fakeScript("unsigned-data").fetchImpl).call("ping")).rejects.toMatchObject({ code: "INTERNAL", message: expect.stringContaining("unsigned") });
  });

  it("rejects a badly signed response and one signed for another nonce", async () => {
    await expect(client(fakeScript("bad-sig").fetchImpl).call("ping")).rejects.toThrow(/invalid signature/);
    await expect(client(fakeScript("wrong-nonce").fetchImpl).call("ping")).rejects.toThrow(/invalid signature/);
  });

  it("surfaces an unsigned error code as that error", async () => {
    await expect(client(fakeScript("unsigned-error").fetchImpl).call("ping")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("surfaces a signed error", async () => {
    const e = await client(fakeScript("signed-error").fetchImpl).call("x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect((e as GatewayError).code).toBe("SPREADSHEET_NOT_AUTHORIZED");
  });

  it("maps a non-JSON page to a clear error", async () => {
    const f = (async () => new Response("<html>login</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(client(f).call("ping")).rejects.toThrow(/non-JSON/);
  });
});

describe("pairing", () => {
  it("code alphabet, format and normalization", () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairingCode();
      expect(c).toHaveLength(8);
      for (const ch of c) expect(PAIRING_ALPHABET).toContain(ch);
    }
    expect(formatPairingCode("ABCD2345")).toBe("ABCD-2345");
    expect(normalizePairingCode(" abcd-2345 ")).toBe("ABCD2345");
    expect(APPS_SCRIPT_URL_RE.test("https://script.google.com/macros/s/AKfy-1_x/exec")).toBe(true);
    expect(APPS_SCRIPT_URL_RE.test("https://script.google.com/macros/s/AKfy/dev")).toBe(false);
    expect(APPS_SCRIPT_URL_RE.test("http://script.google.com/macros/s/AKfy/exec")).toBe(false);
  });

  const pairFetch = (proofFor: (secret: string, id: string, ts: number) => string, errorCode?: string) =>
    (async (_u: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string) as { kind: string; instanceId: string; ts: number; secret: string; pairingCode: string };
      expect(req.kind).toBe("pair");
      expect(req.pairingCode).toBe("ABCD2345");
      const body = errorCode
        ? { ok: false, error: { code: errorCode, message: "x" } }
        : { ok: true, result: { account: "me@example.com", proof: proofFor(req.secret, req.instanceId, req.ts) } };
      return new Response(JSON.stringify({ body: JSON.stringify(body), sig: null }), { status: 200 });
    }) as unknown as typeof fetch;

  const base = { url: "https://script.google.com/macros/s/a/exec", instanceId: INSTANCE, instanceLabel: "t", code: "ABCD2345", secret: SECRET };

  it("accepts a valid proof", async () => {
    const r = await attemptPair({ ...base, fetchImpl: pairFetch((s, i, t) => manual(s, `v1\npair-ack\n${i}\n${t}`)) });
    expect(r).toEqual({ status: "paired", account: "me@example.com" });
  });

  it("rejects a wrong proof and a proof for another timestamp", async () => {
    expect((await attemptPair({ ...base, fetchImpl: pairFetch(() => "0".repeat(64)) })).status).toBe("bad_proof");
    expect((await attemptPair({ ...base, fetchImpl: pairFetch((s, i, t) => manual(s, `v1\npair-ack\n${i}\n${t + 1}`)) })).status).toBe("bad_proof");
  });

  it("maps PAIRING_NOT_READY and PAIRING_INVALID", async () => {
    expect((await attemptPair({ ...base, fetchImpl: pairFetch(() => "", "PAIRING_NOT_READY") })).status).toBe("not_ready");
    expect((await attemptPair({ ...base, fetchImpl: pairFetch(() => "", "PAIRING_INVALID") })).status).toBe("invalid");
  });
});
