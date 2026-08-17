/**
 * Agent-facing Bastion surface (TRD §6.4 Critique and the job/budget
 * envelopes from schemas/mcp-tools.json). These are the shapes returned to the
 * customer's coding agent over MCP. They are intentionally separate from the
 * engine boundary (`engine.ts`): the engine speaks in richer internal fields,
 * Bastion presents a compact, agent-ready Critique with `element_ref` and
 * concrete repair suggestions.
 */

import type { CoverageState } from "./coverage.js";
import type { EngineDimension, EngineMeasurementKind } from "./engine.js";
import type { JudgmentProvenance } from "./provenance.js";

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
/**
 * Agent-facing grade.
 *
 * `unjudged` is not an engine value and never comes from one: Bastion sets it,
 * and only it, whenever `provenance.model_backed` is `false`, which is to say
 * whenever this process can prove nothing looked at the page. It is an explicit
 * value rather than a null or an omitted field on purpose. A missing key reads
 * as an older payload and invites a default; a null reads as "the grade was not
 * computed yet". `unjudged` cannot be mistaken for either, survives a lossy
 * serializer that would drop a null, and is legible in a log line on its own.
 * It is deliberately outside the ship/blocked ordering, so a consumer comparing
 * against a threshold gets no answer instead of a flattering one.
 *
 * `nothing_reviewed` is the second such value and is not the same statement. It
 * is set whenever `coverage.routesReviewed` is empty: a model may well have been
 * called, and `provenance.model_backed` may well be `true`, but the run formed a
 * judgment about no route at all, so the `ship` the engine floors to describes
 * no page. It is separate from `unjudged` because the cause and the remedy
 * differ: `unjudged` means configure a critique backend, `nothing_reviewed`
 * means the configured backend judged nothing this run and should be re-run.
 * Both sit outside the ordering for the same reason.
 *
 * When both apply, the grade is `nothing_reviewed`, matching gate's rule that
 * coverage wins the title: an operator whose run judged no page is not helped by
 * being told the judgment stamp was missing too, and the payload still carries
 * both facts in `provenance` and `not_reviewed`.
 */
export type CritiqueGrade =
  | "ship"
  | "ship_with_nits"
  | "needs_work"
  | "blocked"
  | "unjudged"
  | "nothing_reviewed";

/**
 * What the run actually looked at, as the agent surface reports it.
 *
 * The engine states this as `coverage.routesReviewed` and friends (see
 * `EngineReviewCoverage`); this is that same object in this surface's own case,
 * exactly as the engine's `notReviewed` is presented here as `not_reviewed`. The
 * words do not change, only the casing convention of the payload they sit in.
 *
 * `state` is the classification a consumer would otherwise have to recompute,
 * and it is the same four-value vocabulary `apatureai/gate` uses.
 */
export type CritiqueCoverage = {
  /** `full`, `partial`, `nothing`, or `unstated` when the engine did not say. */
  state: CoverageState;
  /** Routes the review was asked to cover. */
  routes_requested: string[];
  /** Routes the run actually formed a judgment about. Empty means nothing was reviewed. */
  routes_reviewed: string[];
  /** Requested routes the run never judged, in requested order. */
  routes_skipped: string[];
  /** Viewports the review was asked to cover. */
  viewports_requested: Viewport[];
  /** Viewports actually captured and judged, across the reviewed routes. */
  viewports_reviewed: Viewport[];
  /** Requested viewports the run never judged, in requested order. */
  viewports_skipped: Viewport[];
};

/**
 * One agent-facing finding. Carries `element_ref` plus a concrete token/class
 * suggestion so the customer's agent can act without a second round trip
 * (issue #1 acceptance criteria).
 */
export type CritiqueFinding = {
  finding_id: string;
  severity: CritiqueSeverity;
  /**
   * The engine's rubric dimension (verdict#159), passed through verbatim
   * so the agent can group findings by reason category. `null` when the engine
   * result predates the field, an explicit "unavailable", never a value
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
  /**
   * Present, and always `true`, when nothing judged the page this finding
   * claims to describe: the same condition that replaces `grade` with
   * `"unjudged"` or `"nothing_reviewed"`. Both causes carry the one marker
   * rather than a second word each, because at item scope they mean the
   * identical thing to the agent: do not act on this as an observation.
   *
   * The envelope already says so, but an agent iterating `findings[]` and
   * applying each `suggestion` never reads the envelope. Every item therefore
   * carries the signal itself, in the envelope's own vocabulary rather than in
   * a second scheme. Absence means only "not provably unjudged": the envelope's
   * `provenance` and `coverage` stay the authority, and a consumer that requires
   * a real judgment still checks `provenance.model_backed === true` and
   * `coverage.state` there.
   */
  unjudged?: true;
};

/**
 * One violation the ENGINE measured, as the agent surface reports it.
 *
 * The single item in this payload an agent may act on without first checking
 * `provenance`. It has no severity, no confidence and no dimension, and that is
 * the point rather than an omission: nothing judged it, so nothing about it can
 * be wrong in the way a finding can be wrong. It is a `getComputedStyle` call
 * and a rectangle.
 *
 * It is NEVER stamped with the per-item `unjudged` marker that `CritiqueFinding`
 * carries. Marking it would tell an agent to discard the only trustworthy thing
 * in an unjudged payload, which is the opposite of what that marker exists for.
 */
export type CritiqueMeasurement = {
  kind: EngineMeasurementKind;
  route: string;
  /** Every viewport this exact violation was measured at. */
  viewports: Viewport[];
  /** Stable selector, the same vocabulary as `CritiqueFinding.element_ref`. */
  element_ref: string;
  /** The engine's factual sentence, verbatim. */
  detail: string;
  /**
   * The ENGINE's claim that this measurement is precise enough to gate on.
   * `false` does not mean it is wrong, only that acting on it automatically
   * would be. Bastion never computes or overrides it.
   */
  block_eligible: boolean;
};

/**
 * What the run MEASURED, present on every critique.
 *
 * `state` is `"reported"` when the engine sent a report and `"unstated"` when it
 * did not, and it is never synthesized: an `"unstated"` measurement block has
 * both arrays empty, and an agent must read that as "this engine does not
 * report measurements", never as "the page measured clean". That positive
 * statement is `state: "reported"` with a non-empty `checks_run` and an empty
 * `violations`.
 *
 * The same shape as `coverage` and for the same reason: a consumer should not
 * have to branch on a missing key, and a missing key invites a default.
 */
export type CritiqueMeasurements = {
  /** `reported` when the engine sent a report, `unstated` when it did not. */
  state: "reported" | "unstated";
  /** Which checks ran. Empty means nothing was measured. */
  checks_run: EngineMeasurementKind[];
  /** Deduped per (kind, route, element, detail), with viewports accumulated. */
  violations: CritiqueMeasurement[];
};

/** The §6.4 Critique object: overall verdict plus structured findings. */
export type Critique = {
  review_id: string;
  /** `unjudged` whenever `provenance.model_backed` is `false`. */
  grade: CritiqueGrade;
  /** Engine-produced aggregate confidence, or null when unavailable. */
  confidence: number | null;
  overall: string;
  findings: CritiqueFinding[];
  /** Routes/viewports the engine could not review, plus Bastion's own disclosures. */
  not_reviewed: string[];
  /**
   * What the run actually looked at. Present on EVERY critique; `state` is
   * `"unstated"` when the engine reported no coverage, which is never read as
   * "everything was reviewed".
   *
   * This is the second question a consumer has to ask, after `provenance`. An
   * engine can honestly stamp `model_backed: true` for a run that judged no
   * route, and that run arrives as `grade: "ship"` with `findings: []`. When
   * `state` is `"nothing"` the grade is replaced with `"nothing_reviewed"` and
   * nothing else in the payload is an assessment of the target.
   */
  coverage: CritiqueCoverage;
  /**
   * What the run measured, computed from the captured DOM with no model
   * involved. Present on EVERY critique, like `coverage` and `provenance`.
   *
   * It is carried unchanged on every path, including the unjudged one and the
   * nothing-reviewed one, where `grade`, `overall` and `findings` are all
   * suppressed or replaced. That asymmetry is deliberate and is the whole
   * reason this field exists: those three are suppressed because nothing
   * established them, and a measurement needs nothing to establish it.
   *
   * It never becomes a finding, never carries a severity or a confidence, and
   * never changes the grade.
   */
  measurements: CritiqueMeasurements;
  /**
   * How many model findings the engine's grounding gate deleted for citing a
   * route or an element the capture never produced, or `null` when the engine
   * reported no grounding gate. `null` and `0` are different answers: `0` means
   * the gate ran and deleted nothing.
   *
   * A positive value with an empty `findings` array is not a clean page. It is
   * a page the model had things to say about, none of which could be pointed at.
   * The grade is not suppressed for it, exactly as in gate: the routes were
   * judged and the grounding gate did its job. It is disclosed so a reader is
   * not left to assume the first reading.
   */
  hallucination_drops: number | null;
  /**
   * Where this judgment came from. Present on EVERY critique, on every path,
   * including the offline fixture path, and part of the tool-result contract in
   * schemas/mcp-tools.json rather than an incidental extra. It is the field a
   * consumer reading nothing but this JSON checks before believing anything
   * else in it.
   */
  provenance: JudgmentProvenance;
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

/**
 * Per-finding verdict after a recheck (TRD §4.3, never a forced boolean).
 *
 * `unjudged` is not an engine value and never comes from one, exactly like the
 * grade of the same name: Bastion substitutes it whenever
 * `provenance.model_backed` is `false`. `passed`, `failed` and `inconclusive`
 * all assert that something observed the target and reached (or failed to
 * reach) a conclusion about it; `inconclusive` in particular means "we looked
 * and could not tell", which is a different and far weaker claim than "nothing
 * looked". An agent uses this value to decide its fix landed and it can stop,
 * so the case where nothing looked needs a value of its own.
 */
export type RecheckOutcomeKind = "passed" | "failed" | "inconclusive" | "unjudged";

/**
 * Whether the recheck could focus capture on the flagged elements, or had to
 * fall back to a broader capture (disclosed in the result, TRD §531).
 */
export type RecheckCaptureScope = "focused" | "broad_fallback";

/** One finding's recheck outcome (schemas/mcp-tools.json design_recheck). */
export type RecheckOutcome = {
  finding_id: string;
  outcome: RecheckOutcomeKind;
  /**
   * The engine's confidence in this outcome, or `null` when there is nothing to
   * be confident about. Always `null` when `outcome` is `"unjudged"`: a number
   * attached to a verdict nobody reached is a fabricated number like any other.
   */
  confidence: number | null;
  reason: string;
};

/**
 * The recheck result: a before/after pair plus per-finding outcomes. Callers
 * read `outcomes` to learn which prior findings are resolved (`passed`),
 * persisting (`failed`), undecided (`inconclusive`), or never looked at
 * (`unjudged`).
 */
export type Recheck = {
  recheck_id: string;
  review_id: string;
  before_fingerprint: string;
  after_fingerprint: string;
  capture_scope: RecheckCaptureScope;
  outcomes: RecheckOutcome[];
  /**
   * Where this recheck came from, on the same terms as `Critique.provenance`
   * and for a sharper reason: the agent reads a recheck to decide its fix
   * landed and it can stop working. Present on every recheck, on every backend,
   * including the offline fixture path.
   */
  provenance: JudgmentProvenance;
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
 *  - `not_needed`:         the job was still queued; Bastion made it terminal
 *                          `cancelled` itself, no engine work was ever started.
 *  - `requested`:          the job was running; Bastion asked the engine to
 *                          cancel and the job stays `running` until a terminal
 *                          engine acknowledgement proves no late result can
 *                          publish.
 *  - `already_terminal`:   the job was already `completed`/`failed`/`cancelled`;
 *                          cancel is a no-op that returns the existing state.
 *  - `not_supported`:      the engine could not accept a cancel for this job.
 */
export type UpstreamCancellation = "not_needed" | "requested" | "not_supported" | "already_terminal";

/**
 * `design_review_cancel` response (schemas/mcp-tools.json outputSchema).
 * Best-effort cancellation of a queued or running review job; terminal jobs
 * keep their state. `status` is the job's externally-visible state AFTER the
 * cancel is applied. A running job whose engine cancel is in flight stays
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
// Apature is inherently visual: a design-review tool that returns ANNOTATED
// SCREENSHOTS an agent can see has no text-only code-review equivalent. Aligned
// to the 2026-07-28 MCP spec's image content, with an HONEST capability
// downgrade: a host that cannot render images gets the text/structured result
// and is told which images were withheld, never a broken/absent block.

/** An MCP `text` content block. */
export type TextContentBlock = { type: "text"; text: string };

/**
 * An MCP `image` content block: base64-encoded image bytes + MIME type, per the
 * MCP multimedia content shape. Used for annotated screenshot crops.
 */
export type ImageContentBlock = { type: "image"; data: string; mimeType: string };

/**
 * An MCP `resource` content block carrying an embedded resource, used to deliver
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
 * image was actually emitted, and, for the honest downgrade, which annotated
 * images were withheld because the host cannot render them.
 */
export type MultimediaCritiqueContent = {
  content: McpContentBlock[];
  /** True when at least one image block was emitted (host supports images AND an image was available). */
  multimedia: boolean;
  /** `evidence_id`s whose annotated image was withheld for a non-multimedia host. */
  images_withheld: string[];
};
