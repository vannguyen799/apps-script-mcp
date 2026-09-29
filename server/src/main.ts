import { hostname } from "node:os";
import type { Server } from "node:http";
import { AdminAuth } from "./auth/admin-auth.js";
import { GsmcpOAuthProvider } from "./auth/oauth-provider.js";
import { PatService } from "./auth/pat.js";
import { loadConfig } from "./config.js";
import { ConnectionManager } from "./connection/connection-manager.js";
import { SheetsService } from "./core/sheets/sheets.service.js";
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

  const limiter = new FailureLimiter(5, 15 * 60_000); // shared by admin login and the OAuth consent page
  const admin = new AdminAuth(store);
  const pats = new PatService(store);
  const baseUrl = new PublicBaseUrl(config.publicBaseUrl, store);
  const provider = new GsmcpOAuthProvider({ store, admin, limiter, pats, baseUrl: () => baseUrl.get(), logger: log });

  const connection = new ConnectionManager({ store, logger: log, instanceLabel: `gsheets-mcp@${hostname()}` });
  const service = new SheetsService(connection.gateway);
  connection.onChange(() => service.invalidate());

  const publicApp = createPublicApp({ provider, baseUrl, service, trustProxy: config.trustProxy, logger: log });
  const adminApp = createAdminApp({
    auth: admin,
    limiter,
    connection,
    baseUrl,
    pats,
    provider,
    allowedHosts: config.adminAllowedHosts,
    trustProxy: config.trustProxy,
    logger: log,
  });

  const setupToken = await admin.ensureSetupToken();
  if (setupToken) {
    // Deliberately bypasses the logger: printed once, to stdout only.
    process.stdout.write(`Setup token: ${setupToken}\n`);
  }

  const servers: Server[] = [
    publicApp.listen(config.portPublic, () => log.info("public_listening", { port: config.portPublic })),
    adminApp.listen(config.portAdmin, () => log.info("admin_listening", { port: config.portAdmin })),
  ];
  connection.start();

  const shutdown = (): void => {
    connection.stop();
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
