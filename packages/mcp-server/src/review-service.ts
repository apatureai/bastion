import { createHash, randomUUID } from "node:crypto";
import type {
  Budget,
  Critique,
  DesignRecheckResult,
  DesignReviewGetResult,
  DesignReviewResult,
  Job,
  Recheck,
} from "@apature/mcp-types";
import { SCHEMA_VERSION } from "@apature/mcp-types";
import { mapEngineResultToCritique } from "./critique-map.js";
import type { EngineClient } from "./engine-client.js";
import { MockEngineClient } from "./engine-client.js";
import type { DesignRecheckInput, DesignReviewInput, NormalizedReviewRequest } from "./normalize.js";
import { normalizePreviewUrl, normalizeReviewRequest, requestFingerprint } from "./normalize.js";
import type { DnsResolver, TenantAllowlist } from "./target-auth.js";
import { authorizeTarget, canonicalizeTarget, TargetAuthError } from "./target-auth.js";
import type { RecheckLimitConfig, ThrottleKind } from "./rate-limit.js";
import { DEFAULT_RECHECK_LIMITS, RecheckLimiter } from "./rate-limit.js";

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

/** Why a recheck was rejected before any judgment ran (TRD §4.3). */
export type RecheckRejectionReason =
  | "review_not_found"
  | "review_not_completed"
  | "finding_not_found"
  | "host_changed"
  | "target_unchanged"
  | "recheck_limit_reached";

/** Raised when a recheck is rejected before enqueue; consumes zero units (§582). */
export class RecheckRejectedError extends Error {
  readonly reason: RecheckRejectionReason;
  constructor(reason: RecheckRejectionReason, message: string) {
    super(message);
    this.name = "RecheckRejectedError";
    this.reason = reason;
  }
}

/**
 * Raised when a recheck is throttled by a budget/rate limit/backoff (issue #5).
 * Carries `retryAfterMs` so the client can wait the right amount. Throttling
 * happens before unit reservation, so it consumes zero units (§9.3).
 */
export class RecheckThrottledError extends Error {
  readonly kind: ThrottleKind;
  readonly retryAfterMs: number;
  constructor(kind: ThrottleKind, retryAfterMs: number, message: string) {
    super(message);
    this.name = "RecheckThrottledError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
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
  /** Override the recheck budget/backoff/rate-limit defaults (issue #5). */
  recheckLimits?: Partial<RecheckLimitConfig>;
  /** Identity used for the per-principal recheck burst limit. */
  principalId?: string;
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
  /** review_id of the critique this job produced, if any. */
  reviewId: string | null;
};

/** A completed review, indexed for recheck lookups. */
type ReviewRecord = {
  reviewId: string;
  /** Full canonical URL the review targeted; a no-URL recheck reuses it exactly. */
  url: string;
  /** Canonical host the review targeted; a recheck on a different host is rejected. */
  host: string;
  /** Target fingerprint at review time — the "before" of a recheck. */
  beforeFingerprint: string;
  critique: Critique;
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
  private readonly limiter: RecheckLimiter;
  private readonly principalId: string;

  private readonly jobsById = new Map<string, JobRecord>();
  private readonly jobIdByRequestId = new Map<string, string>();
  private readonly reviewsById = new Map<string, ReviewRecord>();
  private readonly recheckByJobId = new Map<string, Recheck>();
  private tenantUnitsRemaining = TENANT_STARTING_UNITS;

  constructor(deps: ReviewServiceDeps = {}) {
    this.engine = deps.engine ?? new MockEngineClient();
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.allowlist = deps.allowlist ?? null;
    this.resolver = deps.resolver ?? null;
    this.principalId = deps.principalId ?? "principal";
    this.limiter = new RecheckLimiter({ ...DEFAULT_RECHECK_LIMITS, ...deps.recheckLimits });
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

    // P0 SSRF guard (issue #4): authorize the target before any job or charge.
    await this.authorizeTarget(request.url);

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

    this.jobsById.set(jobId, { job, request, fingerprint, critique, reviewId });
    this.jobIdByRequestId.set(request.client_request_id, jobId);
    this.reviewsById.set(reviewId, {
      reviewId,
      url: request.url,
      host: canonicalizeTarget(request.url).host,
      beforeFingerprint: targetFingerprint(request.url, request.expected_revision ?? undefined),
      critique,
    });

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

  /**
   * Submit a `design_recheck`: re-judge selected findings from a completed
   * review after the customer's agent changed the target (TRD §4.3).
   *
   * Ordering is deliberate so no unit is ever double-spent or spent on a no-op:
   *   1. idempotency short-circuit (an exact retry returns the original job);
   *   2. validate review ownership, completion, and finding membership;
   *   3. SSRF-authorize the (possibly new) URL — must stay on the prior host;
   *   4. reject `TARGET_UNCHANGED` and any finding over its recheck ceiling —
   *      all of which consume ZERO units (§582);
   *   5. only then reserve units, run the engine, and record counts.
   */
  async submitRecheck(input: DesignRecheckInput): Promise<DesignRecheckResult> {
    // (1) Idempotency: an exact retry returns the prior recheck job, no charge.
    const existingJobId = this.jobIdByRequestId.get(input.client_request_id);
    if (existingJobId) {
      const existing = this.jobsById.get(existingJobId);
      if (existing && existing.job.kind === "recheck") {
        return this.replayRecheck(existing);
      }
      if (existing) {
        throw new IdempotencyConflictError(
          "client_request_id was already used for a different job kind",
        );
      }
    }

    // (2) Validate the prior review.
    const review = this.reviewsById.get(input.review_id);
    if (!review) {
      throw new RecheckRejectedError("review_not_found", `no completed review ${input.review_id}`);
    }
    const knownFindingIds = new Set(review.critique.findings.map((f) => f.finding_id));
    const requested = dedupe(input.finding_ids);
    for (const id of requested) {
      if (!knownFindingIds.has(id)) {
        throw new RecheckRejectedError(
          "finding_not_found",
          `finding ${id} does not belong to review ${input.review_id}`,
        );
      }
    }

    // (3) Authorize the target. A recheck may pass a new URL, but only on the
    // SAME previously authorized host; a host change requires a new review.
    const url = input.url ? normalizePreviewUrl(input.url) : review.url;
    if (canonicalizeTarget(url).host !== review.host) {
      throw new RecheckRejectedError(
        "host_changed",
        "a recheck must target the same host as the original review",
      );
    }
    await this.authorizeTarget(url);

    // (4) Zero-unit rejection: an unchanged target runs no judgment (§4.3).
    const afterFingerprint = targetFingerprint(url, input.expected_revision ?? undefined);
    if (afterFingerprint === review.beforeFingerprint) {
      throw new RecheckRejectedError(
        "target_unchanged",
        "the target fingerprint is unchanged since the review; nothing to recheck",
      );
    }

    // (5) Budget / rate limit / backoff (issue #5). This is checked BEFORE any
    // unit is reserved, so a throttled recheck consumes zero units (§9.3). The
    // per-finding windows replace the old fixed ceiling; the chain-unit window,
    // principal burst, and exponential backoff guard against a storming loop.
    const units = Math.max(1, Math.ceil(requested.length / 3));
    const nowMs = this.now().getTime();
    const decision = this.limiter.check({
      principalId: this.principalId,
      reviewId: review.reviewId,
      findingIds: requested,
      units,
      now: nowMs,
    });
    if (!decision.allowed) {
      throw new RecheckThrottledError(
        decision.kind,
        decision.retryAfterMs,
        throttleMessage(decision.kind, decision.retryAfterMs),
      );
    }

    // (6) Reserve units and run the (mock) engine. focused units = ceil(n/3).
    const createdAt = this.now();
    const jobId = this.newId("job");
    const recheckId = this.newId("rck");

    const findingsById = new Map(review.critique.findings.map((f) => [f.finding_id, f]));
    const engineResult = await this.engine.recheck({
      reviewId: review.reviewId,
      url,
      beforeFingerprint: review.beforeFingerprint,
      afterFingerprint,
      findings: requested.map((id) => {
        const f = findingsById.get(id);
        return { findingId: id, route: f?.route ?? "/", element: f?.element_ref ?? null };
      }),
    });

    this.tenantUnitsRemaining = Math.max(0, this.tenantUnitsRemaining - units);
    // Record the spend against every rate-limit window only now that the recheck
    // has actually run, so a throttled or rejected attempt never burns a slot.
    this.limiter.commit({
      principalId: this.principalId,
      reviewId: review.reviewId,
      findingIds: requested,
      units,
      now: nowMs,
    });

    const recheck: Recheck = {
      recheck_id: recheckId,
      review_id: review.reviewId,
      before_fingerprint: engineResult.beforeFingerprint,
      after_fingerprint: engineResult.afterFingerprint,
      capture_scope: engineResult.captureScope,
      outcomes: engineResult.outcomes.map((o) => ({
        finding_id: o.findingId,
        outcome: o.outcome,
        confidence: o.confidence,
        reason: o.reason,
      })),
    };

    const completedAt = this.now();
    const job: Job = {
      job_id: jobId,
      status: "completed",
      kind: "recheck",
      stage: "finalizing",
      created_at: createdAt.toISOString(),
      completed_at: completedAt.toISOString(),
      poll_after_ms: POLL_AFTER_MS,
      expires_at: new Date(createdAt.getTime() + JOB_TTL_MS).toISOString(),
      reused: false,
    };

    this.jobsById.set(jobId, {
      job,
      request: {
        url,
        routes: [],
        viewports: [],
        depth: "deep",
        expected_revision: input.expected_revision ?? null,
        response_mode: "compact",
        client_request_id: input.client_request_id,
      },
      fingerprint: afterFingerprint,
      critique: null,
      reviewId: review.reviewId,
    });
    this.jobIdByRequestId.set(input.client_request_id, jobId);
    this.recheckByJobId.set(jobId, recheck);

    return {
      schema_version: SCHEMA_VERSION,
      job,
      recheck,
      budget: this.budget(units),
    };
  }

  /**
   * Run the SSRF guard for a URL (issue #4). Both-or-neither: configuring
   * exactly one of allowlist/resolver FAILS CLOSED rather than skipping the
   * guard. No-ops when neither is set (lower-level unit tests).
   */
  private async authorizeTarget(url: string): Promise<void> {
    if (!this.allowlist && !this.resolver) return;
    if (!this.allowlist || !this.resolver) {
      throw new TargetAuthError(
        "domain_unverified",
        "target authorization is misconfigured: both an allowlist and a resolver are required",
      );
    }
    await authorizeTarget(url, this.allowlist, this.resolver);
  }

  /** Replay a prior recheck job for an idempotent retry (no new charge). */
  private replayRecheck(record: JobRecord): DesignRecheckResult {
    const recheck = this.recheckByJobId.get(record.job.job_id);
    if (!recheck) {
      throw new JobNotFoundError(`recheck result missing for job ${record.job.job_id}`);
    }
    return {
      schema_version: SCHEMA_VERSION,
      job: { ...record.job, reused: true },
      recheck,
      budget: this.budget(0),
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

/**
 * A stable fingerprint of what is being captured at a target. The real engine
 * derives this from rendered content; here it is a deterministic hash of the
 * canonical URL plus any expected revision, so a recheck against an unchanged
 * target (same URL, same revision) compares equal and is rejected without
 * running judgment (TRD §4.3 `TARGET_UNCHANGED`).
 */
function targetFingerprint(url: string, expectedRevision?: string): string {
  return createHash("sha256").update(`${url}\n${expectedRevision ?? ""}`).digest("hex").slice(0, 32);
}

/** Human-readable message for a throttle decision (issue #5). */
function throttleMessage(kind: ThrottleKind, retryAfterMs: number): string {
  const secs = Math.ceil(retryAfterMs / 1000);
  switch (kind) {
    case "per_finding_30min":
      return `a flagged finding has hit its recheck limit for the half-hour; retry in ~${secs}s`;
    case "per_finding_day":
      return `a flagged finding has hit its daily recheck limit; retry in ~${secs}s`;
    case "chain_units_30min":
      return `this review's recheck budget for the half-hour is exhausted; retry in ~${secs}s`;
    case "principal_burst":
      return `too many rechecks submitted; slow down and retry in ~${secs}s`;
    case "backoff":
      return `rechecks are backing off; wait ~${secs}s before the next attempt`;
  }
}

/** De-duplicate a list of strings while preserving order. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
