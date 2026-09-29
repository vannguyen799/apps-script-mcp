import { hostname } from "node:os";
import type { Server } from "node:http";
import { AccountService } from "./auth/accounts.js";
import { AdminAuth } from "./auth/admin-auth.js";
import { GsmcpOAuthProvider } from "./auth/oauth-provider.js";
import { PatService } from "./auth/pat.js";
import { loadConfig } from "./config.js";
import { ConnectionRegistry } from "./connection/connection-registry.js";
import { loadBundle } from "./connection/setup-bundle.js";
import { createAdminApp } from "./http/admin-app.js";
import { createPublicApp } from "./http/public-app.js";
import { createLogger } from "./log.js";
import { PublicBaseUrl } from "./settings/public-base-url.js";
import { StateStore } from "./store/state-store.js";
import { FailureLimiter } from "./util/rate-limit.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  const store = new StateStore(config.dataDir, log);
  await store.load();

  const ipLimiter = new FailureLimiter(5, 15 * 60_000); // login / setup / invite failures per IP (admin UI, /account, consent)
  const userLimiter = new FailureLimiter(5, 15 * 60_000); // login failures per username
  const accounts = new AccountService({ store, ipLimiter, userLimiter });
  const admin = new AdminAuth();
  const pats = new PatService(store);
  const baseUrl = new PublicBaseUrl(config.publicBaseUrl, store);
  const bundle = await loadBundle(config.appsScriptBundlePath, log);

  const registry = new ConnectionRegistry({
    store,
    logger: log,
    instanceLabel: `apps-script-mcp@${hostname()}`,
    bundle,
    baseUrl: () => baseUrl.get(),
  });
  const provider = new GsmcpOAuthProvider({ store, accounts, connections: registry, pats, baseUrl: () => baseUrl.get(), logger: log });

  const publicApp = createPublicApp({
    provider,
    baseUrl,
    accounts,
    registry,
    pats,
    ipLimiter,
    evaluatorAvailable: true,
    trustProxy: config.trustProxy,
    logger: log,
  });
  const adminApp = createAdminApp({
    auth: admin,
    accounts,
    limiter: ipLimiter,
    registry,
    baseUrl,
    pats,
    provider,
    allowedHosts: config.adminAllowedHosts,
    trustProxy: config.trustProxy,
    logger: log,
  });

  const setupToken = await accounts.ensureSetupToken();
  if (setupToken) {
    // Deliberately bypasses the logger: printed once, to stdout only.
    process.stdout.write(`Setup token: ${setupToken}\n`);
  }

  const servers: Server[] = [
    publicApp.listen(config.portPublic, () => log.info("public_listening", { port: config.portPublic })),
    adminApp.listen(config.portAdmin, () => log.info("admin_listening", { port: config.portAdmin })),
  ];
  registry.start();

  const shutdown = (): void => {
    registry.stop();
    void store.flush().finally(() => {
      for (const s of servers) s.close();
      setTimeout(() => process.exit(0), 500).unref();
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
