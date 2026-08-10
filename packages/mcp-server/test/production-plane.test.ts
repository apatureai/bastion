import { PGlite } from "@electric-sql/pglite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApplicationJobRecord } from "../src/application-store.js";
import { PostgresReviewApplicationStore, type SqlConnection, type SqlConnectionFactory } from "../src/postgres-store.js";
import { MCP_MIGRATIONS_DIR, runMcpMigrations } from "../src/pg.js";
import { PostgresAllowlistResolver } from "../src/production-adapters.js";

/**
 * PGlite-backed factory implementing the production SqlConnectionFactory seam.
 * Parameterless statements route through exec (multi-statement migrations,
 * BEGIN/COMMIT); parameterized ones through the extended protocol.
 */
function pgliteFactory(db: PGlite): SqlConnectionFactory {
  const connection: SqlConnection = {
    query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      if (params && params.length > 0) {
        const result = await db.query(sql, [...params]);
        return { rows: result.rows as Row[] };
      }
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
    release: () => undefined,
  };
  return { connect: async () => connection };
}

function record(overrides: Partial<ApplicationJobRecord> = {}): ApplicationJobRecord {
  return {
    tenantId: "tenant_a",
    principalId: "principal_1",
    job: { job_id: "mcp_job_1", status: "queued" } as ApplicationJobRecord["job"],
    clientRequestId: "req-1",
    normalizedRequestHash: "hash-1",
    request: { url: "https://app.example.com/", depth: "deep" } as ApplicationJobRecord["request"],
    engineJobId: null,
    critique: null,
    reviewId: null,
    resultPointer: null,
    viewLineage: {},
    budget: { units_reserved: 1, units_settled: 0 } as unknown as ApplicationJobRecord["budget"],
    recheck: null,
    recheckRequestHash: null,
    cancellationRequestedAt: null,
    cancellationReason: null,
    cancellationDecision: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revision: 0,
    ...overrides,
  };
}

let db: PGlite;
let factory: SqlConnectionFactory;

beforeEach(async () => {
  db = new PGlite();
  factory = pgliteFactory(db);
});

describe("runMcpMigrations", () => {
  it("applies every migration once and is idempotent across boots", async () => {
    const first = await runMcpMigrations(factory, MCP_MIGRATIONS_DIR);
    expect(first).toEqual(["001_review_application", "002_review_targets"]);
    const second = await runMcpMigrations(factory, MCP_MIGRATIONS_DIR);
    expect(second).toEqual([]);
    const tracked = await db.query<{ checksum: string; id: string }>(
      "SELECT id, checksum FROM mcp_schema_migrations ORDER BY id",
    );
    expect(tracked.rows).toEqual([
      { id: "001_review_application", checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      { id: "002_review_targets", checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);
    // Both tables exist and answer.
    await db.query("SELECT 1 FROM mcp_review_jobs LIMIT 0");
    await db.query("SELECT 1 FROM mcp_review_targets LIMIT 0");
  });

  it("adopts legacy id-only rows once, then enforces immutable checksums", async () => {
    await db.exec(readFileSync(join(MCP_MIGRATIONS_DIR, "001_review_application.sql"), "utf8"));
    await db.exec(readFileSync(join(MCP_MIGRATIONS_DIR, "002_review_targets.sql"), "utf8"));
    await db.exec(
      `CREATE TABLE mcp_schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO mcp_schema_migrations (id) VALUES
        ('001_review_application'), ('002_review_targets');`,
    );

    expect(await runMcpMigrations(factory)).toEqual([]);
    const adopted = await db.query<{ checksum: string }>(
      "SELECT checksum FROM mcp_schema_migrations ORDER BY id",
    );
    expect(adopted.rows).toHaveLength(2);
    expect(adopted.rows.every(({ checksum }) => /^sha256:[0-9a-f]{64}$/.test(checksum))).toBe(true);

    const copied = mkdtempSync(join(tmpdir(), "mcp-migrations-"));
    try {
      cpSync(MCP_MIGRATIONS_DIR, copied, { recursive: true });
      const first = join(copied, "001_review_application.sql");
      writeFileSync(first, `${readFileSync(first, "utf8")}\n-- forbidden historical edit\n`);
      await expect(runMcpMigrations(factory, copied)).rejects.toThrow(
        /migration checksum mismatch for 001_review_application/,
      );
    } finally {
      rmSync(copied, { force: true, recursive: true });
    }
  });

  it("allows an older image to observe a checksum-pinned newer migration", async () => {
    await runMcpMigrations(factory);
    await db.query(
      "INSERT INTO mcp_schema_migrations (id, checksum) VALUES ($1, $2)",
      ["999_future_additive", `sha256:${"a".repeat(64)}`],
    );
    expect(await runMcpMigrations(factory)).toEqual([]);
    expect(
      (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM mcp_schema_migrations")).rows[0]?.count,
    ).toBe(3);
  });
});

describe("PostgresReviewApplicationStore (durable plane, #36)", () => {
  beforeEach(async () => {
    await runMcpMigrations(factory);
  });

  it("reserve is atomic on (tenant, client_request_id): created, reused, conflict", async () => {
    const store = new PostgresReviewApplicationStore(factory);
    const created = await store.reserve(record());
    expect(created.kind).toBe("created");

    // Same request replayed (reconnect/restart/second replica): reused, no new work.
    const reused = await store.reserve(record({ job: { job_id: "mcp_job_other", status: "queued" } as ApplicationJobRecord["job"] }));
    expect(reused.kind).toBe("reused");
    expect(reused.record.job.job_id).toBe("mcp_job_1");

    // Same client_request_id with a different normalized request: conflict.
    const conflict = await store.reserve(record({ normalizedRequestHash: "hash-2", job: { job_id: "mcp_job_2", status: "queued" } as ApplicationJobRecord["job"] }));
    expect(conflict.kind).toBe("conflict");
  });

  it("a second session/replica for the same tenant reads the original job; another tenant cannot", async () => {
    const storeA = new PostgresReviewApplicationStore(factory);
    await storeA.reserve(record());

    // "Another replica": a distinct store instance over the same database.
    const storeB = new PostgresReviewApplicationStore(factory);
    expect((await storeB.get("tenant_a", "mcp_job_1"))?.clientRequestId).toBe("req-1");
    expect(await storeB.findByRequest("tenant_a", "req-1")).not.toBeNull();

    // Wrong tenant: no record, no existence disclosure.
    expect(await storeB.get("tenant_b", "mcp_job_1")).toBeNull();
    expect(await storeB.findByRequest("tenant_b", "req-1")).toBeNull();
  });

  it("update bumps revision, persists mutations, and refuses identity changes", async () => {
    const store = new PostgresReviewApplicationStore(factory);
    await store.reserve(record());

    const updated = await store.update("tenant_a", "mcp_job_1", (current) => ({
      ...current,
      engineJobId: "engine_1",
      job: { ...current.job, status: "running" } as ApplicationJobRecord["job"],
    }));
    expect(updated?.engineJobId).toBe("engine_1");
    expect(updated?.revision).toBe(1);
    expect((await store.get("tenant_a", "mcp_job_1"))?.revision).toBe(1);

    await expect(
      store.update("tenant_a", "mcp_job_1", (current) => ({ ...current, tenantId: "tenant_b" })),
    ).rejects.toThrow(/cannot change tenant or job identity/);
    expect(await store.update("tenant_a", "missing_job", (r) => r)).toBeNull();
  });

  it("ready() is false before migrations and true after", async () => {
    const fresh = new PGlite();
    const freshFactory = pgliteFactory(fresh);
    const store = new PostgresReviewApplicationStore(freshFactory);
    await expect(store.ready()).rejects.toThrow(); // table missing surfaces as an error the caller catches
    await runMcpMigrations(freshFactory);
    expect(await store.ready()).toBe(true);
  });
});

describe("PostgresAllowlistResolver (ownership-verified registry, #36)", () => {
  beforeEach(async () => {
    await runMcpMigrations(factory);
    await db.query(
      `INSERT INTO mcp_review_targets (tenant_id, host, kind, verified_at, verification_method) VALUES
       ('tenant_a', 'app.example.com', 'host', now(), 'dns_txt'),
       ('tenant_a', 'preview.example.com', 'github_deployment', now(), 'github_deployment'),
       ('tenant_a', 'unverified.example.com', 'host', NULL, NULL),
       ('tenant_b', 'other.example.com', 'host', now(), 'dns_txt')`,
    );
  });

  it("serves only the tenant's verified targets", async () => {
    const resolver = new PostgresAllowlistResolver(factory);
    const allowlist = await resolver.resolve("tenant_a");
    expect(allowlist.tenantId).toBe("tenant_a");
    expect(allowlist.targets).toEqual([
      { kind: "host", host: "app.example.com" },
      { kind: "github_deployment", host: "preview.example.com" },
    ]);
    // Unverified rows never authorize; other tenants' rows never leak.
    expect(allowlist.targets.some((t) => t.host === "unverified.example.com")).toBe(false);
    expect((await resolver.resolve("tenant_b")).targets).toEqual([
      { kind: "host", host: "other.example.com" },
    ]);
    // Unknown tenant: empty allowlist (deny-by-default downstream), not an error.
    expect((await resolver.resolve("tenant_zzz")).targets).toEqual([]);
  });

  it("ready() reflects registry usability", async () => {
    const resolver = new PostgresAllowlistResolver(factory);
    expect(await resolver.ready()).toBe(true);
    const fresh = new PGlite();
    expect(await new PostgresAllowlistResolver(pgliteFactory(fresh)).ready()).toBe(false);
  });
});
