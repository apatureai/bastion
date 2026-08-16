export type {
  EngineSeverity,
  EngineViewport,
  EngineGrade,
  EngineConfidenceSource,
  EngineCalibrationReference,
  EngineConfidenceUnavailableReason,
  EngineDimension,
  EngineFinding,
  EngineReviewCoverage,
  EngineReviewResult,
  EngineRecheckOutcomeKind,
  EngineRecheckOutcome,
  EngineRecheckResult,
} from "./engine.js";
export { hasDisplayableEngineConfidence } from "./engine.js";
// Review coverage: the in-band "what did it actually look at?", the question
// next to provenance's "did anything judge it?". Neither answers the other.
export type { CoverageState } from "./coverage.js";
export {
  coverageState,
  hallucinationDrops,
  routesSkipped,
  skipped,
  suppressesGradeForCoverage,
  viewportsSkipped,
} from "./coverage.js";
export {
  SCHEMA_VERSION,
} from "./critique.js";
export type {
  JobStatus,
  JobKind,
  Job,
  Budget,
  CritiqueSeverity,
  Viewport,
  CritiqueGrade,
  CritiqueCoverage,
  CritiqueFinding,
  Critique,
  DesignReviewResult,
  DesignReviewGetResult,
  RecheckOutcomeKind,
  RecheckCaptureScope,
  RecheckOutcome,
  Recheck,
  DesignRecheckResult,
  UpstreamCancellation,
  DesignReviewCancelResult,
  TextContentBlock,
  ImageContentBlock,
  ResourceContentBlock,
  McpContentBlock,
  AnnotatedImage,
  HostMediaCapability,
  MultimediaCritiqueContent,
  DesignReviewContent,
} from "./critique.js";
// Judgment provenance: the in-band "did anything actually judge this page?"
// carried by every engine result and every agent-facing Critique.
export type { JudgmentSource, JudgmentProvenance } from "./provenance.js";
export { isModelBacked, isUnjudged } from "./provenance.js";
export { ERROR_CODES } from "./error.js";
export type { ReviewErrorCode, NextAction, ReviewError } from "./error.js";
export {
  GOLDEN_ENGINE_RESULT_PATH,
  PRE_CALIBRATION_ENGINE_RESULT_PATH,
  loadGoldenEngineResult,
  loadPreCalibrationEngineResult,
} from "./golden.js";
// Idea #64: interactive MCP-Apps review-panel contract: the actions the panel
// emits and the responses the host returns over the postMessage bridge.
export type { PanelFinding, PanelAction, PanelResponse } from "./panel.js";
