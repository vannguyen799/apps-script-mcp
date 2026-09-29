import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { AdminAuth, AdminSession } from "../auth/admin-auth.js";
import { AdminAuthError } from "../auth/admin-auth.js";
import type { GsmcpOAuthProvider } from "../auth/oauth-provider.js";
import type { PatService } from "../auth/pat.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { GatewayError } from "../core/sheets/gateway.js";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { PublicBaseUrl } from "../settings/public-base-url.js";
import { safeEqualStr } from "../util/crypto.js";
import type { FailureLimiter } from "../util/rate-limit.js";

export const COOKIE_NAME = "asmcp_admin";
const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface AdminAppDeps {
  auth: AdminAuth;
  limiter: FailureLimiter;
  connection: ConnectionManager;
  baseUrl: PublicBaseUrl;
  pats: PatService;
  provider: GsmcpOAuthProvider;
  allowedHosts: string[];
  trustProxy: boolean | number | string;
  logger?: Logger;
  /** Overridable for tests; defaults to the bundled admin-ui/index.html. */
  indexHtml?: string;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** "Host: [::1]:8788" -> "[::1]"; "LOCALHOST:8788" -> "localhost". */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(":");
  return i < 0 ? h : h.slice(0, i);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

type SessionRequest = Request & { session?: AdminSession };

export function createAdminApp(deps: AdminAppDeps): Express {
  const log = deps.logger ?? nullLogger;
  const allowed = new Set([...DEFAULT_HOSTS, ...deps.allowedHosts.map((h) => hostnameOf(h) || h.toLowerCase())]);
  const html = deps.indexHtml ?? readFileSync(new URL("../admin-ui/index.html", import.meta.url), "utf8");

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxy);

  // 1. Host allowlist (DNS-rebinding defence): anything else is 421.
  app.use((req, res, next) => {
    if (!allowed.has(hostnameOf(req.headers.host))) {
      res.status(421).json({ error: { code: "MISDIRECTED_REQUEST", message: "Host not allowed. Add it to ADMIN_ALLOWED_HOSTS." } });
      return;
    }
    next();
  });

  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    next();
  });

  // 2. Origin must match Host on state-changing requests.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try {
        ok = new URL(origin).host.toLowerCase() === (req.headers.host ?? "").toLowerCase();
      } catch {
        ok = false;
      }
      if (!ok) {
        res.status(403).json({ error: { code: "BAD_ORIGIN", message: "Origin does not match Host." } });
        return;
      }
    }
    next();
  });

  app.get("/", (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    res
      .set({
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      .type("html")
      .send(html.replaceAll("{{NONCE}}", nonce));
  });

  const api = express.Router();
  api.use(express.json({ limit: "32kb" }));

  // Content-Type must be JSON on every state-changing request.
  api.use((req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      return next(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."));
    }
    next();
  });

  const setSessionCookie = (req: Request, res: Response, s: AdminSession) => {
    const secure = req.secure ? "; Secure" : "";
    res.append("Set-Cookie", `${COOKIE_NAME}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${secure}`);
  };
  const clearCookie = (res: Response) => {
    res.append("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  };
  const currentSession = (req: Request) => deps.auth.getSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  const ipOf = (req: Request) => req.ip ?? "unknown";
  const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

  const assertNotBlocked = (req: Request) => {
    const wait = deps.limiter.blockedFor(ipOf(req));
    if (wait > 0) throw new HttpError(429, "TOO_MANY_ATTEMPTS", `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
  };

  const wrap =
    (fn: (req: SessionRequest, res: Response) => Promise<void> | void): RequestHandler =>
    (req, res, next) => {
      Promise.resolve(fn(req as SessionRequest, res)).catch(next);
    };

  // ---- unauthenticated ------------------------------------------------------
  api.get(
    "/session",
    wrap((req, res) => {
      const s = currentSession(req);
      res.json({ setupRequired: deps.auth.needsSetup(), authenticated: !!s, csrfToken: s?.csrf ?? null });
    }),
  );

  api.post(
    "/setup",
    wrap(async (req, res) => {
      assertNotBlocked(req);
      const { setupToken, password } = body(req);
      try {
        const s = await deps.auth.completeSetup(String(setupToken ?? ""), String(password ?? ""));
        deps.limiter.reset(ipOf(req));
        setSessionCookie(req, res, s);
        log.info("admin_setup_completed");
        res.json({ ok: true, csrfToken: s.csrf });
      } catch (e) {
        if (e instanceof AdminAuthError) {
          if (e.code === "BAD_SETUP_TOKEN") deps.limiter.recordFailure(ipOf(req));
          throw new HttpError(e.code === "ALREADY_SETUP" ? 409 : e.code === "BAD_SETUP_TOKEN" ? 401 : 400, e.code, e.message);
        }
        throw e;
      }
    }),
  );

  api.post(
    "/login",
    wrap(async (req, res) => {
      assertNotBlocked(req);
      if (deps.auth.needsSetup()) throw new HttpError(409, "SETUP_REQUIRED", "Complete first-run setup first.");
      if (!(await deps.auth.verifyPassword(body(req).password))) {
        deps.limiter.recordFailure(ipOf(req));
        log.warn("admin_login_failed");
        throw new HttpError(401, "BAD_CREDENTIALS", "Wrong password.");
      }
      deps.limiter.reset(ipOf(req));
      const s = deps.auth.createSession();
      setSessionCookie(req, res, s);
      res.json({ ok: true, csrfToken: s.csrf });
    }),
  );

  // ---- authenticated ----------------------------------------------------------
  api.use((req: SessionRequest, _res, next) => {
    const s = currentSession(req);
    if (!s) return next(new HttpError(401, "UNAUTHENTICATED", "Login required."));
    req.session = s;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const sent = req.headers["x-csrf-token"];
      if (typeof sent !== "string" || !safeEqualStr(sent, s.csrf)) return next(new HttpError(403, "BAD_CSRF", "Missing or invalid X-CSRF-Token."));
    }
    next();
  });

  api.post(
    "/logout",
    wrap((req, res) => {
      deps.auth.destroySession(req.session?.id);
      clearCookie(res);
      res.json({ ok: true });
    }),
  );

  const statusPayload = () => ({
    connection: deps.connection.status(),
    publicBaseUrl: { value: deps.baseUrl.get() ?? null, source: deps.baseUrl.source(), editable: deps.baseUrl.editable },
    mcpEndpoint: deps.baseUrl.mcpEndpoint(),
  });

  api.get("/status", (_req, res) => {
    res.json(statusPayload());
  });

  api.post(
    "/pairing/start",
    wrap(async (req, res) => {
      const st = await deps.connection.startPairing(String(body(req).url ?? ""));
      res.json({ connection: st });
    }),
  );
  api.post(
    "/pairing/cancel",
    wrap(async (_req, res) => {
      res.json({ connection: await deps.connection.cancelPairing() });
    }),
  );
  api.post(
    "/connection/test",
    wrap(async (_req, res) => {
      res.json({ connection: await deps.connection.ping() });
    }),
  );
  api.post(
    "/connection/unpair",
    wrap(async (_req, res) => {
      res.json({ connection: await deps.connection.unpair() });
    }),
  );

  api.get(
    "/spreadsheets",
    wrap(async (_req, res) => {
      res.json({ spreadsheets: await deps.connection.gateway.listSpreadsheets() });
    }),
  );

  api.put(
    "/settings/public-base-url",
    wrap(async (req, res) => {
      const v = body(req).value;
      try {
        await deps.baseUrl.set(typeof v === "string" ? v : null);
      } catch (e) {
        throw new HttpError(deps.baseUrl.editable ? 400 : 409, deps.baseUrl.editable ? "BAD_URL" : "LOCKED_BY_ENV", (e as Error).message);
      }
      res.json(statusPayload());
    }),
  );

  api.get("/pats", (_req, res) => {
    res.json({ pats: deps.pats.list() });
  });
  api.post(
    "/pats",
    wrap(async (req, res) => {
      const { label, scopes } = body(req);
      try {
        const { token, pat } = await deps.pats.create(String(label ?? ""), Array.isArray(scopes) ? (scopes as string[]) : []);
        res.status(201).json({ token, pat }); // the only time the token is ever returned
      } catch (e) {
        throw new HttpError(400, "BAD_REQUEST", (e as Error).message);
      }
    }),
  );
  api.delete(
    "/pats/:id",
    wrap(async (req, res) => {
      if (!(await deps.pats.revoke(String(req.params.id)))) throw new HttpError(404, "NOT_FOUND", "No such token.");
      res.json({ ok: true });
    }),
  );

  api.get("/grants", (_req, res) => {
    res.json({ grants: deps.provider.listGrants() });
  });
  api.delete(
    "/grants/:id",
    wrap(async (req, res) => {
      if (!(await deps.provider.revokeGrant(String(req.params.id)))) throw new HttpError(404, "NOT_FOUND", "No such grant.");
      res.json({ ok: true });
    }),
  );

  api.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Unknown endpoint.")));

  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      if (err.status === 429) res.set("Retry-After", "60");
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof GatewayError) {
      const status = err.code === "BAD_REQUEST" ? 400 : err.code === "NOT_CONNECTED" ? 409 : 502;
      res.status(status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const st = (err as { status?: number }).status;
    if (st === 400 || st === 413) {
      res.status(st).json({ error: { code: "BAD_REQUEST", message: "Invalid request body." } });
      return;
    }
    log.error("admin_error", { reason: err instanceof Error ? err.name : "unknown" });
    res.status(500).json({ error: { code: "INTERNAL", message: "Unexpected error." } });
  });

  return app;
}
