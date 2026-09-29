import { normalizeBaseUrl } from "./util/base-url.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  portPublic: number;
  portAdmin: number;
  dataDir: string;
  /** Normalised origin from PUBLIC_BASE_URL, if set (then the admin UI cannot change it). */
  publicBaseUrl: string | undefined;
  adminAllowedHosts: string[];
  logLevel: LogLevel;
  trustProxy: boolean | number | string;
}

function port(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
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
  return {
    portPublic: port(env.PORT_PUBLIC, 8787, "PORT_PUBLIC"),
    portAdmin: port(env.PORT_ADMIN, 8788, "PORT_ADMIN"),
    dataDir: env.DATA_DIR && env.DATA_DIR !== "" ? env.DATA_DIR : "/data",
    publicBaseUrl,
    adminAllowedHosts: (env.ADMIN_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    logLevel: level as LogLevel,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
