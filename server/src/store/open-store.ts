import type { Logger } from "../log.js";
import { LocalStateBackend } from "./local-backend.js";
import { PostgresStateBackend } from "./postgres-backend.js";
import { StateStore } from "./state-store.js";

/**
 * DESIGN.md 10.1: `databaseUrl` set = PostgreSQL (importing DATA_DIR/state.json once when the table is empty), unset = the
 * local JSON file in `dataDir`. The store is returned unloaded.
 */
export async function openStateStore(cfg: { dataDir: string; databaseUrl: string | undefined }, log: Logger): Promise<StateStore> {
  if (!cfg.databaseUrl) return new StateStore(new LocalStateBackend(cfg.dataDir), log);
  const backend = await PostgresStateBackend.connect(cfg.databaseUrl, () => log.error("pg_pool_error"));
  return new StateStore(backend, log, { importFrom: new LocalStateBackend(cfg.dataDir) });
}
