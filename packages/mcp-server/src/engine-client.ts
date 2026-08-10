import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import type { EnginePollStatus } from "./engine-cancel.js";
import type { NormalizedReviewRequest } from "./normalize.js";
import { FIXTURE_PROVENANCE, stampProvenance } from "./provenance.js";

/**
 * The engine's acknowledgement of a cancel request (#32/#66). `accepted` is
 * false when the engine cannot cancel this job (unknown to the engine, or a
 * transport failure); the service maps that to `upstream_cancellation:
 * not_supported`. `poll` is the engine's post-cancel job status, usually
 * `cancelling` (non-terminal) or a terminal `failed`+`error:"canceled"`.
 */
export interface EngineCancelAck {
  accepted: boolean;
  poll: EnginePollStatus;
}

/** Poll result returned by Verdict's durable async job API. */
export type EngineJobPoll =
  | { jobId: string; state: "pending" | "running" | "cancelling" }
  | { jobId: string; state: "completed"; result: EngineReviewResult; schemaVersion: string }
  | { jobId: string; state: "failed"; error: string; schemaVersion: string };

/**
 * Production application-plane boundary. Unlike the fixture-oriented
 * `EngineClient` below, this preserves the upstream job id and never ties
 * capture/inference lifetime to one MCP request or transport session.
 */
export interface EngineJobClient {
  submit(
    installationId: string,
    idempotencyKey: string,
    request: NormalizedReviewRequest,
    correlationId?: string,
  ): Promise<string>;
  get(installationId: string, engineJobId: string, correlationId?: string): Promise<EngineJobPoll>;
  cancel(installationId: string, engineJobId: string, correlationId?: string): Promise<boolean>;
}

/**
 * A normalized recheck request as the engine receives it. The flagged findings
 * carry their prior route/viewport/element so the engine can focus capture
 * (TRD §4.3); `beforeFingerprint`/`afterFingerprint` bracket the change.
 */
export type EngineRecheckRequest = {
  reviewId: string;
  url: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  findings: Array<{ findingId: string; route: string; element: string | null }>;
};

/**
 * The engine boundary as Bastion sees it. The real implementation lives in
 * `apatureai/verdict`; Bastion only submits authorized targets and
 * reads results. This interface is the seam that lets tests and local runs use
 * a mock instead of capture + inference.
 */
export interface EngineClient {
  /**
   * Submit a review for an authorized, normalized target and return the engine
   * result. The real engine is asynchronous (capture + multimodal judgment);
   * this seam abstracts that so the tool layer stays transport-agnostic.
   */
  review(request: NormalizedReviewRequest): Promise<EngineReviewResult>;

  /**
   * Re-judge selected prior findings after the target changed, returning a
   * per-finding pass/fail/inconclusive verdict plus the before/after pair.
   */
  recheck(request: EngineRecheckRequest): Promise<EngineRecheckResult>;

  /**
   * Request cooperative cancellation of a running engine job (#66). Optional:
   * a client without a cancel surface reports `not_supported`. The real engine
   * aborts work and suppresses late writes; Bastion maps the returned poll
   * status through `engine-cancel.ts` and never marks a job terminally
   * `cancelled` until the engine proves no late result can publish.
   */
  cancel?(jobId: string): Promise<EngineCancelAck>;
}

/**
 * Mock engine backed by the golden fixture. Tests and local development MUST use
 * this, and it NEVER performs capture, calls a model, or reaches the network. It is
 * the only engine the test suite is allowed to touch.
 */
export class MockEngineClient implements EngineClient {
  /**
   * The golden fixture, stamped so the payload says what it is. Without the
   * stamp this method returns three specific, actionable, entirely invented
   * findings with nothing in-band marking them as fiction, which for an agent
   * consumer, the only kind of consumer that matters here, is indistinguishable
   * from a real review.
   */
  async review(_request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    return stampProvenance(loadGoldenEngineResult(), FIXTURE_PROVENANCE);
  }

  /**
   * Deterministic stand-in for a real recheck. With no capture or model
   * available, it derives a stable verdict from each finding id so tests are
   * reproducible: a finding "passes" (is resolved) unless its id hashes odd, in
   * which case it still "fails" (persists). Localizable findings (with an
   * element) are focused; otherwise the scope falls back to broad. This is a
   * fixture-grounded stand-in, NOT a judgment of any real UI.
   */
  async recheck(request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    const anyBroad = request.findings.some((f) => f.element === null);
    return {
      beforeFingerprint: request.beforeFingerprint,
      afterFingerprint: request.afterFingerprint,
      captureScope: anyBroad ? "broad_fallback" : "focused",
      outcomes: request.findings.map((f) => {
        const persists = stableParity(f.findingId) === 1;
        return persists
          ? {
              findingId: f.findingId,
              outcome: "failed" as const,
              confidence: 0.82,
              reason: "The flagged issue is still present after the change.",
            }
          : {
              findingId: f.findingId,
              outcome: "passed" as const,
              confidence: 0.86,
              reason: "The flagged issue is no longer observed at the target.",
            };
      }),
    };
  }

  /**
   * Deterministic cancel stand-in: the engine accepts and enters the
   * non-terminal `cancelling` state, so a test exercising the running-job
   * cancel path gets a stable "cancel requested, not yet terminal" ack. The
   * real engine's DELETE /jobs/:id is what production wires here.
   */
  async cancel(_jobId: string): Promise<EngineCancelAck> {
    return { accepted: true, poll: { state: "cancelling" } };
  }
}

/** Deterministic async job adapter for protocol/application tests only. */
export class MockEngineJobClient implements EngineJobClient {
  private readonly jobs = new Map<string, EngineReviewResult>();
  private readonly cancelled = new Set<string>();
  private sequence = 0;

  async submit(
    _installationId: string,
    _idempotencyKey: string,
    _request: NormalizedReviewRequest,
  ): Promise<string> {
    const jobId = `engine_mock_${++this.sequence}`;
    // Same rule as the synchronous mock: a fixture that reaches a consumer
    // unlabelled is the defect, so the async path stamps too.
    this.jobs.set(jobId, stampProvenance(loadGoldenEngineResult(), FIXTURE_PROVENANCE));
    return jobId;
  }

  async get(_installationId: string, engineJobId: string): Promise<EngineJobPoll> {
    if (this.cancelled.has(engineJobId)) {
      return { jobId: engineJobId, state: "failed", error: "canceled", schemaVersion: "1.0.0" };
    }
    const result = this.jobs.get(engineJobId);
    return result
      ? { jobId: engineJobId, state: "completed", result, schemaVersion: "1.0.0" }
      : { jobId: engineJobId, state: "failed", error: "not_found", schemaVersion: "1.0.0" };
  }

  async cancel(_installationId: string, engineJobId: string): Promise<boolean> {
    if (!this.jobs.has(engineJobId)) return false;
    this.cancelled.add(engineJobId);
    return true;
  }
}

/** Stable 0/1 parity of a string, used only by the deterministic mock. */
function stableParity(s: string): 0 | 1 {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum = (sum + s.charCodeAt(i)) % 2;
  return (sum % 2) as 0 | 1;
}
