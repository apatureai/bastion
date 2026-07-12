import type {
  ApplicationJobRecord,
  ReserveJobResult,
  ReviewApplicationStore,
} from "./application-store.js";

export interface SqlResult<Row> { rows: Row[] }
export interface SqlConnection {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<SqlResult<Row>>;
  release(): void;
}
export interface SqlConnectionFactory { connect(): Promise<SqlConnection> }

type RecordRow = { record: ApplicationJobRecord };

/** PostgreSQL adapter for migrations/001_review_application.sql. Every transaction binds app.tenant_id for RLS. */
export class PostgresReviewApplicationStore implements ReviewApplicationStore {
  constructor(private readonly pool: SqlConnectionFactory) {}

  async ready(): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      await connection.query("SELECT 1 FROM mcp_review_jobs LIMIT 0");
      return true;
    } finally {
      connection.release();
    }
  }

  async reserve(record: ApplicationJobRecord): Promise<ReserveJobResult> {
    return this.transaction(record.tenantId, async (connection) => {
      const inserted = await connection.query(
        `INSERT INTO mcp_review_jobs
          (tenant_id, job_id, principal_id, client_request_id, normalized_request_hash,
           engine_job_id, status, record, expires_at, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
         ON CONFLICT (tenant_id, client_request_id) DO NOTHING
         RETURNING record`,
        [record.tenantId, record.job.job_id, record.principalId, record.clientRequestId,
          record.normalizedRequestHash, record.engineJobId, record.job.status,
          JSON.stringify(record), record.expiresAt, record.revision],
      );
      if (inserted.rows.length > 0) return { kind: "created", record };
      const existing = await this.selectByRequest(connection, record.tenantId, record.clientRequestId);
      if (!existing) throw new Error("idempotency conflict row disappeared");
      return existing.normalizedRequestHash === record.normalizedRequestHash
        ? { kind: "reused", record: existing }
        : { kind: "conflict", record: existing };
    });
  }

  async get(tenantId: string, jobId: string): Promise<ApplicationJobRecord | null> {
    return this.transaction(tenantId, async (connection) => {
      const result = await connection.query<RecordRow>(
        "SELECT record FROM mcp_review_jobs WHERE tenant_id=$1 AND job_id=$2",
        [tenantId, jobId],
      );
      return result.rows[0]?.record ?? null;
    });
  }

  async findByRequest(tenantId: string, clientRequestId: string): Promise<ApplicationJobRecord | null> {
    return this.transaction(tenantId, (connection) => this.selectByRequest(connection, tenantId, clientRequestId));
  }

  async update(
    tenantId: string,
    jobId: string,
    mutate: (record: ApplicationJobRecord) => ApplicationJobRecord,
  ): Promise<ApplicationJobRecord | null> {
    return this.transaction(tenantId, async (connection) => {
      const selected = await connection.query<RecordRow>(
        "SELECT record FROM mcp_review_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE",
        [tenantId, jobId],
      );
      const current = selected.rows[0]?.record;
      if (!current) return null;
      const next = mutate(structuredClone(current));
      if (next.tenantId !== tenantId || next.job.job_id !== jobId) {
        throw new Error("application store update cannot change tenant or job identity");
      }
      next.revision = current.revision + 1;
      await connection.query(
        `UPDATE mcp_review_jobs SET engine_job_id=$3, status=$4, record=$5::jsonb,
           expires_at=$6, revision=$7, updated_at=now()
         WHERE tenant_id=$1 AND job_id=$2`,
        [tenantId, jobId, next.engineJobId, next.job.status, JSON.stringify(next), next.expiresAt, next.revision],
      );
      return next;
    });
  }

  private async selectByRequest(connection: SqlConnection, tenantId: string, requestId: string) {
    const result = await connection.query<RecordRow>(
      "SELECT record FROM mcp_review_jobs WHERE tenant_id=$1 AND client_request_id=$2",
      [tenantId, requestId],
    );
    return result.rows[0]?.record ?? null;
  }

  private async transaction<T>(tenantId: string, fn: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}
