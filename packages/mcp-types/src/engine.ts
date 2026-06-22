/**
 * Judgment Engine review-result boundary (the upstream contract MCP Review
 * consumes). This mirrors the proven `apatureai/gate` GateReviewResult shape so
 * the two repos share one boundary artifact and the mock engine cannot drift
 * from the live contract. MCP Review never owns capture, inference, or storage —
 * it only maps this result into the agent-facing Critique (see `critique.ts`).
 *
 * Nothing here may hard-code a specific judge model; the default is Qwen3-VL via
 * `judgment-engine`, carried opaquely in `metadata.model`.
 */

/** Engine-side severity scale (richer than the agent-facing three-level scale). */
export type EngineSeverity = "nit" | "minor" | "major" | "blocker";

/** Viewport the finding was observed on. */
export type EngineViewport = "mobile" | "tablet" | "desktop";

/** Overall verdict for a review. */
export type EngineGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

/** A single design-review finding produced by the engine. */
export type EngineFinding = {
  /** Stable id within a run; keys annotated screenshots and feedback. */
  id: string;
  severity: EngineSeverity;
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
};

/** The engine's review result, consumed but not owned by MCP Review. */
export type EngineReviewResult = {
  grade: EngineGrade;
  overall: string;
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
    uiDnaVersion: string | null;
  };
};
