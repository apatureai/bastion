/**
 * Agent-facing MCP Review surface (TRD §6.4 Critique and the job/budget
 * envelopes from schemas/mcp-tools.json). These are the shapes returned to the
 * customer's coding agent over MCP. They are intentionally separate from the
 * engine boundary (`engine.ts`): the engine speaks in richer internal fields,
 * MCP Review presents a compact, agent-ready Critique with `element_ref` and
 * concrete repair suggestions.
 */

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
  dimension: string;
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
