import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PgPoolConnectionFactory, runMcpMigrations } from "../src/pg.js";
import { bootProduction, type ProductionHandle } from "../src/production.js";

const databaseUrl = process.env.MCP_TEST_DATABASE_URL;
const handles: ProductionHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function scopedUrl(base: string, schema: string, applicationName: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

async function createSchema(base: string): Promise<{
  admin: pg.Client;
  drop(): Promise<void>;
  name: string;
}> {
  const name = `mcp_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${name}`);
  return {
    admin,
    name,
    drop: async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
      await admin.end();
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function productionEnv(port: number): NodeJS.ProcessEnv {
  return {
    MCP_RESOURCE_URL: "https://mcp.apature.test",
    MCP_AUTHORIZATION_SERVERS: "https://auth.apature.test",
    MCP_JWKS_URL: "https://auth.apature.test/jwks",
    MCP_TOKEN_ISSUER: "https://auth.apature.test",
    PORT: String(port),
    ENGINE_BASE_URL: "https://engine.internal.apature.test",
    ENGINE_HMAC_SECRET: "test-secret",
  };
}

const silent = { info: () => undefined, error: () => undefined };
const readyFetch: typeof fetch = async () => new Response("ok", { status: 200 });
const dnsResolver = { resolve: async () => ["93.184.216.34"] };

describe.skipIf(!databaseUrl)("production Postgres migration arbitration", () => {
  it("boots two production replicas concurrently and records each migration once", async () => {
    const schema = await createSchema(databaseUrl!);
    try {
      const factories = [
        new PgPoolConnectionFactory(scopedUrl(databaseUrl!, schema.name, "mcp_boot_a")),
        new PgPoolConnectionFactory(scopedUrl(databaseUrl!, schema.name, "mcp_boot_b")),
      ];
      const ports = await Promise.all([freePort(), freePort()]);
      const boot = factories.map((connectionFactory, index) =>
        bootProduction({
          connectionFactory,
          dnsResolver,
          env: productionEnv(ports[index]!),
          fetchImpl: readyFetch,
          logger: silent,
        }).then((handle) => {
          handles.push(handle);
          return handle;
        }),
      );
      const replicas = await Promise.all(boot);

      const readiness = await Promise.all(
        replicas.map(({ port }) => fetch(`http://127.0.0.1:${port}/readyz`)),
      );
      expect(readiness.every(({ status }) => status === 200)).toBe(true);
      const tracker = await schema.admin.query<{ count: number; id: string }>(
        `SELECT id, count(*)::int AS count
         FROM ${schema.name}.mcp_schema_migrations
         GROUP BY id ORDER BY id`,
      );
      expect(tracker.rows).toEqual([
        { id: "001_review_application", count: 1 },
        { id: "002_review_targets", count: 1 },
      ]);
    } finally {
      await Promise.all(handles.splice(0).map((handle) => handle.close()));
      await schema.drop();
    }
  });

  it("rolls back a killed migrator and releases the lock for another replica", async () => {
    const schema = await createSchema(databaseUrl!);
    const dir = mkdtempSync(join(tmpdir(), "mcp-kill-migration-"));
    const victimName = `mcp_migration_victim_${randomUUID().replaceAll("-", "")}`;
    const victim = new PgPoolConnectionFactory(
      scopedUrl(databaseUrl!, schema.name, victimName),
      5,
      () => undefined,
    );
    const successor = new PgPoolConnectionFactory(
      scopedUrl(databaseUrl!, schema.name, "mcp_migration_successor"),
    );
    try {
      writeFileSync(
        join(dir, "001_kill_probe.sql"),
        `CREATE TABLE migration_kill_probe (id integer PRIMARY KEY);
         SELECT pg_sleep(30)
         WHERE current_setting('application_name') = '${victimName}';\n`,
      );
      const first = runMcpMigrations(victim, dir);
      let pid: number | undefined;
      for (let attempt = 0; attempt < 200 && pid === undefined; attempt += 1) {
        const active = await schema.admin.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE application_name=$1 AND state='active' AND query LIKE '%pg_sleep%'`,
          [victimName],
        );
        pid = active.rows[0]?.pid;
        if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(pid).toBeDefined();
      expect((await schema.admin.query<{ stopped: boolean }>("SELECT pg_terminate_backend($1) AS stopped", [pid])).rows[0]?.stopped).toBe(true);
      await expect(first).rejects.toThrow();

      expect(await runMcpMigrations(successor, dir)).toEqual(["001_kill_probe"]);
      expect(
        (await schema.admin.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${schema.name}.mcp_schema_migrations
           WHERE id='001_kill_probe'`,
        )).rows[0]?.count,
      ).toBe(1);
      await schema.admin.query(`SELECT 1 FROM ${schema.name}.migration_kill_probe LIMIT 0`);
    } finally {
      await Promise.all([victim.end(), successor.end()]);
      rmSync(dir, { force: true, recursive: true });
      await schema.drop();
    }
  });
});
