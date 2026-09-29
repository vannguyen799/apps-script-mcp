import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { CONSENT_PATH, GsmcpOAuthProvider } from "../auth/oauth-provider.js";
import { ADVERTISED_SCOPES } from "../auth/scopes.js";
import type { AccountService } from "../auth/accounts.js";
import type { PatService } from "../auth/pat.js";
import type { ConnectionRegistry } from "../connection/connection-registry.js";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import { createMcpServer } from "../mcp/server.js";
import type { PublicBaseUrl } from "../settings/public-base-url.js";
import { sha256Hex } from "../util/crypto.js";
import type { UsageService } from "../usage/usage-service.js";
import type { FailureLimiter } from "../util/rate-limit.js";
import { FixedWindowLimiter } from "../util/rate-limit.js";
import { createAccountRouter } from "./account-app.js";

export interface PublicAppDeps {
  provider: GsmcpOAuthProvider;
  baseUrl: PublicBaseUrl;
  accounts: AccountService;
  registry: ConnectionRegistry;
  pats: PatService;
  usage: UsageService;
  /** Shared per-IP login failure counter (5 / 15 min). */
  ipLimiter: FailureLimiter;
  /** When true, the run_apps_script tool is registered (still needs the script.eval scope). */
  evaluatorAvailable?: boolean;
  /** Overridable for tests. */
  accountIndexHtml?: string;
  trustProxy: boolean | number | string;
  logger?: Logger;
  /** Requests per minute per token on /mcp (default 120). */
  mcpRateLimitPerMin?: number;
}

const OAUTH_PATHS = ["/authorize", "/token", "/register", "/revoke", "/.well-known", CONSENT_PATH];

const jsonRpcError = (message: string, code = -32000) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createPublicApp(deps: PublicAppDeps): Express {
  const log = deps.logger ?? nullLogger;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxy);
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // ---- /account: login, connections, PATs, usage (does not need the OAuth issuer to be configured) ----
  app.use(
    "/account",
    createAccountRouter({
      accounts: deps.accounts,
      registry: deps.registry,
      pats: deps.pats,
      provider: deps.provider,
      baseUrl: () => deps.baseUrl.get(),
      ipLimiter: deps.ipLimiter,
      usage: deps.usage,
      logger: log,
      indexHtml: deps.accountIndexHtml,
    }),
  );

  // ---- OAuth (router rebuilt when the base URL changes) -------------------
  let cached: { base: string; router: RequestHandler } | null = null;
  const routerFor = (base: string): RequestHandler => {
    if (cached?.base !== base) {
      cached = {
        base,
        router: mcpAuthRouter({
          provider: deps.provider,
          issuerUrl: new URL(base),
          scopesSupported: [...ADVERTISED_SCOPES],
          resourceServerUrl: new URL(`${base}/mcp`),
          resourceName: "apps-script-mcp",
          // The SDK's limiters are built lazily here (the base URL is dynamic), which trips express-rate-limit's
          // "created in a request handler" self-check; keep the limits, skip that check.
          authorizationOptions: { rateLimit: { validate: false } },
          tokenOptions: { rateLimit: { validate: false } },
          clientRegistrationOptions: { rateLimit: { validate: false } },
          revocationOptions: { rateLimit: { validate: false } },
        }),
      };
    }
    return cached.router;
  };

  const formParser = express.urlencoded({ extended: false, limit: "8kb" });
  const consent: RequestHandler = (req, res, next) => {
    if (req.method === "GET") {
      deps.provider.handleConsentGet(req, res).catch(next);
      return;
    }
    if (req.method !== "POST") {
      res.set("Allow", "GET, POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    formParser(req, res, (err?: unknown) => {
      if (err) return next(err);
      deps.provider.handleConsent(req, res).catch(next);
    });
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    if (!OAUTH_PATHS.some((o) => p === o || p.startsWith(o + "/"))) return next();
    const base = deps.baseUrl.get();
    if (!base) {
      res.status(503).json({
        error: "public_base_url_not_configured",
        error_description: "Set PUBLIC_BASE_URL or configure the public base URL in the admin UI to enable OAuth.",
      });
      return;
    }
    if (p === CONSENT_PATH) return consent(req, res, next);
    if (p === "/.well-known/oauth-protected-resource") {
      // Root alias of the path-specific metadata, matching the WWW-Authenticate hint.
      const meta = {
        resource: `${base}/mcp`,
        authorization_servers: [`${base}/`],
        scopes_supported: [...ADVERTISED_SCOPES],
        resource_name: "apps-script-mcp",
      };
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        res.set("Allow", "GET, HEAD, OPTIONS").status(405).json({ error: "method_not_allowed" });
        return;
      }
      res.set("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      res.json(meta);
      return;
    }
    return routerFor(base)(req, res, next);
  });

  // ---- /mcp ------------------------------------------------------------------
  const bearer: RequestHandler = (req, res, next) => {
    const base = deps.baseUrl.get();
    requireBearerAuth({
      verifier: deps.provider,
      resourceMetadataUrl: base ? `${base}/.well-known/oauth-protected-resource` : undefined,
    })(req, res, next);
  };

  const limiter = new FixedWindowLimiter(deps.mcpRateLimitPerMin ?? 120, 60_000);
  const rateLimit: RequestHandler = (req, res, next) => {
    const key = sha256Hex(req.auth?.token ?? req.ip ?? "anon");
    const r = limiter.hit(key);
    if (!r.allowed) {
      res.set("Retry-After", String(r.retryAfterSec)).status(429).json(jsonRpcError("Rate limit exceeded (120 requests per minute per token)."));
      return;
    }
    next();
  };

  app.post("/mcp", bearer, rateLimit, express.json({ limit: "8mb" }), async (req, res) => {
    const server = createMcpServer(deps.registry.resolve, log, deps.evaluatorAvailable, deps.usage);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error("mcp_request_failed", { reason: e instanceof Error ? e.name : "unknown" });
      if (!res.headersSent) res.status(500).json(jsonRpcError("Internal server error", -32603));
    }
  });

  app.all("/mcp", bearer, (_req, res) => {
    res.set("Allow", "POST").status(405).json(jsonRpcError("Method not allowed. This server is stateless; use POST."));
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      res.status(status).json(jsonRpcError(status === 413 ? "Request too large" : "Invalid JSON", -32700));
      return;
    }
    log.error("http_error", { reason: err instanceof Error ? err.name : "unknown" });
    res.status(500).json({ error: "server_error" });
  });

  return app;
}
