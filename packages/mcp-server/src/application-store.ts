import type { Budget, Critique, Job, Recheck } from "@apature/mcp-types";
import type { NormalizedReviewRequest } from "./normalize.js";

/** Durable application state. Transport sessions never own these records. */
export interface ApplicationJobRecord {
  tenantId: string;
  principalId: string;
  job: Job;
  clientRequestId: string;
  normalizedRequestHash: string;
  request: NormalizedReviewRequest;
  engineJobId: string | null;
  critique: Critique | null;
  reviewId: string | null;
  resultPointer: string | null;
  viewLineage: Record<string, string | null>;
  budget: Budget;
  recheck: Recheck | null;
  recheckRequestHash: string | null;
  cancellationRequestedAt: string | null;
  cancellationDecision: string | null;
  expiresAt: string;
  revision: number;
}

export type ReserveJobResult =
  | { kind: "created"; record: ApplicationJobRecord }
  | { kind: "reused"; record: ApplicationJobRecord }
  | { kind: "conflict"; record: ApplicationJobRecord };

export interface ReviewApplicationStore {
  ready(): Promise<boolean>;
  reserve(record: ApplicationJobRecord): Promise<ReserveJobResult>;
  findByRequest(tenantId: string, clientRequestId: string): Promise<ApplicationJobRecord | null>;
  get(tenantId: string, jobId: string): Promise<ApplicationJobRecord | null>;
  update(
    tenantId: string,
    jobId: string,
    mutate: (record: ApplicationJobRecord) => ApplicationJobRecord,
  ): Promise<ApplicationJobRecord | null>;
}

/** Shared deterministic store used by tests. Atomicity follows the JS turn: reserve has no await before insert. */
export class InMemoryReviewApplicationStore implements ReviewApplicationStore {
  private readonly records = new Map<string, ApplicationJobRecord>();
  private readonly requestKeys = new Map<string, string>();
  private usable = true;

  setReady(ready: boolean): void {
    this.usable = ready;
  }

  async ready(): Promise<boolean> {
    return this.usable;
  }

  async reserve(record: ApplicationJobRecord): Promise<ReserveJobResult> {
    const requestKey = `${record.tenantId}\0${record.clientRequestId}`;
    const existingId = this.requestKeys.get(requestKey);
    if (existingId !== undefined) {
      const existing = this.records.get(`${record.tenantId}\0${existingId}`);
      if (!existing) throw new Error("idempotency index points at a missing application job");
      return existing.normalizedRequestHash === record.normalizedRequestHash
        ? { kind: "reused", record: structuredClone(existing) }
        : { kind: "conflict", record: structuredClone(existing) };
    }
    const key = `${record.tenantId}\0${record.job.job_id}`;
    this.records.set(key, structuredClone(record));
    this.requestKeys.set(requestKey, record.job.job_id);
    return { kind: "created", record: structuredClone(record) };
  }

  async get(tenantId: string, jobId: string): Promise<ApplicationJobRecord | null> {
    const record = this.records.get(`${tenantId}\0${jobId}`);
    return record ? structuredClone(record) : null;
  }

  async findByRequest(tenantId: string, clientRequestId: string): Promise<ApplicationJobRecord | null> {
    const jobId = this.requestKeys.get(`${tenantId}\0${clientRequestId}`);
    return jobId ? this.get(tenantId, jobId) : null;
  }

  async update(
    tenantId: string,
    jobId: string,
    mutate: (record: ApplicationJobRecord) => ApplicationJobRecord,
  ): Promise<ApplicationJobRecord | null> {
    const key = `${tenantId}\0${jobId}`;
    const current = this.records.get(key);
    if (!current) return null;
    const next = mutate(structuredClone(current));
    if (next.tenantId !== tenantId || next.job.job_id !== jobId) {
      throw new Error("application store update cannot change tenant or job identity");
    }
    next.revision = current.revision + 1;
    this.records.set(key, structuredClone(next));
    return structuredClone(next);
  }
}
