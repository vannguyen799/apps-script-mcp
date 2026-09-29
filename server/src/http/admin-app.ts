import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { AccountService } from "../auth/accounts.js";
import { AccountError } from "../auth/accounts.js";
import type { AdminAuth, AdminSession } from "../auth/admin-auth.js";
import type { GsmcpOAuthProvider } from "../auth/oauth-provider.js";
import type { PatService } from "../auth/pat.js";
import type { ConnectionRegistry } from "../connection/connection-registry.js";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { PublicBaseUrl } from "../settings/public-base-url.js";
import type { UsageService } from "../usage/usage-service.js";
import { safeEqualStr } from "../util/crypto.js";
import { parseCookies } from "../util/http.js";
import type { FailureLimiter } from "../util/rate-limit.js";
import { mountPendingRoutes } from "./connection-api.js";
import { HttpError, mapKnownError } from "./errors.js";

export const COOKIE_NAME = "asmcp_admin";
const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface AdminAppDeps {
  auth: AdminAuth;
  accounts: AccountService;
  /** Shared per-IP failure counter (login, password change). */
  limiter: FailureLimiter;
  registry: ConnectionRegistry;
  baseUrl: PublicBaseUrl;
  pats: PatService;
  provider: GsmcpOAuthProvider;
  usage: UsageService;
  allowedHosts: string[];
  trustProxy: boolean | number | string;
  logger?: Logger;
  /** Overridable for tests; defaults to the bundled admin-ui/index.html. */
  indexHtml?: string;
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
      const u = s ? deps.accounts.getUser(s.userId) : undefined;
      const ok = !!s && u?.role === "owner";
      res.json({ authenticated: ok, csrfToken: ok ? s!.csrf : null, username: ok ? u!.username : null });
    }),
  );

  api.post(
    "/login",
    wrap(async (req, res) => {
      const { username, password } = body(req);
      try {
        const user = await deps.accounts.login(username, password, ipOf(req), { requireRole: "owner" });
        const s = deps.auth.createSession(user.id);
        setSessionCookie(req, res, s);
        res.json({ ok: true, csrfToken: s.csrf });
      } catch (e) {
        if (e instanceof AccountError) log.warn("admin_login_failed", { resultCode: e.code });
        throw e;
      }
    }),
  );

  // ---- authenticated (owner) --------------------------------------------------------
  api.use((req: SessionRequest, _res, next) => {
    const s = currentSession(req);
    if (!s || deps.accounts.getUser(s.userId)?.role !== "owner") return next(new HttpError(401, "UNAUTHENTICATED", "Cần đăng nhập."));
    req.session = s;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const sent = req.headers["x-csrf-token"];
      if (typeof sent !== "string" || !safeEqualStr(sent, s.csrf)) return next(new HttpError(403, "BAD_CSRF", "Missing or invalid X-CSRF-Token."));
    }
    next();
  });
  const ownerId = (req: Request): string => (req as SessionRequest).session!.userId;

  api.post(
    "/logout",
    wrap((req, res) => {
      deps.auth.destroySession(req.session?.id);
      clearCookie(res);
      res.json({ ok: true });
    }),
  );

  api.post(
    "/password",
    wrap(async (req, res) => {
      const { currentPassword, newPassword, confirmPassword } = body(req);
      await deps.accounts.changePassword(ownerId(req), currentPassword, newPassword, confirmPassword, ipOf(req), { adminSessionId: req.session!.id });
      log.info("password_changed", { via: "admin" });
      res.json({ ok: true });
    }),
  );

  const statusPayload = () => {
    const base = deps.baseUrl.get() ?? null;
    return {
      publicBaseUrl: { value: base, source: deps.baseUrl.source(), editable: deps.baseUrl.editable },
      mcpEndpoint: deps.baseUrl.mcpEndpoint(),
      accountUrl: base ? `${base}/account` : null,
      setupAvailable: deps.registry.setupAvailable,
    };
  };

  api.get("/status", (_req, res) => {
    res.json(statusPayload());
  });

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

  api.get("/usage", (_req, res) => {
    res.json({ usage: deps.usage.rows() });
  });

  // connections: the owner sees and removes everyone's, and adds their own with the same flow as /account
  api.get("/connections", (_req, res) => {
    res.json({ connections: deps.registry.listAll() });
  });
  api.post(
    "/connections/:id/test",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!deps.registry.get(id)) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy kết nối.");
      res.json({ connection: await deps.registry.ping(id) });
    }),
  );
  api.delete(
    "/connections/:id",
    wrap(async (req, res) => {
      if (!(await deps.registry.remove(String(req.params.id), null))) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy kết nối.");
      res.json({ ok: true });
    }),
  );
  mountPendingRoutes(api, deps.registry, ownerId, wrap);

  // PATs and grants of every user: list and revoke (PATs are created on /account)
  api.get("/pats", (_req, res) => {
    const users = new Map(deps.accounts.listUsers().map((u) => [u.id, u.username]));
    const conns = new Map(deps.registry.listAll().map((c) => [c.id, c.label]));
    res.json({ pats: deps.pats.list().map((p) => ({ ...p, username: users.get(p.userId) ?? null, connectionLabel: conns.get(p.connectionId) ?? null })) });
  });
  api.delete(
    "/pats/:id",
    wrap(async (req, res) => {
      if (!(await deps.pats.revoke(String(req.params.id)))) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy token.");
      res.json({ ok: true });
    }),
  );

  api.get("/grants", (_req, res) => {
    res.json({ grants: deps.provider.listGrants() });
  });
  api.delete(
    "/grants/:id",
    wrap(async (req, res) => {
      if (!(await deps.provider.revokeGrant(String(req.params.id)))) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy grant.");
      res.json({ ok: true });
    }),
  );

  api.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Unknown endpoint.")));

  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const m = mapKnownError(err);
    if (m) {
      if (m.status === 429) res.set("Retry-After", String(m.retryAfterSec ?? 60));
      res.status(m.status).json({ error: { code: m.code, message: m.message } });
      return;
    }
    log.error("admin_error", { reason: err instanceof Error ? err.name : "unknown" });
    res.status(500).json({ error: { code: "INTERNAL", message: "Unexpected error." } });
  });

  return app;
}
