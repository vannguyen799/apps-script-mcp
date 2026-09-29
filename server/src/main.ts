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
import { openStateStore } from "./store/open-store.js";
import { UsageService } from "./usage/usage-service.js";
import { FailureLimiter } from "./util/rate-limit.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  const store = await openStateStore(config, log);
  await store.load();
  log.info("storage_ready", { backend: config.databaseUrl ? "postgres" : "local" });
  const usage = new UsageService(store, { logger: log });

  const ipLimiter = new FailureLimiter(5, 15 * 60_000); // login / setup failures per IP (admin UI, /account, consent)
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
    usage,
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
    usage,
    allowedHosts: config.adminAllowedHosts,
    trustProxy: config.trustProxy,
    logger: log,
  });

  // DESIGN.md 10.3: ADMIN_USERNAME / ADMIN_PASSWORD create the owner only when there is none (a short password aborts startup).
  if (config.adminPassword !== undefined) {
    const owner = await accounts.bootstrapOwner(config.adminUsername, config.adminPassword);
    if (owner) log.info("owner_bootstrapped_from_env");
  }
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
  usage.start();

  const shutdown = (): void => {
    registry.stop();
    usage.stop();
    for (const s of servers) s.close(); // stop accepting first, then write what is buffered and release the database
    void usage
      .flush()
      .then(() => store.close())
      .catch(() => {})
      .finally(() => setTimeout(() => process.exit(0), 200).unref());
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
