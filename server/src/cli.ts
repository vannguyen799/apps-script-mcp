import { adminLoginLine, resetOwnerPassword } from "./auth/accounts.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { openStateStore } from "./store/open-store.js";

/** Usage: node dist/cli.js reset-password   (stop the server first: it rewrites the whole stored state on shutdown). */
async function main(): Promise<void> {
  if (process.argv[2] !== "reset-password") throw new Error("usage: node dist/cli.js reset-password");
  const config = loadConfig();
  const running = await fetch(`http://127.0.0.1:${config.portPublic}/healthz`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (running) throw new Error("the server is running and would overwrite the change: stop it first (docker stop apps-script-mcp), run this in a one-off container, then start it again");
  const store = await openStateStore(config, createLogger("error"));
  await store.load();
  const r = await resetOwnerPassword(store);
  await store.close();
  if (!r) throw new Error("there is no owner account yet: start the server once");
  process.stdout.write(adminLoginLine(r.username, r.password) + "\n");
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
