import { normalizeBaseUrl } from "./util/base-url.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** DESIGN.md 11: the built-in tunnel, undefined when TUNNEL is unset or "off". */
export type TunnelConfig = { kind: "cloudflare"; token: string | undefined } | { kind: "ngrok"; authtoken: string; domain: string | undefined };

export interface Config {
  /** DESIGN.md 13: the single HTTP port (MCP, OAuth, /account, /healthz). */
  port: number;
  dataDir: string;
  /** Normalised origin from PUBLIC_BASE_URL, if set (then /account cannot change it). */
  publicBaseUrl: string | undefined;
  logLevel: LogLevel;
  trustProxy: boolean | number | string;
  /** The shipped single-file Apps Script bundle (Code.gs) that the personalised download is made from. */
  appsScriptBundlePath: string;
  /** DESIGN.md 10.1: a postgres:// URL selects PostgreSQL (TLS via its sslmode); unset keeps the local file in dataDir. */
  databaseUrl: string | undefined;
  /** DESIGN.md 10.3: owner bootstrap. The password is only used when no owner exists yet. */
  adminUsername: string;
  adminPassword: string | undefined;
  tunnel: TunnelConfig | undefined;
}

function port(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === "") return def;
  const n = /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (v === undefined || v.trim() === "") return false;
  const s = v.trim().toLowerCase();
  if (s === "false" || s === "0") return false;
  if (s === "true") return true;
  if (/^\d+$/.test(s)) return Number(s);
  return v.trim();
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function loadTunnel(env: NodeJS.ProcessEnv, publicBaseUrl: string | undefined): TunnelConfig | undefined {
  const kind = (env.TUNNEL ?? "").trim().toLowerCase();
  if (kind === "" || kind === "off") return undefined;
  const set = (v: string | undefined): string | undefined => (v && v.trim() !== "" ? v.trim() : undefined);
  if (kind === "cloudflare") {
    const token = set(env.CLOUDFLARE_TUNNEL_TOKEN);
    if (token && !publicBaseUrl) throw new Error("TUNNEL=cloudflare with CLOUDFLARE_TUNNEL_TOKEN needs PUBLIC_BASE_URL set to the tunnel's hostname (https://...)");
    return { kind, token };
  }
  if (kind === "ngrok") {
    const authtoken = set(env.NGROK_AUTHTOKEN);
    if (!authtoken) throw new Error("TUNNEL=ngrok requires NGROK_AUTHTOKEN");
    const domain = set(env.NGROK_DOMAIN);
    if (domain && !HOSTNAME.test(domain)) throw new Error("NGROK_DOMAIN must be a bare hostname such as my-name.ngrok-free.app (no https://, port or path)");
    return { kind, authtoken, domain };
  }
  throw new Error("TUNNEL must be off|cloudflare|ngrok");
}

/** The only place in the code base that reads process.env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let publicBaseUrl: string | undefined;
  if (env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.trim() !== "") {
    const n = normalizeBaseUrl(env.PUBLIC_BASE_URL);
    if (!n) throw new Error("PUBLIC_BASE_URL must be an https origin (http allowed only for localhost), without a path");
    publicBaseUrl = n;
  }
  const level = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error("LOG_LEVEL must be debug|info|warn|error");
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) throw new Error("DATABASE_URL must be a postgres:// or postgresql:// URL");
  const tunnel = loadTunnel(env, publicBaseUrl);
  return {
    port: port(env.PORT, 38787, "PORT"),
    dataDir: env.DATA_DIR && env.DATA_DIR !== "" ? env.DATA_DIR : "/data",
    publicBaseUrl,
    logLevel: level as LogLevel,
    // A built-in tunnel is a local proxy: trust X-Forwarded-For from loopback only (unless TRUST_PROXY says otherwise).
    trustProxy: tunnel && (env.TRUST_PROXY ?? "").trim() === "" ? "loopback" : parseTrustProxy(env.TRUST_PROXY),
    appsScriptBundlePath: env.APPS_SCRIPT_BUNDLE_PATH && env.APPS_SCRIPT_BUNDLE_PATH.trim() !== "" ? env.APPS_SCRIPT_BUNDLE_PATH.trim() : "/app/apps-script/Code.gs",
    databaseUrl: databaseUrl ? databaseUrl : undefined,
    adminUsername: env.ADMIN_USERNAME && env.ADMIN_USERNAME.trim() !== "" ? env.ADMIN_USERNAME.trim() : "admin",
    adminPassword: env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== "" ? env.ADMIN_PASSWORD : undefined,
    tunnel,
  };
}
