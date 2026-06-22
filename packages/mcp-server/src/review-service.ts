import { randomUUID } from "node:crypto";
import type {
  Budget,
  Critique,
  DesignReviewGetResult,
  DesignReviewResult,
  Job,
} from "@apature/mcp-types";
import { SCHEMA_VERSION } from "@apature/mcp-types";
import { mapEngineResultToCritique } from "./critique-map.js";
import type { EngineClient } from "./engine-client.js";
import { MockEngineClient } from "./engine-client.js";
import type { DesignReviewInput, NormalizedReviewRequest } from "./normalize.js";
import { normalizeReviewRequest, requestFingerprint } from "./normalize.js";
import type { DnsResolver, TenantAllowlist } from "./target-auth.js";
import { authorizeTarget, TargetAuthError } from "./target-auth.js";

/** Raised when an idempotency key is reused with a different normalized request. */
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/** Raised when a job id does not exist for the tenant. */
export class JobNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobNotFoundError";
  }
}

/** Seams that make the service deterministic under test. */
export type ReviewServiceDeps = {
  engine?: EngineClient;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /**
   * The tenant's ownership-verified target allowlist (issue #4). When provided,
   * every submit is authorized against it before any job is created or charged.
   * Omitting it (lower-level unit tests) skips target authorization; the server
   * factory ALWAYS supplies one so the P0 SSRF guard is never bypassed in prod.
   */
  allowlist?: TenantAllowlist;
  /** DNS resolver seam used only when `allowlist` is set. Never real net in tests. */
  resolver?: DnsResolver;
};

const POLL_AFTER_MS = 1500;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const POLICY_VERSION = "budget-policy@1";
const UNITS_PER_REVIEW = 1;
const TENANT_STARTING_UNITS = 1000;

type JobRecord = {
  job: Job;
  request: NormalizedReviewRequest;
  fingerprint: string;
  critique: Critique | null;
};

/**
 * In-memory review service: normalizes requests, enforces idempotency, reserves
 * budget, runs the (mock) engine, and serves the resulting Critique.
 *
 * Persistence, real budgets, and auth are layered above/around this later; the
 * service is the unit under test for issue #1 and deliberately holds no real
 * network or model dependency.
 */
export class ReviewService {
  private readonly engine: EngineClient;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly allowlist: TenantAllowlist | null;
  private readonly resolver: DnsResolver | null;

  private readonly jobsById = new Map<string, JobRecord>();
  private readonly jobIdByRequestId = new Map<string, string>();
  private tenantUnitsRemaining = TENANT_STARTING_UNITS;

  constructor(deps: ReviewServiceDeps = {}) {
    this.engine = deps.engine ?? new MockEngineClient();
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.allowlist = deps.allowlist ?? null;
    this.resolver = deps.resolver ?? null;
  }

  /**
   * Submit a `design_review`. Idempotent on `client_request_id`: an exact retry
   * returns the original job with `reused: true`; a key reused with different
   * normalized arguments raises `IdempotencyConflictError` (TRD §4.1). The mock
   * engine runs synchronously, so the returned job is already `completed`.
   */
  async submitReview(input: DesignReviewInput): Promise<DesignReviewResult> {
    const request = normalizeReviewRequest(input);
    const fingerprint = requestFingerprint(request);

    const existingJobId = this.jobIdByRequestId.get(request.client_request_id);
    if (existingJobId) {
      const existing = this.jobsById.get(existingJobId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(
            "client_request_id was reused with different normalized arguments",
          );
        }
        return {
          schema_version: SCHEMA_VERSION,
          job: { ...existing.job, reused: true },
          budget: this.budget(0),
        };
      }
    }

    // P0 SSRF guard (issue #4): authorize the target against the tenant's
    // ownership-verified allowlist and the egress denylist BEFORE creating a job
    // or charging a unit. A `TargetAuthError` here is surfaced as a typed,
    // non-retriable tool error and no billable work happens.
    //
    // The allowlist and resolver are both-or-neither: configuring exactly one is
    // a misconfiguration that must FAIL CLOSED rather than silently skip the
    // guard, so a partial config can never let an unauthorized target through.
    if (this.allowlist || this.resolver) {
      if (!this.allowlist || !this.resolver) {
        throw new TargetAuthError(
          "domain_unverified",
          "target authorization is misconfigured: both an allowlist and a resolver are required",
        );
      }
      await authorizeTarget(request.url, this.allowlist, this.resolver);
    }

    const createdAt = this.now();
    const jobId = this.newId("job");
    const reviewId = this.newId("rev");

    const result = await this.engine.review(request);
    const critique = mapEngineResultToCritique(reviewId, result);

    this.tenantUnitsRemaining = Math.max(0, this.tenantUnitsRemaining - UNITS_PER_REVIEW);

    const completedAt = this.now();
    const job: Job = {
      job_id: jobId,
      status: "completed",
      kind: "review",
      stage: "finalizing",
      created_at: createdAt.toISOString(),
      completed_at: completedAt.toISOString(),
      poll_after_ms: POLL_AFTER_MS,
      expires_at: new Date(createdAt.getTime() + JOB_TTL_MS).toISOString(),
      reused: false,
    };

    this.jobsById.set(jobId, { job, request, fingerprint, critique });
    this.jobIdByRequestId.set(request.client_request_id, jobId);

    return {
      schema_version: SCHEMA_VERSION,
      job,
      budget: this.budget(UNITS_PER_REVIEW),
    };
  }

  /**
   * Retrieve a job's status and (when complete) its Critique. Result reads never
   * consume review units (TRD §4.2). Raises `JobNotFoundError` for unknown ids.
   */
  getReview(jobId: string): DesignReviewGetResult {
    const record = this.jobsById.get(jobId);
    if (!record) {
      throw new JobNotFoundError(`no job with id ${jobId}`);
    }
    return {
      schema_version: SCHEMA_VERSION,
      job: record.job,
      review: record.critique ?? undefined,
    };
  }

  private budget(unitsReserved: number): Budget {
    return {
      policy_version: POLICY_VERSION,
      units_reserved: unitsReserved,
      units_consumed: unitsReserved,
      tenant_units_remaining: this.tenantUnitsRemaining,
    };
  }
}
