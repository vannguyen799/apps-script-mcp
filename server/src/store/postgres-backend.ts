import pg from "pg";
import type { StateBackend } from "./backend.js";

/** The slice of `pg.Pool` this adapter uses. */
export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

/**
 * PostgreSQL adapter (DESIGN.md 10.1): one row, `asmcp_state(id = 1, doc jsonb, updated_at)`. `save` is a plain upsert:
 * exactly one server instance may use a database (nothing detects a second writer).
 */
export class PostgresStateBackend implements StateBackend {
  constructor(private readonly pool: PgLike) {}

  /** Connects with the URL as given (TLS via its `sslmode`), and creates the table when missing. */
  static async connect(url: string, onPoolError: (e: Error) => void = () => {}): Promise<PostgresStateBackend> {
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    pool.on("error", onPoolError); // an idle connection dropped by the server must not crash the process
    const backend = new PostgresStateBackend(pool);
    await backend.ensureSchema();
    return backend;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS asmcp_state (
         id smallint PRIMARY KEY CHECK (id = 1),
         doc jsonb NOT NULL,
         updated_at timestamptz NOT NULL
       )`,
    );
  }

  async load(): Promise<unknown | null> {
    const r = await this.pool.query(`SELECT doc FROM asmcp_state WHERE id = 1`);
    return r.rows[0] ? r.rows[0].doc : null;
  }

  async save(doc: unknown): Promise<void> {
    const json = JSON.stringify(doc); // before any await
    await this.pool.query(
      `INSERT INTO asmcp_state (id, doc, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
      [json],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
