/**
 * Agent-facing MCP Review surface (TRD §6.4 Critique and the job/budget
 * envelopes from schemas/mcp-tools.json). These are the shapes returned to the
 * customer's coding agent over MCP. They are intentionally separate from the
 * engine boundary (`engine.ts`): the engine speaks in richer internal fields,
 * MCP Review presents a compact, agent-ready Critique with `element_ref` and
 * concrete repair suggestions.
 */

import type { EngineDimension } from "./engine.js";

export const SCHEMA_VERSION = "1.0.0" as const;

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobKind = "review" | "recheck";

/** Async job envelope returned by submit and surfaced by every get. */
export type Job = {
  job_id: string;
  status: JobStatus;
  kind: JobKind;
  stage?: string;
  created_at: string;
  completed_at?: string;
  poll_after_ms: number;
  expires_at: string;
  /** True when an idempotent retry returned a pre-existing job. */
  reused: boolean;
};

/** Metered-usage envelope returned alongside billable submissions. */
export type Budget = {
  policy_version: string;
  units_reserved: number;
  units_consumed?: number;
  tenant_units_remaining: number;
  repo_units_remaining_hour?: number;
};

/** Three-level, agent-facing severity (collapsed from the engine scale). */
export type CritiqueSeverity = "blocker" | "should_fix" | "nit";
export type Viewport = "mobile" | "tablet" | "desktop";
export type CritiqueGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

/**
 * One agent-facing finding. Carries `element_ref` plus a concrete token/class
 * suggestion so the customer's agent can act without a second round trip
 * (issue #1 acceptance criteria).
 */
export type CritiqueFinding = {
  finding_id: string;
  severity: CritiqueSeverity;
  /**
   * The engine's rubric dimension (judgment-engine#159), passed through verbatim
   * so the agent can group findings by reason category. `null` when the engine
   * result predates the field — an explicit "unavailable", never a value
   * synthesized from severity.
   */
  dimension: EngineDimension | null;
  title: string;
  description: string;
  route: string;
  viewport: Viewport;
  /** Selector/role hint, or null when the finding is not localizable. */
  element_ref: string | null;
  /** Concrete repair constraint (token/class), or null. */
  suggestion: string | null;
  /** Evidence ref for the annotated screenshot, or null. */
  evidence_id: string | null;
  /** Engine-produced confidence, or null for an uncalibrated legacy result. */
  confidence: number | null;
};

/** The §6.4 Critique object: overall verdict plus structured findings. */
export type Critique = {
  review_id: string;
  grade: CritiqueGrade;
  /** Engine-produced aggregate confidence, or null when unavailable. */
  confidence: number | null;
  overall: string;
  findings: CritiqueFinding[];
  /** Routes/viewports the engine could not review. */
  not_reviewed: string[];
};

/** `design_review` submit response (schemas/mcp-tools.json outputSchema). */
export type DesignReviewResult = {
  schema_version: typeof SCHEMA_VERSION;
  job: Job;
  budget: Budget;
};

/** `design_review_get` response for the `summary` and `findings` views. */
export type DesignReviewGetResult = {
  schema_version: typeof SCHEMA_VERSION;
  job: Job;
  review?: Critique;
};

/** Per-finding verdict after a recheck (TRD §4.3 — never a forced boolean). */
export type RecheckOutcomeKind = "passed" | "failed" | "inconclusive";

/**
 * Whether the recheck could focus capture on the flagged elements, or had to
 * fall back to a broader capture (disclosed in the result, TRD §531).
 */
export type RecheckCaptureScope = "focused" | "broad_fallback";

/** One finding's recheck outcome (schemas/mcp-tools.json design_recheck). */
export type RecheckOutcome = {
  finding_id: string;
  outcome: RecheckOutcomeKind;
  confidence: number;
  reason: string;
};

/**
 * The recheck result: a before/after pair plus per-finding outcomes. Callers
 * read `outcomes` to learn which prior findings are resolved (`passed`),
 * persisting (`failed`), or undecided (`inconclusive`).
 */
export type Recheck = {
  recheck_id: string;
  review_id: string;
  before_fingerprint: string;
  after_fingerprint: string;
  capture_scope: RecheckCaptureScope;
  outcomes: RecheckOutcome[];
};

/** `design_recheck` response (schemas/mcp-tools.json outputSchema). */
export type DesignRecheckResult = {
  schema_version: typeof SCHEMA_VERSION;
  job: Job;
  recheck: Recheck;
  budget: Budget;
};

/**
 * What cancellation asked of the upstream engine (schemas/mcp-tools.json
 * design_review_cancel outputSchema):
 *  - `not_needed`        — the job was still queued; MCP Review made it terminal
 *                          `cancelled` itself, no engine work was ever started.
 *  - `requested`         — the job was running; MCP Review asked the engine to
 *                          cancel and the job stays `running` until a terminal
 *                          engine acknowledgement proves no late result can
 *                          publish.
 *  - `already_terminal`  — the job was already `completed`/`failed`/`cancelled`;
 *                          cancel is a no-op that returns the existing state.
 *  - `not_supported`     — the engine could not accept a cancel for this job.
 */
export type UpstreamCancellation = "not_needed" | "requested" | "not_supported" | "already_terminal";

/**
 * `design_review_cancel` response (schemas/mcp-tools.json outputSchema).
 * Best-effort cancellation of a queued or running review job; terminal jobs
 * keep their state. `status` is the job's externally-visible state AFTER the
 * cancel is applied — a running job whose engine cancel is in flight stays
 * `running` (never a synthetic `cancelling`), disclosing progress only through
 * `upstream_cancellation`. Cancellation consumes no review units.
 */
export type DesignReviewCancelResult = {
  schema_version: typeof SCHEMA_VERSION;
  job_id: string;
  status: JobStatus;
  cancellation_requested_at: string;
  upstream_cancellation: UpstreamCancellation;
};
