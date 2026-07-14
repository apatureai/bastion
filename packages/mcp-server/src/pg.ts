import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { SqlConnection, SqlConnectionFactory } from "./postgres-store.js";

/**
 * Production Postgres adapter for the durable application plane (#36). Wraps a
 * `pg` pool behind the `SqlConnectionFactory` seam that
 * `PostgresReviewApplicationStore` and `PostgresAllowlistResolver` consume, so
 * tests can drive the same stores over PGlite with no real server.
 */
export class PgPoolConnectionFactory implements SqlConnectionFactory {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, max = 5) {
    this.pool = new pg.Pool({ connectionString, max });
  }

  async connect(): Promise<SqlConnection> {
    const client = await this.pool.connect();
    return {
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        const result = await client.query(sql, params ? [...params] : undefined);
        return { rows: result.rows as Row[] };
      },
      release: () => client.release(),
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** Sibling of both `src` and `dist`, so the runner works built and unbuilt. */
export const MCP_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Apply every pending `NNN_name.sql` in lexical order, exactly once each
 * (tracked in `mcp_schema_migrations`). Idempotent, so the production
 * entrypoint runs it on every boot; a failed statement rolls the migration
 * back with its tracking row.
 */
export async function runMcpMigrations(
  factory: SqlConnectionFactory,
  dir: string = MCP_MIGRATIONS_DIR,
): Promise<string[]> {
  const connection = await factory.connect();
  try {
    await connection.query(
      "CREATE TABLE IF NOT EXISTS mcp_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await connection.query<{ id: string }>("SELECT id FROM mcp_schema_migrations")).rows.map((r) => r.id),
    );
    const applied: string[] = [];
    const pending = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of pending) {
      const id = file.slice(0, -".sql".length);
      if (done.has(id)) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe migration id: ${id}`);
      const sql = readFileSync(join(dir, file), "utf8");
      await connection.query("BEGIN");
      try {
        await connection.query(sql);
        await connection.query("INSERT INTO mcp_schema_migrations (id) VALUES ($1)", [id]);
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      applied.push(id);
    }
    return applied;
  } finally {
    connection.release();
  }
}
