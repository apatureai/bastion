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

// --- D3: multimedia-native design_review result (issue #58) --------------
// Apature is inherently visual — a design-review tool that returns ANNOTATED
// SCREENSHOTS an agent can see has no text-only code-review equivalent. Aligned
// to the 2026-07-28 MCP spec's image content, with an HONEST capability
// downgrade: a host that cannot render images gets the text/structured result
// and is told which images were withheld, never a broken/absent block.

/** An MCP `text` content block. */
export type TextContentBlock = { type: "text"; text: string };

/**
 * An MCP `image` content block — base64-encoded image bytes + MIME type, per the
 * MCP multimedia content shape. Used for annotated screenshot crops.
 */
export type ImageContentBlock = { type: "image"; data: string; mimeType: string };

/**
 * An MCP `resource` content block carrying an embedded resource — used to deliver
 * the interactive MCP-Apps HTML review panel in-host (a `text/html` resource the
 * host renders in a sandboxed iframe): an annotated, in-host review surface
 * rather than a bare image.
 */
export type ResourceContentBlock = {
  type: "resource";
  resource: { uri: string; mimeType: string; text: string };
};

/** A content block in a multimedia MCP tool result. */
export type McpContentBlock = TextContentBlock | ImageContentBlock | ResourceContentBlock;

/**
 * An annotated screenshot crop for a finding, supplied by the engine/capture
 * plane (dependency-inverted: this surface shapes it into content, it does not
 * produce pixels). `evidenceId` matches `CritiqueFinding.evidence_id`.
 */
export type AnnotatedImage = {
  evidenceId: string;
  /** Base64-encoded image bytes. */
  data: string;
  /** An `image/*` MIME type (e.g. `image/png`). */
  mimeType: string;
};

/** What the calling host can render, negotiated per request (MCP capabilities). */
export type HostMediaCapability = {
  /** The host can render `image` content blocks (MCP multimedia). */
  images: boolean;
  /**
   * The host can render an MCP-Apps embedded HTML panel (a `resource` block the
   * host shows in a sandboxed iframe). Optional; treated as `false` when absent,
   * so a text/image-only host degrades honestly.
   */
  appsPanel?: boolean;
};

/**
 * The full `design_review` content result: the interactive panel (when the host
 * supports it) plus the multimedia findings, with honest downgrade flags for the
 * two surfaces the host may not render.
 */
export type DesignReviewContent = {
  content: McpContentBlock[];
  /** True when the interactive MCP-Apps HTML panel was emitted. */
  panel: boolean;
  /** True when a panel was available but withheld (host lacks MCP-Apps support). */
  panel_withheld: boolean;
  /** True when at least one annotated image block was emitted. */
  multimedia: boolean;
  /** `evidence_id`s whose annotated image was withheld for a non-multimedia host. */
  images_withheld: string[];
};

/**
 * A multimedia `design_review` result: the content blocks to return, whether any
 * image was actually emitted, and — for the honest downgrade — which annotated
 * images were withheld because the host cannot render them.
 */
export type MultimediaCritiqueContent = {
  content: McpContentBlock[];
  /** True when at least one image block was emitted (host supports images AND an image was available). */
  multimedia: boolean;
  /** `evidence_id`s whose annotated image was withheld for a non-multimedia host. */
  images_withheld: string[];
};
