import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { AccountService, PublicSession } from "../auth/accounts.js";
import { AccountError } from "../auth/accounts.js";
import type { GsmcpOAuthProvider } from "../auth/oauth-provider.js";
import type { PatService } from "../auth/pat.js";
import { clearSessionCookie, readSessionId, setSessionCookie } from "../auth/session-cookie.js";
import type { ConnectionRegistry } from "../connection/connection-registry.js";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import { safeEqualStr } from "../util/crypto.js";
import { originAllowed } from "../util/http.js";
import type { UsageService } from "../usage/usage-service.js";
import type { FailureLimiter } from "../util/rate-limit.js";
import { mountPendingRoutes } from "./connection-api.js";
import { HttpError, mapKnownError } from "./errors.js";

export interface AccountRouterDeps {
  accounts: AccountService;
  registry: ConnectionRegistry;
  pats: PatService;
  provider: GsmcpOAuthProvider;
  /** Current public base URL (for the Secure flag and the Origin check). */
  baseUrl: () => string | undefined;
  ipLimiter: FailureLimiter;
  usage: UsageService;
  logger?: Logger;
  /** Overridable for tests; defaults to the bundled account-ui/index.html. */
  indexHtml?: string;
}

type SessionRequest = Request & { pubSession?: PublicSession };

/** The public /account pages and JSON API (DESIGN.md 9.1, 9.2): login, connections, PATs, usage. */
export function createAccountRouter(deps: AccountRouterDeps): Router {
  const log = deps.logger ?? nullLogger;
  const html = deps.indexHtml ?? readFileSync(new URL("../account-ui/index.html", import.meta.url), "utf8");
  const router = express.Router();
  const secure = () => (deps.baseUrl() ?? "").startsWith("https:");
  const ipOf = (req: Request) => req.ip ?? "unknown";
  const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    (req, res, next) => {
      Promise.resolve(fn(req, res)).catch(next);
    };

  router.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    next();
  });

  // ---- pages -----------------------------------------------------------------
  const page: RequestHandler = (req, res) => {
    const nonce = randomBytes(16).toString("base64");
    const consent = typeof req.query.consent === "string" ? req.query.consent : "";
    if (consent) deps.provider.extendConsent(consent);
    res
      .set({
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      .type("html")
      .send(html.replaceAll("{{NONCE}}", nonce));
  };
  router.get("/", page);

  // ---- write guards: Origin, JSON only -------------------------------------------
  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!originAllowed(req, deps.baseUrl())) {
      res.status(403).json({ error: { code: "BAD_ORIGIN", message: "Origin không hợp lệ." } });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "32kb" }));
  router.use((req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      return next(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."));
    }
    next();
  });

  const sessionOf = (req: Request) => deps.accounts.getSession(readSessionId(req));
  const startSession = async (res: Response, userId: string) => {
    const s = await deps.accounts.createSession(userId);
    setSessionCookie(res, s.id, secure());
    const u = deps.accounts.getUser(userId)!;
    return { ok: true, csrfToken: s.csrf, username: u.username, role: u.role };
  };

  // ---- unauthenticated -----------------------------------------------------------
  router.get(
    "/api/session",
    wrap((req, res) => {
      const s = sessionOf(req);
      res.json({ authenticated: !!s, csrfToken: s?.csrf ?? null, username: s?.user.username ?? null, role: s?.user.role ?? null, setupAvailable: deps.registry.setupAvailable });
    }),
  );

  router.post(
    "/login",
    wrap(async (req, res) => {
      const b = body(req);
      try {
        const user = await deps.accounts.login(b.username, b.password, ipOf(req));
        res.json(await startSession(res, user.id));
      } catch (e) {
        if (e instanceof AccountError) log.warn("account_login_failed", { resultCode: e.code });
        throw e;
      }
    }),
  );

  // ---- authenticated (session cookie + X-CSRF-Token on writes) --------------------------
  router.use("/api", (req: SessionRequest, _res, next) => {
    const s = sessionOf(req);
    if (!s) return next(new HttpError(401, "UNAUTHENTICATED", "Hãy đăng nhập."));
    req.pubSession = s;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const sent = req.headers["x-csrf-token"];
      if (typeof sent !== "string" || !safeEqualStr(sent, s.csrf)) return next(new HttpError(403, "BAD_CSRF", "Thiếu hoặc sai X-CSRF-Token."));
    }
    next();
  });
  const me = (req: Request): string => (req as SessionRequest).pubSession!.user.id;

  const authedOnly = (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    wrap(async (req, res) => {
      const s = sessionOf(req);
      if (!s) throw new HttpError(401, "UNAUTHENTICATED", "Hãy đăng nhập.");
      const sent = req.headers["x-csrf-token"];
      if (typeof sent !== "string" || !safeEqualStr(sent, s.csrf)) throw new HttpError(403, "BAD_CSRF", "Thiếu hoặc sai X-CSRF-Token.");
      (req as SessionRequest).pubSession = s;
      await fn(req, res);
    });

  router.post(
    "/logout",
    wrap(async (req, res) => {
      const s = sessionOf(req);
      if (s) {
        const sent = req.headers["x-csrf-token"];
        if (typeof sent !== "string" || !safeEqualStr(sent, s.csrf)) throw new HttpError(403, "BAD_CSRF", "Thiếu hoặc sai X-CSRF-Token.");
        await deps.accounts.destroySession(s.id);
      }
      clearSessionCookie(res, secure());
      res.json({ ok: true });
    }),
  );

  router.post(
    "/api/password",
    wrap(async (req, res) => {
      const b = body(req);
      const s = (req as SessionRequest).pubSession!;
      await deps.accounts.changePassword(s.user.id, b.currentPassword, b.newPassword, b.confirmPassword, ipOf(req), { publicSessionId: s.id });
      log.info("password_changed", { via: "account" });
      res.json({ ok: true });
    }),
  );

  router.post(
    "/logout-all",
    authedOnly(async (req, res) => {
      await deps.accounts.destroyUserSessions(me(req));
      clearSessionCookie(res, secure());
      res.json({ ok: true });
    }),
  );

  router.get("/api/connections", (req, res) => {
    res.json({ connections: deps.registry.listFor(me(req)) });
  });

  router.patch(
    "/api/connections/:id",
    wrap(async (req, res) => {
      const c = await deps.registry.rename(String(req.params.id), me(req), body(req).label);
      if (!c) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy kết nối.");
      res.json({ connection: c });
    }),
  );

  router.post(
    "/api/connections/:id/test",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (deps.registry.get(id)?.userId !== me(req)) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy kết nối.");
      res.json({ connection: await deps.registry.ping(id) });
    }),
  );

  router.delete(
    "/api/connections/:id",
    wrap(async (req, res) => {
      if (!(await deps.registry.remove(String(req.params.id), me(req)))) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy kết nối.");
      res.json({ ok: true });
    }),
  );

  const pendingRouter = express.Router();
  router.use("/api", pendingRouter);
  mountPendingRoutes(pendingRouter, deps.registry, me, wrap);

  /** DESIGN.md 10.2: calls and errors per day and tool over the last 30 days. */
  router.get("/api/usage", (_req, res) => {
    res.json({ usage: deps.usage.rows() });
  });

  router.get("/api/pats", (req, res) => {
    res.json({ pats: deps.pats.list(me(req)) });
  });
  router.post(
    "/api/pats",
    wrap(async (req, res) => {
      const b = body(req);
      try {
        const { token, pat } = await deps.pats.create(me(req), String(b.connectionId ?? ""), String(b.label ?? ""), Array.isArray(b.scopes) ? (b.scopes as string[]) : []);
        res.status(201).json({ token, pat }); // the only time the token is ever returned
      } catch (e) {
        throw new HttpError(400, "BAD_REQUEST", (e as Error).message);
      }
    }),
  );
  router.delete(
    "/api/pats/:id",
    wrap(async (req, res) => {
      if (!(await deps.pats.revoke(String(req.params.id), me(req)))) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy token.");
      res.json({ ok: true });
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const m = mapKnownError(err);
    if (m) {
      if (m.retryAfterSec) res.set("Retry-After", String(m.retryAfterSec));
      else if (m.status === 429) res.set("Retry-After", "60");
      res.status(m.status).json({ error: { code: m.code, message: m.message } });
      return;
    }
    log.error("account_error", { reason: err instanceof Error ? err.name : "unknown" });
    res.status(500).json({ error: { code: "INTERNAL", message: "Lỗi không mong muốn." } });
  });

  return router;
}
