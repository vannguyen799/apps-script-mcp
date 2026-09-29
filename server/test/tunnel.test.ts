import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { TunnelConfig } from "../src/config.js";
import { parseCloudflaredUrl, parseNgrokUrl } from "../src/tunnel/parsers.js";
import type { SpawnFn, TunnelChild } from "../src/tunnel/supervisor.js";
import { TunnelSupervisor, tunnelSpec } from "../src/tunnel/supervisor.js";
import type { Harness } from "./helpers.js";
import { makeHarness } from "./helpers.js";

describe("URL parsers", () => {
  it("cloudflared: reads the quick-tunnel URL from the banner box", () => {
    expect(parseCloudflaredUrl("2026-09-29T13:00:01Z INF |  https://quiet-river-fox-lamp.trycloudflare.com                                |")).toBe(
      "https://quiet-river-fox-lamp.trycloudflare.com",
    );
  });
  it("cloudflared: ignores other URLs, including api.trycloudflare.com in an error", () => {
    expect(parseCloudflaredUrl("2026-09-29T13:00:00Z INF Thank you for trying Cloudflare Tunnel. https://www.cloudflare.com/website-terms/")).toBeNull();
    expect(parseCloudflaredUrl('2026-09-29T13:00:00Z ERR Failed to request quick Tunnel error="Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: i/o timeout"')).toBeNull();
    expect(parseCloudflaredUrl("2026-09-29T13:00:02Z INF Registered tunnel connection connIndex=0 location=sin01")).toBeNull();
  });
  it("ngrok: reads url from the 'started tunnel' JSON log line", () => {
    const line = '{"addr":"http://127.0.0.1:8787","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-09-29T13:00:01Z","url":"https://My-Name.ngrok-free.app"}';
    expect(parseNgrokUrl(line)).toBe("https://my-name.ngrok-free.app");
  });
  it("ngrok: ignores other lines, non-JSON and non-https urls", () => {
    expect(parseNgrokUrl('{"lvl":"info","msg":"client session established","obj":"tunnels.session","t":"2026-09-29T13:00:00Z"}')).toBeNull();
    expect(parseNgrokUrl('{"lvl":"info","msg":"started tunnel","url":"tcp://0.tcp.ngrok.io:12345"}')).toBeNull();
    expect(parseNgrokUrl("ERR_NGROK_105 authentication failed")).toBeNull();
  });
});

class FakeChild extends EventEmitter implements TunnelChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("TunnelSupervisor", () => {
  let children: FakeChild[];
  let spawned: Array<{ bin: string; args: string[]; env: Record<string, string> }>;
  let logs: string[];
  const spawn: SpawnFn = (bin, args, env) => {
    spawned.push({ bin, args, env });
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const make = (cfg: TunnelConfig, onUrl: (u: string) => void = () => {}) =>
    new TunnelSupervisor({ spec: tunnelSpec(cfg, 8787), spawn, logger: createLogger("debug", (l) => logs.push(l)), onUrl });

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    spawned = [];
    logs = [];
  });
  afterEach(() => vi.useRealTimers());

  it("builds the documented commands and keeps tokens out of argv", () => {
    const cf = tunnelSpec({ kind: "cloudflare", token: undefined }, 8787);
    expect(cf.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8787"]);
    const named = tunnelSpec({ kind: "cloudflare", token: "cf-secret-token" }, 8787);
    expect(named.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(named.env).toEqual({ TUNNEL_TOKEN: "cf-secret-token" });
    const ng = tunnelSpec({ kind: "ngrok", authtoken: "ng-secret-token", domain: "me.ngrok-free.app" }, 8787);
    expect(ng.args).toEqual(["http", "127.0.0.1:8787", "--log", "stdout", "--log-format", "json", "--url", "https://me.ngrok-free.app"]);
    expect(ng.env).toEqual({ NGROK_AUTHTOKEN: "ng-secret-token" });
    for (const s of [named, ng]) expect(s.args.join(" ")).not.toMatch(/secret-token/);
    expect(tunnelSpec({ kind: "ngrok", authtoken: "t", domain: undefined }, 9000).args).toEqual(["http", "127.0.0.1:9000", "--log", "stdout", "--log-format", "json"]);
  });

  it("reports the URL once, across split chunks and both streams", () => {
    const urls: string[] = [];
    const sup = make({ kind: "cloudflare", token: undefined }, (u) => urls.push(u));
    sup.start();
    const banner = "INF |  https://a-b-c-d.trycloudflare.com  |\n";
    children[0]!.stderr.emit("data", Buffer.from(banner.slice(0, 20)));
    children[0]!.stderr.emit("data", Buffer.from(banner.slice(20)));
    children[0]!.stdout.emit("data", banner);
    expect(urls).toEqual(["https://a-b-c-d.trycloudflare.com"]);
    sup.stop();
  });

  it("redacts token values in logged lines", () => {
    const sup = make({ kind: "ngrok", authtoken: "2abcSECRETtoken", domain: undefined });
    sup.start();
    children[0]!.stdout.emit("data", '{"lvl":"info","msg":"using authtoken 2abcSECRETtoken twice 2abcSECRETtoken"}\n');
    const all = logs.join("\n");
    expect(all).toContain("[tunnel]");
    expect(all).toContain("[redacted]");
    expect(all).not.toContain("2abcSECRETtoken");
    sup.stop();
  });

  it("restarts with 1s doubling backoff capped at 60s", () => {
    const sup = make({ kind: "cloudflare", token: "t" });
    sup.start();
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    delays.forEach((d, i) => {
      expect(spawned).toHaveLength(i + 1);
      children[i]!.emit("exit");
      vi.advanceTimersByTime(d - 1);
      expect(spawned).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(spawned).toHaveLength(i + 2);
    });
    sup.stop();
  });

  it("resets the backoff after a child that lived for a while; a double error+exit schedules one restart", () => {
    const sup = make({ kind: "cloudflare", token: "t" });
    sup.start();
    children[0]!.emit("exit");
    vi.advanceTimersByTime(1000);
    children[1]!.emit("error");
    children[1]!.emit("exit");
    vi.advanceTimersByTime(2000);
    expect(spawned).toHaveLength(3);
    vi.advanceTimersByTime(61_000);
    children[2]!.emit("exit");
    vi.advanceTimersByTime(1000);
    expect(spawned).toHaveLength(4);
    sup.stop();
  });

  it("stop() kills the child and cancels a pending restart", () => {
    const sup = make({ kind: "cloudflare", token: "t" });
    sup.start();
    sup.stop();
    expect(children[0]!.killed).toBe(true);
    children[0]!.emit("exit");
    vi.advanceTimersByTime(120_000);
    expect(spawned).toHaveLength(1);
    const sup2 = make({ kind: "cloudflare", token: "t" });
    sup2.start();
    children[1]!.emit("exit");
    sup2.stop();
    vi.advanceTimersByTime(120_000);
    expect(spawned).toHaveLength(2);
  });
});

describe("tunnel config (DESIGN.md 11)", () => {
  it("is off by default and for TUNNEL=off; trust proxy stays as configured", () => {
    expect(loadConfig({}).tunnel).toBeUndefined();
    expect(loadConfig({ TUNNEL: "off" }).tunnel).toBeUndefined();
    expect(loadConfig({ TUNNEL: "" }).trustProxy).toBe(false);
  });
  it("rejects an unknown TUNNEL value", () => {
    expect(() => loadConfig({ TUNNEL: "frp" })).toThrow(/TUNNEL must be off\|cloudflare\|ngrok/);
  });
  it("cloudflare quick tunnel needs nothing; with a token it needs PUBLIC_BASE_URL", () => {
    expect(loadConfig({ TUNNEL: "cloudflare" }).tunnel).toEqual({ kind: "cloudflare", token: undefined });
    expect(() => loadConfig({ TUNNEL: "cloudflare", CLOUDFLARE_TUNNEL_TOKEN: "tok" })).toThrow(/PUBLIC_BASE_URL/);
    expect(loadConfig({ TUNNEL: "cloudflare", CLOUDFLARE_TUNNEL_TOKEN: "tok", PUBLIC_BASE_URL: "https://mcp.example.com" }).tunnel).toEqual({ kind: "cloudflare", token: "tok" });
  });
  it("ngrok needs NGROK_AUTHTOKEN, and NGROK_DOMAIN must be a bare hostname", () => {
    expect(() => loadConfig({ TUNNEL: "ngrok" })).toThrow(/NGROK_AUTHTOKEN/);
    expect(loadConfig({ TUNNEL: "ngrok", NGROK_AUTHTOKEN: "a", NGROK_DOMAIN: "my-name.ngrok-free.app" }).tunnel).toEqual({ kind: "ngrok", authtoken: "a", domain: "my-name.ngrok-free.app" });
    expect(loadConfig({ TUNNEL: "ngrok", NGROK_AUTHTOKEN: "a" }).tunnel).toEqual({ kind: "ngrok", authtoken: "a", domain: undefined });
    for (const bad of ["https://x.ngrok-free.app", "x.ngrok-free.app/path", "x.ngrok-free.app:443", "localhost", "-x.ngrok-free.app"]) {
      expect(() => loadConfig({ TUNNEL: "ngrok", NGROK_AUTHTOKEN: "a", NGROK_DOMAIN: bad }), bad).toThrow(/NGROK_DOMAIN/);
    }
  });
  it("trusts loopback with a tunnel unless TRUST_PROXY is set", () => {
    expect(loadConfig({ TUNNEL: "cloudflare" }).trustProxy).toBe("loopback");
    expect(loadConfig({ TUNNEL: "cloudflare", TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ TUNNEL: "cloudflare", TRUST_PROXY: "false" }).trustProxy).toBe(false);
  });
});

describe("runtime base URL from the tunnel", () => {
  let h: Harness;
  afterEach(async () => h.close());
  const meta = async () => (await (await fetch(`${h.publicUrl}/.well-known/oauth-protected-resource`)).json()) as { resource: string };

  it("precedence: env > tunnel > saved UI value; tunnel URL is not persisted", async () => {
    h = await makeHarness({ baseUrl: false });
    expect(h.baseUrl.get()).toBeUndefined();
    await h.baseUrl.set("https://ui.example.com");
    expect(h.baseUrl.source()).toBe("ui");
    h.baseUrl.setTunnelUrl("https://t.trycloudflare.com");
    expect(h.baseUrl.get()).toBe("https://t.trycloudflare.com");
    expect(h.baseUrl.source()).toBe("tunnel");
    expect(h.baseUrl.mcpEndpoint()).toBe("https://t.trycloudflare.com/mcp");
    expect(JSON.stringify(h.store.state)).not.toContain("trycloudflare");
    h.baseUrl.setTunnelUrl(undefined);
    expect(h.baseUrl.get()).toBe("https://ui.example.com");
    await h.close();
    h = await makeHarness({ envBase: "https://env.example.com" });
    h.baseUrl.setTunnelUrl("https://t.trycloudflare.com");
    expect(h.baseUrl.get()).toBe("https://env.example.com");
    expect(h.baseUrl.source()).toBe("env");
  });

  it("OAuth metadata follows a tunnel URL change", async () => {
    h = await makeHarness({ baseUrl: false });
    expect((await fetch(`${h.publicUrl}/.well-known/oauth-protected-resource`)).status).toBe(503);
    h.baseUrl.setTunnelUrl("https://one.trycloudflare.com");
    expect((await meta()).resource).toBe("https://one.trycloudflare.com/mcp");
    const as = async () => ((await (await fetch(`${h.publicUrl}/.well-known/oauth-authorization-server`)).json()) as { issuer: string }).issuer;
    expect(await as()).toBe("https://one.trycloudflare.com/");
    h.baseUrl.setTunnelUrl("https://two.trycloudflare.com");
    expect((await meta()).resource).toBe("https://two.trycloudflare.com/mcp");
    expect(await as()).toBe("https://two.trycloudflare.com/");
  });
});
