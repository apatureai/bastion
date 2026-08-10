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
 */
export type EngineRecheckResult = {
  beforeFingerprint: string;
  afterFingerprint: string;
  captureScope: "focused" | "broad_fallback";
  outcomes: EngineRecheckOutcome[];
};
