import type { TunnelConfig } from "../config.js";
import type { Logger } from "../log.js";
import { parseCloudflaredUrl, parseNgrokUrl } from "./parsers.js";

/** The part of a child process the supervisor uses (a real ChildProcess fits; tests pass a fake). */
export interface TunnelChild {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit" | "error", cb: () => void): unknown;
  kill(): unknown;
}
export type SpawnFn = (bin: string, args: string[], env: Record<string, string>) => TunnelChild;

export interface TunnelSpec {
  bin: string;
  args: string[];
  /** Secrets go here, never into args (they would show in `ps`). */
  env: Record<string, string>;
  /** Values redacted from the child's output before it is logged. */
  secrets: string[];
  parseUrl: ((line: string) => string | null) | null;
}

export function tunnelSpec(cfg: TunnelConfig, port: number): TunnelSpec {
  const local = `127.0.0.1:${port}`;
  if (cfg.kind === "ngrok") {
    return {
      bin: "/usr/local/bin/ngrok",
      args: ["http", local, "--log", "stdout", "--log-format", "json", ...(cfg.domain ? ["--url", `https://${cfg.domain}`] : [])],
      env: { NGROK_AUTHTOKEN: cfg.authtoken },
      secrets: [cfg.authtoken],
      parseUrl: parseNgrokUrl,
    };
  }
  return cfg.token
    ? { bin: "/usr/local/bin/cloudflared", args: ["tunnel", "--no-autoupdate", "run"], env: { TUNNEL_TOKEN: cfg.token }, secrets: [cfg.token], parseUrl: null }
    : { bin: "/usr/local/bin/cloudflared", args: ["tunnel", "--no-autoupdate", "--url", `http://${local}`], env: {}, secrets: [], parseUrl: parseCloudflaredUrl };
}

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

/** Runs the tunnel child, restarts it with backoff when it exits, and reports the public URL. Networking only. */
export class TunnelSupervisor {
  private child: TunnelChild | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private delay = MIN_DELAY_MS;
  private lastUrl: string | null = null;

  constructor(
    private readonly opts: { spec: TunnelSpec; spawn: SpawnFn; logger: Logger; onUrl: (url: string) => void },
  ) {}

  start(): void {
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
  }

  private launch(): void {
    const { spec, spawn, logger } = this.opts;
    const startedAt = Date.now();
    const child = spawn(spec.bin, spec.args, spec.env);
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      let buf = "";
      stream?.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) this.line(l);
      });
    }
    let ended = false;
    const onEnd = (): void => {
      if (ended || this.child !== child) return; // 'error' and 'exit' can both fire; a stopped child is ignored
      ended = true;
      this.child = null;
      if (Date.now() - startedAt >= MAX_DELAY_MS) this.delay = MIN_DELAY_MS; // it ran fine for a while
      logger.warn("tunnel_exited", { restartInMs: this.delay });
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped) this.launch();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    };
    child.on("exit", onEnd);
    child.on("error", onEnd);
  }

  private line(raw: string): void {
    const { spec, logger, onUrl } = this.opts;
    let text = raw.trim();
    if (!text) return;
    for (const s of spec.secrets) text = text.split(s).join("[redacted]");
    logger.info("tunnel_output", { line: `[tunnel] ${text}` });
    const url = spec.parseUrl?.(raw) ?? null;
    if (url && url !== this.lastUrl) {
      this.lastUrl = url;
      onUrl(url);
    }
  }
}
