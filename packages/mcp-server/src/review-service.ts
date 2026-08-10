import { createHash, randomUUID } from "node:crypto";
import type {
  Budget,
  Critique,
  DesignRecheckResult,
  DesignReviewCancelResult,
  DesignReviewGetResult,
  DesignReviewResult,
  Job,
  JobStatus,
  Recheck,
  UpstreamCancellation,
} from "@apature/mcp-types";
import { SCHEMA_VERSION } from "@apature/mcp-types";
import { mapEngineResultToCritique } from "./critique-map.js";
import { isTerminalStatus, mapEngineStatusToMcp } from "./engine-cancel.js";
import type { EngineClient, EngineJobClient, EngineJobPoll } from "./engine-client.js";
import { MockEngineClient } from "./engine-client.js";
import { REVIEWS_CANCEL_SCOPE } from "./auth.js";
import type { DesignRecheckInput, DesignReviewInput } from "./normalize.js";
import { normalizePreviewUrl, normalizeReviewRequest, requestFingerprint } from "./normalize.js";
import type { DnsResolver, TenantAllowlist } from "./target-auth.js";
import { authorizeTarget, canonicalizeTarget, TargetAuthError } from "./target-auth.js";
import type { RecheckLimitConfig, ThrottleKind } from "./rate-limit.js";
import { DEFAULT_RECHECK_LIMITS, RecheckLimiter } from "./rate-limit.js";
import {
  InMemoryReviewApplicationStore,
  type ApplicationJobRecord,
  type ReviewApplicationStore,
} from "./application-store.js";

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

export class JobExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobExpiredError";
  }
}

/** Raised when a credential lacks the operation-specific cancel scope. */
export class InsufficientScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientScopeError";
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
  /** Fixture/local synchronous adapter. Production supplies `engineJobs`. */
  engine?: EngineClient;
  /** Durable Judgment Engine submit/poll/cancel adapter used by production. */
  engineJobs?: EngineJobClient;
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
  /** Durable, tenant-scoped application state shared by every transport session and replica. */
  store?: ReviewApplicationStore;
  /** Credential-derived tenant. It is part of every store key and never accepted from tool input. */
  tenantId?: string;
  /** Credential-derived OAuth scopes. Omit only in lower-level trusted tests. */
  scopes?: readonly string[];
};

const POLL_AFTER_MS = 1500;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const POLICY_VERSION = "budget-policy@1";
const UNITS_PER_REVIEW = 1;
const TENANT_STARTING_UNITS = 1000;

type JobRecord = ApplicationJobRecord;

/** A completed review, indexed for recheck lookups. */
type ReviewRecord = {
  reviewId: string;
  /** Full canonical URL the review targeted; a no-URL recheck reuses it exactly. */
  url: string;
  /** Canonical host the review targeted; a recheck on a different host is rejected. */
  host: string;
  /** Target fingerprint at review time: the "before" of a recheck. */
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
  private readonly engineJobs: EngineJobClient | null;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly allowlist: TenantAllowlist | null;
  private readonly resolver: DnsResolver | null;
  private readonly limiter: RecheckLimiter;
  private readonly principalId: string;
  private readonly tenantId: string;
  private readonly store: ReviewApplicationStore;
  private readonly scopes: ReadonlySet<string> | null;

  private readonly reviewsById = new Map<string, ReviewRecord>();
  private readonly recheckByJobId = new Map<string, Recheck>();
  /** job_id -> recheck-request body fingerprint, for idempotency parity (issue #10). */
  private readonly recheckFingerprintByJobId = new Map<string, string>();
  private tenantUnitsRemaining = TENANT_STARTING_UNITS;

  constructor(deps: ReviewServiceDeps = {}) {
    this.engine = deps.engine ?? new MockEngineClient();
    this.engineJobs = deps.engineJobs ?? null;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.allowlist = deps.allowlist ?? null;
    this.resolver = deps.resolver ?? null;
    this.principalId = deps.principalId ?? "principal";
    this.tenantId = deps.tenantId ?? "test-tenant";
    this.store = deps.store ?? new InMemoryReviewApplicationStore();
    this.scopes = deps.scopes ? new Set(deps.scopes) : null;
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

    // P0 SSRF guard (issue #4): authorize the target before any job or charge.
    await this.authorizeTarget(request.url);

    const createdAt = this.now();
    const jobId = this.newId("job");
    const reviewId = this.newId("rev");

    const queued: Job = {
      job_id: jobId,
      status: "queued",
      kind: "review",
      stage: "waiting_for_capacity",
      created_at: createdAt.toISOString(),
      poll_after_ms: POLL_AFTER_MS,
      expires_at: new Date(createdAt.getTime() + JOB_TTL_MS).toISOString(),
      reused: false,
    };
    const reservedBudget = { ...this.budget(UNITS_PER_REVIEW), units_consumed: 0 };
    const reserved: JobRecord = {
      tenantId: this.tenantId,
      principalId: this.principalId,
      job: queued,
      clientRequestId: request.client_request_id,
      normalizedRequestHash: fingerprint,
      request,
      engineJobId: null,
      critique: null,
      reviewId,
      resultPointer: null,
      viewLineage: {},
      budget: reservedBudget,
      recheck: null,
      recheckRequestHash: null,
      cancellationRequestedAt: null,
      cancellationReason: null,
      cancellationDecision: null,
      expiresAt: queued.expires_at,
      revision: 0,
    };
    const reservation = await this.store.reserve(reserved);
    if (reservation.kind === "conflict") {
      throw new IdempotencyConflictError(
        "client_request_id was reused with different normalized arguments",
      );
    }
    if (reservation.kind === "reused") {
      return {
        schema_version: SCHEMA_VERSION,
        job: { ...reservation.record.job, reused: true },
        budget: { ...reservation.record.budget, units_reserved: 0, units_consumed: 0 },
      };
    }

    if (this.engineJobs) {
      return this.submitDurableReview(reservation.record);
    }

    await this.store.update(this.tenantId, jobId, (record) => ({
      ...record,
      job: { ...record.job, status: "running", stage: "judging" },
    }));
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

    const settled = await this.store.update(this.tenantId, jobId, (record) => {
      // Cancellation and completion share this store transaction as their
      // linearization point. A cancel that already won suppresses the late result.
      if (record.job.status === "cancelled" || record.cancellationDecision === "cancel_won") return record;
      return {
        ...record,
        job,
        critique,
        reviewId,
        budget: this.budget(UNITS_PER_REVIEW),
        cancellationDecision: record.cancellationRequestedAt ? "completion_won" : null,
        viewLineage: {
          captureVersion: result.metadata.captureVersion,
          uiDnaVersion: result.metadata.uiDnaVersion,
          resultSchemaVersion: "1.0.0",
        },
      };
    });
    if (settled?.job.status === "completed" && settled.critique) {
      this.reviewsById.set(reviewId, {
        reviewId,
        url: request.url,
        host: canonicalizeTarget(request.url).host,
        beforeFingerprint: targetFingerprint(request.url, request.expected_revision ?? undefined),
        critique,
      });
    }

    return {
      schema_version: SCHEMA_VERSION,
      job: settled?.job ?? job,
      budget: this.budget(UNITS_PER_REVIEW),
    };
  }

  /**
   * Retrieve a job's status and (when complete) its Critique. Result reads never
   * consume review units (TRD §4.2). Raises `JobNotFoundError` for unknown ids.
   */
  async getReview(jobId: string): Promise<DesignReviewGetResult> {
    let record = await this.store.get(this.tenantId, jobId);
    if (!record || record.principalId !== this.principalId) {
      throw new JobNotFoundError(`no job with id ${jobId}`);
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new JobExpiredError(`job ${jobId} has expired`);
    }
    if (this.engineJobs && !isTerminalStatus(record.job.status) && record.engineJobId) {
      record = await this.refreshDurableReview(record);
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
   *   3. SSRF-authorize the (possibly new) URL, which must stay on the prior host;
   *   4. reject `TARGET_UNCHANGED` and any finding over its recheck ceiling,
   *      all of which consume ZERO units (§582);
   *   5. only then reserve units, run the engine, and record counts.
   */
  async submitRecheck(input: DesignRecheckInput): Promise<DesignRecheckResult> {
    // Normalize the URL up front: this rejects a userinfo/non-https recheck url
    // with NormalizationError (mapped to URL_NOT_ALLOWED) before any work or
    // charge (issue #11), and feeds the idempotency fingerprint below.
    const requestedUrl = input.url ? normalizePreviewUrl(input.url) : null;
    const fingerprint = recheckRequestFingerprint(input, requestedUrl);

    // (1) Idempotency: an exact retry returns the prior recheck job, no charge.
    // A reused client_request_id whose normalized body differs is a conflict, and
    // it must NOT silently replay the original result (issue #10). This is a
    // pre-reservation check, so a conflict still bills nothing.
    const existing = await this.findByClientRequestId(input.client_request_id);
    if (existing) {
      if (existing && existing.job.kind === "recheck") {
        if (existing.recheckRequestHash !== fingerprint) {
          throw new IdempotencyConflictError(
            "client_request_id was reused with different recheck arguments",
          );
        }
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
    const url = requestedUrl ?? review.url;
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

    const recheckRecord: JobRecord = {
      tenantId: this.tenantId,
      principalId: this.principalId,
      job,
      clientRequestId: input.client_request_id,
      normalizedRequestHash: fingerprint,
      request: {
        url,
        routes: [],
        viewports: [],
        depth: "deep",
        expected_revision: input.expected_revision ?? null,
        response_mode: "compact",
        client_request_id: input.client_request_id,
      },
      engineJobId: null,
      critique: null,
      reviewId: review.reviewId,
      resultPointer: null,
      viewLineage: {},
      budget: this.budget(units),
      recheck,
      recheckRequestHash: fingerprint,
      cancellationRequestedAt: null,
      cancellationReason: null,
      cancellationDecision: null,
      expiresAt: job.expires_at,
      revision: 0,
    };
    const recheckReservation = await this.store.reserve(recheckRecord);
    if (recheckReservation.kind !== "created") {
      throw new IdempotencyConflictError("client_request_id raced with another request");
    }
    this.recheckByJobId.set(jobId, recheck);
    this.recheckFingerprintByJobId.set(jobId, fingerprint);

    return {
      schema_version: SCHEMA_VERSION,
      job,
      recheck,
      budget: this.budget(units),
    };
  }

  /** Submit to the real async engine while keeping the MCP product job durable. */
  private async submitDurableReview(reserved: JobRecord): Promise<DesignReviewResult> {
    const jobId = reserved.job.job_id;
    const started = await this.store.update(this.tenantId, jobId, (current) => {
      if (current.job.status !== "queued") return current;
      return {
        ...current,
        job: { ...current.job, status: "running", stage: "submitting_to_engine" },
      };
    });
    if (!started) throw new JobNotFoundError(`no job with id ${jobId}`);
    if (started.job.status === "cancelled") {
      return { schema_version: SCHEMA_VERSION, job: started.job, budget: started.budget };
    }

    let engineJobId: string;
    try {
      engineJobId = await this.engineJobs!.submit(
        this.tenantId,
        reserved.clientRequestId,
        reserved.request,
        `mcp-${jobId}`,
      );
    } catch (error) {
      await this.store.update(this.tenantId, jobId, (current) => {
        if (isTerminalStatus(current.job.status)) return current;
        return {
          ...current,
          job: {
            ...current.job,
            status: "failed",
            stage: "engine_submit_failed",
            completed_at: this.now().toISOString(),
          },
          cancellationDecision: current.cancellationRequestedAt ? "submission_failed_after_cancel" : null,
        };
      });
      throw error;
    }

    let linked = await this.store.update(this.tenantId, jobId, (current) => ({
      ...current,
      engineJobId,
      job: isTerminalStatus(current.job.status)
        ? current.job
        : { ...current.job, status: "running", stage: "waiting_for_engine" },
    }));
    if (!linked) throw new JobNotFoundError(`no job with id ${jobId}`);

    // A cancel may have raced while the upstream submission was in flight.
    // Forward it using the persisted ENGINE id, never the MCP product id.
    if (linked.cancellationRequestedAt && !isTerminalStatus(linked.job.status)) {
      await this.cancelDurableReview(linked, linked.cancellationRequestedAt);
      linked = (await this.store.get(this.tenantId, jobId)) ?? linked;
    }

    return { schema_version: SCHEMA_VERSION, job: linked.job, budget: linked.budget };
  }

  /** Poll and durably project one upstream transition into the MCP job. */
  private async refreshDurableReview(record: JobRecord): Promise<JobRecord> {
    const poll = await this.engineJobs!.get(
      this.tenantId,
      record.engineJobId!,
      `mcp-${record.job.job_id}`,
    );
    const mapped = mapEngineJobPoll(poll);
    const reviewId = record.reviewId ?? this.newId("rev");
    const critique = poll.state === "completed" ? mapEngineResultToCritique(reviewId, poll.result) : null;
    const completedAt = mapped.terminal ? this.now().toISOString() : undefined;

    let completedHere = false;
    const settled = await this.store.update(this.tenantId, record.job.job_id, (current) => {
      // A terminal transition is the linearization point. Whichever side won
      // first is immutable, so a late engine result cannot revive cancellation.
      if (isTerminalStatus(current.job.status)) return current;
      completedHere = mapped.status === "completed";
      return {
        ...current,
        job: {
          ...current.job,
          status: mapped.status,
          stage: mapped.stage,
          ...(completedAt ? { completed_at: completedAt } : {}),
        },
        ...(critique ? { critique, reviewId } : {}),
        budget:
          mapped.status === "completed"
            ? { ...current.budget, units_consumed: current.budget.units_reserved }
            : current.budget,
        cancellationDecision:
          mapped.status === "cancelled"
            ? "cancel_won"
            : mapped.status === "completed" && current.cancellationRequestedAt
              ? "completion_won"
              : current.cancellationDecision,
        ...(poll.state === "completed"
          ? {
              viewLineage: {
                captureVersion: poll.result.metadata.captureVersion,
                uiDnaVersion: poll.result.metadata.uiDnaVersion,
                resultSchemaVersion: poll.schemaVersion,
              },
            }
          : {}),
      };
    });
    if (!settled) throw new JobNotFoundError(`no job with id ${record.job.job_id}`);

    if (completedHere) {
      this.tenantUnitsRemaining = Math.max(
        0,
        this.tenantUnitsRemaining - settled.budget.units_reserved,
      );
    }

    if (settled.job.status === "completed" && settled.critique && settled.reviewId) {
      this.reviewsById.set(settled.reviewId, {
        reviewId: settled.reviewId,
        url: settled.request.url,
        host: canonicalizeTarget(settled.request.url).host,
        beforeFingerprint: targetFingerprint(
          settled.request.url,
          settled.request.expected_revision ?? undefined,
        ),
        critique: settled.critique,
      });
    }
    return settled;
  }

  /** Forward cancellation to the persisted upstream job and project its ack. */
  private async cancelDurableReview(
    record: JobRecord,
    requestedAt: string,
  ): Promise<DesignReviewCancelResult> {
    const engineJobId = record.engineJobId;
    if (!engineJobId) {
      return this.cancelResult(record.job.job_id, "running", requestedAt, "requested");
    }
    const accepted = await this.engineJobs!.cancel(
      this.tenantId,
      engineJobId,
      `mcp-${record.job.job_id}`,
    );
    if (!accepted) {
      await this.store.update(this.tenantId, record.job.job_id, (current) => ({
        ...current,
        cancellationDecision: "engine_cancel_rejected",
      }));
      return this.cancelResult(record.job.job_id, record.job.status, requestedAt, "not_supported");
    }

    let poll: EngineJobPoll;
    try {
      poll = await this.engineJobs!.get(this.tenantId, engineJobId, `mcp-${record.job.job_id}`);
    } catch {
      await this.store.update(this.tenantId, record.job.job_id, (current) => ({
        ...current,
        cancellationDecision: "cancel_requested",
      }));
      return this.cancelResult(record.job.job_id, "running", requestedAt, "requested");
    }
    if (poll.state === "completed") {
      const completed = await this.refreshDurableReview(record);
      return this.cancelResult(record.job.job_id, completed.job.status, requestedAt, "requested");
    }
    const mapped = mapEngineJobPoll(poll);
    const externallyVisible = mapped.terminal ? mapped.status : "running";
    const settled = await this.store.update(this.tenantId, record.job.job_id, (current) => {
      if (isTerminalStatus(current.job.status)) return current;
      return {
        ...current,
        job: {
          ...current.job,
          status: externallyVisible,
          stage: mapped.status === "cancelled" ? "cancelled" : "cancelling",
          ...(mapped.terminal ? { completed_at: this.now().toISOString() } : {}),
        },
        cancellationDecision: mapped.status === "cancelled" ? "cancel_won" : "cancel_requested",
      };
    });
    const status = settled?.job.status ?? externallyVisible;
    return this.cancelResult(record.job.job_id, status, requestedAt, "requested");
  }

  /**
   * Request best-effort cancellation of a queued or running review/recheck job
   * (#32). Cancellation consumes no review units and preserves already-consumed
   * ledger truth. Semantics by current status:
   *   - unknown id            → `JobNotFoundError` (non-enumerating; the server
   *                             maps it to a generic JOB_NOT_FOUND).
   *   - already terminal       → idempotent no-op: return the existing status
   *                             with `upstream_cancellation: already_terminal`.
   *   - `queued`               → nothing started upstream, so MCP Review makes
   *                             it terminal `cancelled` itself (`not_needed`).
   *   - `running`              → ask the engine to cancel and map its post-cancel
   *                             poll (`engine-cancel.ts`): the job stays
   *                             externally `running` while cancellation is in
   *                             flight (`requested`) and only becomes terminal
   *                             `cancelled` once the engine confirms no late
   *                             result can publish. A missing/refusing engine
   *                             cancel surface reports `not_supported`.
   *
   * `cancellation_requested_at` is set once (first cancel) so a duplicate cancel
   * is idempotent. Production uses the durable async application store and the
   * persisted Judgment Engine job id; the synchronous branch remains only for
   * fixture/local compatibility.
   */
  async cancelReview(jobId: string, reason?: string): Promise<DesignReviewCancelResult> {
    if (this.scopes && !this.scopes.has(REVIEWS_CANCEL_SCOPE)) {
      throw new InsufficientScopeError(`cancelling a review requires ${REVIEWS_CANCEL_SCOPE}`);
    }
    let record = await this.store.get(this.tenantId, jobId);
    if (!record || record.principalId !== this.principalId) {
      throw new JobNotFoundError(`no job with id ${jobId}`);
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new JobExpiredError(`job ${jobId} has expired`);
    }
    if (record.cancellationRequestedAt === null) {
      record = await this.store.update(this.tenantId, jobId, (current) => ({
        ...current,
        cancellationRequestedAt: current.cancellationRequestedAt ?? this.now().toISOString(),
        cancellationReason: current.cancellationReason ?? reason ?? null,
      }));
      if (!record) throw new JobNotFoundError(`no job with id ${jobId}`);
    }
    const requestedAt = record.cancellationRequestedAt!;
    const status = record.job.status;

    if (isTerminalStatus(status)) {
      return this.cancelResult(jobId, status, requestedAt, "already_terminal");
    }

    if (status === "queued" && record.engineJobId === null) {
      await this.store.update(this.tenantId, jobId, (current) => ({
        ...current,
        job: { ...current.job, status: "cancelled", completed_at: this.now().toISOString() },
        cancellationDecision: "cancelled_before_start",
      }));
      return this.cancelResult(jobId, "cancelled", requestedAt, "not_needed");
    }

    if (this.engineJobs) {
      if (record.cancellationDecision === "cancel_requested" && record.engineJobId) {
        const refreshed = await this.refreshDurableReview(record);
        return this.cancelResult(jobId, refreshed.job.status, requestedAt, "requested");
      }
      // A concurrent submit may be between the durable start transition and
      // persisting the upstream id. Record the intent now; submitReview observes
      // it and immediately forwards cancellation once the id is known.
      if (!record.engineJobId) {
        await this.store.update(this.tenantId, jobId, (current) => ({
          ...current,
          cancellationDecision: "awaiting_engine_job_id",
        }));
        return this.cancelResult(jobId, "running", requestedAt, "requested");
      }
      return this.cancelDurableReview(record, requestedAt);
    }

    // status === "running": cooperative engine cancellation.
    if (!this.engine.cancel) {
      return this.cancelResult(jobId, status, requestedAt, "not_supported");
    }
    // The legacy fixture seam has no durable upstream id. Production never
    // reaches this branch: it always supplies `engineJobs` and uses the
    // persisted `engineJobId` path above.
    const ack = await this.engine.cancel(record.engineJobId ?? jobId);
    if (!ack.accepted) {
      return this.cancelResult(jobId, status, requestedAt, "not_supported");
    }
    const mapped = mapEngineStatusToMcp(ack.poll);
    await this.store.update(this.tenantId, jobId, (current) => ({
      ...current,
      job: {
        ...current.job,
        status: mapped.status,
        ...(mapped.terminal ? { completed_at: this.now().toISOString() } : {}),
      },
      cancellationDecision: mapped.terminal ? "cancel_won" : "cancel_requested",
    }));
    return this.cancelResult(jobId, mapped.status, requestedAt, "requested");
  }

  private cancelResult(
    jobId: string,
    status: JobStatus,
    requestedAt: string,
    upstream: UpstreamCancellation,
  ): DesignReviewCancelResult {
    return {
      schema_version: SCHEMA_VERSION,
      job_id: jobId,
      status,
      cancellation_requested_at: requestedAt,
      upstream_cancellation: upstream,
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
    const recheck = record.recheck ?? this.recheckByJobId.get(record.job.job_id);
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

  private async findByClientRequestId(clientRequestId: string): Promise<JobRecord | null> {
    return this.store.findByRequest(this.tenantId, clientRequestId);
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

/**
 * Stable fingerprint of a recheck request body (issue #10): the review, the
 * set of findings (order-independent), and the normalized URL. Two retries with
 * the same fingerprint are the "same request"; a reused client_request_id with
 * a different fingerprint is an IDEMPOTENCY_CONFLICT. The idempotency key and
 * expected_revision are intentionally excluded: the URL already carries the
 * target, and the revision only affects the after-fingerprint, not request
 * identity.
 */
function recheckRequestFingerprint(input: DesignRecheckInput, normalizedUrl: string | null): string {
  return JSON.stringify({
    review_id: input.review_id,
    finding_ids: dedupe(input.finding_ids).slice().sort(),
    url: normalizedUrl ?? "",
  });
}

function mapEngineJobPoll(
  poll: EngineJobPoll,
): { status: JobStatus; terminal: boolean; stage: string } {
  switch (poll.state) {
    case "pending":
      return { status: "queued", terminal: false, stage: "waiting_for_capacity" };
    case "running":
      return { status: "running", terminal: false, stage: "judging" };
    case "cancelling": {
      const mapped = mapEngineStatusToMcp({ state: "cancelling" });
      return { ...mapped, stage: "cancelling" };
    }
    case "completed":
      return { status: "completed", terminal: true, stage: "finalizing" };
    case "failed": {
      const mapped = mapEngineStatusToMcp({ state: "failed", error: poll.error });
      return { ...mapped, stage: mapped.status === "cancelled" ? "cancelled" : "failed" };
    }
  }
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
