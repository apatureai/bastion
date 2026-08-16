/**
 * Verdict review-result boundary (the upstream contract Bastion
 * consumes). This mirrors the proven `apatureai/gate` GateReviewResult shape so
 * the two repos share one boundary artifact and the mock engine cannot drift
 * from the live contract. Bastion never owns capture, inference, or storage;
 * it only maps this result into the agent-facing Critique (see `critique.ts`).
 *
 * Nothing here may hard-code a specific judge model; the default is Qwen3-VL via
 * `verdict`, carried opaquely in `metadata.model`.
 */

import type { JudgmentProvenance } from "./provenance.js";

/** Engine-side severity scale (richer than the agent-facing three-level scale). */
export type EngineSeverity = "nit" | "minor" | "major" | "blocker";

/** Viewport the finding was observed on. */
export type EngineViewport = "mobile" | "tablet" | "desktop";

/** Overall verdict for a review. */
export type EngineGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

export type EngineConfidenceSource =
  | "raw_verbalized"
  | "post_hoc_isotonic"
  | "post_hoc_histogram"
  | "hidden_state_probe"
  | "ensemble";

export type EngineCalibrationReference = {
  reportId: string;
  reportHash: `sha256:${string}`;
  calibrationVersion: string;
  confidenceSource: EngineConfidenceSource;
};

export type EngineConfidenceUnavailableReason =
  | "missing_calibration_report"
  | "invalid_calibration_report"
  | "mismatched_calibration_report"
  | "insufficient_evidence"
  | "unattested_calibration_report";

/** A single design-review finding produced by the engine. */
/** The engine's eight-value design rubric on the wire (verdict#159). */
export type EngineDimension =
  | "visual_hierarchy"
  | "spacing"
  | "color_contrast"
  | "typography"
  | "consistency"
  | "responsiveness"
  | "accessibility"
  | "brand";

export type EngineFinding = {
  /** Stable id within a run; keys annotated screenshots and feedback. */
  id: string;
  severity: EngineSeverity;
  /**
   * Rubric dimension the engine selected (verdict#159). Additive on
   * schema v1: newly produced results always carry it; optional only because
   * results produced before the field existed exist. When absent, consumers
   * surface the dimension as unavailable, never synthesizing one from severity.
   */
  dimension?: EngineDimension;
  title: string;
  description: string;
  route: string;
  viewport: EngineViewport;
  /** Best-effort element reference (selector/role), or null when not localizable. */
  element: string | null;
  /** Id of the annotated screenshot for this finding, or null. */
  screenshotId: string | null;
  /** Suggested remediation, or null. */
  suggestion: string | null;
  /**
   * Engine-produced confidence 0..1, capped upstream by the capture
   * confidence-ceiling (verdict#150, additive on schema v1). Optional
   * only because results produced before the engine emitted it exist; when
   * absent, consumers surface confidence as unavailable; they never compute
   * or synthesize a numeric value locally.
   */
  confidence?: number;
};

/**
 * What the engine's run actually looked at (verdict#165), stated structurally.
 *
 * The same shape under the same field names that `apatureai/gate` consumes as
 * `ReviewCoverage`. It is mirrored rather than reworded on purpose: gate and
 * Bastion read the identical bytes from the identical engine, and someone
 * reading both repositories must not have to learn two words for one field.
 *
 * Bastion needs it because a wire result always carries a `grade`, and a result
 * with zero surviving findings always grades `ship`: verdict floors the grade to
 * what the surviving findings support, and nothing supports better than `ship`.
 * That is correct for a genuinely clean page and INDISTINGUISHABLE, field for
 * field, from a run that judged nothing.
 *
 * `provenance` does not close that gap, which is the whole reason this field is
 * here. An engine truthfully stamps `model_backed: true` for a run whose triage
 * concluded a deep review was needed and then named no route to run it on: a
 * model really was called, and the page it was called about really was never
 * judged. `provenance` answers "did a model judge?"; this answers "what did it
 * judge?". Neither substitutes for the other.
 *
 * `notReviewed` cannot close it either, and the golden fixture is the proof: it
 * skips `/checkout` and the tablet viewport while carrying real findings on the
 * routes it did review. A rule of "zero findings plus a non-empty `notReviewed`
 * is not a pass" would punish that run for being honest about a partial, and
 * `notReviewed` is free prose a producer may leave empty besides.
 *
 * Identifiers rather than counts, so a consumer can NAME what was skipped.
 * Optional and additive under schema v1: a producer that cannot answer honestly
 * omits the field, and Bastion reads absence as "not stated", never as
 * "everything was reviewed".
 */
export type EngineReviewCoverage = {
  /** Routes the review was asked to cover. */
  routesRequested: string[];
  /** Routes the run actually formed a judgment about. Empty means nothing was reviewed. */
  routesReviewed: string[];
  /** Viewports the review was asked to cover. */
  viewportsRequested: EngineViewport[];
  /** Viewports actually captured and judged, across the reviewed routes. */
  viewportsReviewed: EngineViewport[];
};

/** The engine's review result, consumed but not owned by Bastion. */
export type EngineReviewResult = {
  grade: EngineGrade;
  overall: string;
  /**
   * Engine-owned result-level confidence 0..1 (verdict#150): the min
   * over finding confidences, 1 for a clean result. Same optionality rationale
   * as `EngineFinding.confidence`.
   */
  confidence?: number;
  /** Exact promoted calibration artifact for every numeric confidence. */
  calibration?: EngineCalibrationReference;
  /** Explicit engine promotion mode; Bastion never derives it from a score. */
  blockingEnabled?: boolean;
  /** Why confidence was withheld on a current fail-closed result. */
  confidenceUnavailableReason?: EngineConfidenceUnavailableReason;
  findings: EngineFinding[];
  /** Routes/viewports/previews the engine skipped. */
  notReviewed: string[];
  /**
   * What the run actually looked at (verdict#165), additive and optional under
   * schema v1. Absent means "this producer does not report coverage", never
   * "everything was reviewed". Bastion reads it in `coverageState()` and refuses
   * to report a grade when nothing was reviewed. See `EngineReviewCoverage`.
   */
  coverage?: EngineReviewCoverage;
  /**
   * How many model findings the engine's grounding gate deleted because they
   * cited a route or an element the capture never produced.
   *
   * This is the difference between "the page is clean" and "the model produced
   * four findings and not one of them could be pointed at", and both arrive here
   * as `findings: []` under a `ship` grade. The engine knows which happened;
   * without this field it is the only party that does, and an agent reading the
   * empty array concludes the first. Optional and additive: a producer that runs
   * no grounding gate omits it, and absence means "not stated" rather than zero.
   */
  hallucinationDrops?: number;
  /**
   * The engine retracting its own grade, in its own words.
   *
   * `grade` is required, so an engine whose every finding was deleted before it
   * could be reported still has to put something there and it floors to `ship`.
   * Coverage cannot express that case: the route WAS reviewed, so coverage is
   * full and truthful while the grade means nothing.
   *
   * Any non-empty value means the grade is unusable. The reasons are not
   * enumerated here on purpose: a reason this server has not been taught is
   * still a retraction, and refusing an unknown value would turn an honest
   * engine into a parse failure.
   */
  gradeUnavailableReason?: string;
  artifacts: {
    annotatedScreenshots: Array<{ findingId: string; url: string }>;
    engineDebugUrl?: string;
  };
  screenshotRetentionSeconds: number;
  metadata: {
    engineVersion: string;
    /** The judge model the engine used (e.g. Qwen3-VL). Never hard-coded here. */
    model: string;
    promptVersion: string;
    captureVersion: string;
    rubricVersion?: string;
    uiDnaVersion: string | null;
  };
  /**
   * Bastion's own attestation of where this result came from, attached by the
   * adapter that produced or fetched it. It is NOT part of the engine contract
   * and is never read from an engine payload: `parseEngineReviewResult` strips
   * any `provenance` that arrives on the wire, and each adapter then stamps its
   * own, so a backend cannot assert that a model judged a page when none did.
   *
   * It rides here rather than only on the mapped Critique because a durable
   * job stores the engine result and maps it later, possibly in another
   * process; carrying the fact with the result is what keeps the fixture path
   * and the async path from disagreeing.
   *
   * Optional only so a result constructed before this field existed still
   * typechecks; an unstamped result is mapped as `unknown` provenance, never as
   * a judgment.
   */
  provenance?: JudgmentProvenance;
};

const CONFIDENCE_SOURCES: readonly EngineConfidenceSource[] = [
  "raw_verbalized",
  "post_hoc_isotonic",
  "post_hoc_histogram",
  "hidden_state_probe",
  "ensemble",
];

/** True only when every score is backed by well-formed promoted-report provenance. */
export function hasDisplayableEngineConfidence(
  result: EngineReviewResult,
): result is EngineReviewResult & {
  confidence: number;
  calibration: EngineCalibrationReference;
  findings: Array<EngineFinding & { confidence: number }>;
} {
  const calibration = result.calibration;
  return (
    calibration != null &&
    typeof calibration.reportId === "string" &&
    calibration.reportId.length > 0 &&
    typeof calibration.reportHash === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(calibration.reportHash) &&
    typeof calibration.calibrationVersion === "string" &&
    calibration.calibrationVersion.length > 0 &&
    typeof calibration.confidenceSource === "string" &&
    (CONFIDENCE_SOURCES as readonly string[]).includes(calibration.confidenceSource) &&
    result.confidenceUnavailableReason === undefined &&
    Array.isArray(result.findings) &&
    result.findings.length > 0 &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    result.findings.every(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        typeof finding.confidence === "number" &&
        Number.isFinite(finding.confidence) &&
        finding.confidence >= 0 &&
        finding.confidence <= 1,
    )
  );
}

/** Per-finding recheck verdict from the engine (never a forced boolean). */
export type EngineRecheckOutcomeKind = "passed" | "failed" | "inconclusive";

/** One finding's recheck verdict as the engine reports it. */
export type EngineRecheckOutcome = {
  findingId: string;
  outcome: EngineRecheckOutcomeKind;
  confidence: number;
  reason: string;
};

/**
 * The engine's recheck result: a re-judgment of selected prior findings after
 * the target changed. `captureScope` discloses whether the engine could focus
 * capture on the flagged elements or had to fall back to a broader capture.
 *
 * `provenance` is Bastion's attestation, stamped by the adapter that produced
 * the result, exactly as on `EngineReviewResult`. A recheck is the payload an
 * agent reads to decide its fix landed and that it can stop, so "did anything
 * look at the target" has to be answerable here too. It is optional only so a
 * custom adapter that does not attest still compiles; an unstamped result is
 * read as `unknown`, never as judged.
 */
export type EngineRecheckResult = {
  beforeFingerprint: string;
  afterFingerprint: string;
  captureScope: "focused" | "broad_fallback";
  outcomes: EngineRecheckOutcome[];
  provenance?: JudgmentProvenance;
};
