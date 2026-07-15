import { createHash } from "node:crypto";
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
  private readonly onPoolError: (error: Error) => void;
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    max = 5,
    onPoolError: (error: Error) => void = (error) => {
      // `pg.Pool` emits errors from unexpectedly terminated background/idle
      // clients. An explicit listener is mandatory: without one, Node treats
      // the event as an uncaught exception and can kill an otherwise healthy
      // replica. Keep the default log bounded to the error class/message.
      console.error(`mcp-review postgres pool error: ${error.name}: ${error.message}`);
    },
  ) {
    this.onPoolError = onPoolError;
    this.pool = new pg.Pool({ connectionString, max });
    this.pool.on("error", onPoolError);
  }

  async connect(): Promise<SqlConnection> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    const onClientError = (error: Error): void => {
      releaseError = error;
      this.onPoolError(error);
    };
    // Pool-level `error` covers idle clients. A backend can also disappear
    // while checked out (for example, a killed migrator); that event must be
    // observed on the client itself until release.
    client.on("error", onClientError);
    return {
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        try {
          const result = await client.query(sql, params ? [...params] : undefined);
          return { rows: result.rows as Row[] };
        } catch (error) {
          // Destroy a client that failed a query instead of returning a
          // potentially broken socket to the pool. Transactional callers still
          // attempt rollback before release when the connection is usable.
          releaseError = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      },
      release: () => {
        client.release(releaseError);
        client.off("error", onClientError);
      },
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** Sibling of both `src` and `dist`, so the runner works built and unbuilt. */
export const MCP_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

// Stable, product-scoped signed 32-bit key. The transaction-scoped lock is
// released automatically on commit, rollback, connection loss, or process
// death, so another replica can safely resume a failed boot.
const MCP_MIGRATION_LOCK_KEY = 1_298_145_393;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface MigrationFile {
  checksum: string;
  id: string;
  sql: string;
}

function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const id = file.slice(0, -".sql".length);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe migration id: ${id}`);
      const contents = readFileSync(join(dir, file));
      return {
        id,
        sql: contents.toString("utf8"),
        checksum: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
      };
    });
}

/**
 * Apply every pending `NNN_name.sql` in lexical order, exactly once each.
 * The entire decision/execution path is serialized and transactional, so two
 * replicas may boot concurrently and a failed/killed runner leaves no partial
 * DDL. Known migrations are checksum-pinned; a historical file edit fails
 * startup instead of silently creating replica schema drift.
 */
export async function runMcpMigrations(
  factory: SqlConnectionFactory,
  dir: string = MCP_MIGRATIONS_DIR,
): Promise<string[]> {
  const migrations = readMigrations(dir);
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const connection = await factory.connect();
  try {
    await connection.query("BEGIN");
    try {
      await connection.query("SELECT pg_advisory_xact_lock($1)", [MCP_MIGRATION_LOCK_KEY]);
      await connection.query(
        `CREATE TABLE IF NOT EXISTS mcp_schema_migrations (
          id text PRIMARY KEY,
          checksum text,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`,
      );
      // One-time adoption for databases created before checksums were stored.
      await connection.query("ALTER TABLE mcp_schema_migrations ADD COLUMN IF NOT EXISTS checksum text");

      const rows = (
        await connection.query<{ checksum: string | null; id: string }>(
          "SELECT id, checksum FROM mcp_schema_migrations ORDER BY id",
        )
      ).rows;
      const done = new Set<string>();
      for (const row of rows) {
        const migration = byId.get(row.id);
        if (row.checksum === null) {
          if (!migration) {
            throw new Error(
              `cannot adopt checksum for applied migration ${row.id}: SQL file is absent from this image`,
            );
          }
          await connection.query(
            "UPDATE mcp_schema_migrations SET checksum=$2 WHERE id=$1 AND checksum IS NULL",
            [row.id, migration.checksum],
          );
        } else {
          if (!SHA256_PATTERN.test(row.checksum)) {
            throw new Error(`invalid stored checksum for migration ${row.id}`);
          }
          if (migration && row.checksum !== migration.checksum) {
            throw new Error(
              `migration checksum mismatch for ${row.id}: stored ${row.checksum}, image ${migration.checksum}`,
            );
          }
        }
        done.add(row.id);
      }

      const applied: string[] = [];
      for (const migration of migrations) {
        if (done.has(migration.id)) continue;
        await connection.query(migration.sql);
        await connection.query(
          "INSERT INTO mcp_schema_migrations (id, checksum) VALUES ($1, $2)",
          [migration.id, migration.checksum],
        );
        applied.push(migration.id);
      }
      await connection.query("ALTER TABLE mcp_schema_migrations ALTER COLUMN checksum SET NOT NULL");
      await connection.query("COMMIT");
      return applied;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    connection.release();
  }
}
