import type {
  Critique,
  CritiqueFinding,
  CritiqueSeverity,
  EngineFinding,
  EngineReviewResult,
  EngineSeverity,
} from "@apature/mcp-types";

/**
 * Map an engine `EngineReviewResult` into the agent-facing §6.4 Critique.
 *
 * The engine speaks a four-level severity scale and richer internal fields;
 * the agent surface collapses to three actionable levels and exposes
 * `element_ref` + a concrete suggestion on every finding so the customer's
 * agent can act in-loop without a second round trip (issue #1).
 */

/** Collapse the engine's four-level severity into the agent-facing three. */
function mapSeverity(severity: EngineSeverity): CritiqueSeverity {
  switch (severity) {
    case "blocker":
      return "blocker";
    case "major":
    case "minor":
      return "should_fix";
    case "nit":
      return "nit";
  }
}

/**
 * Surfaced ONLY for results produced before the engine emitted confidence on
 * the wire (judgment-engine#150 closed mcp-review#13's upstream half). MCP
 * Review owns no capture or inference, so it never computes a confidence
 * locally — current results pass the engine's ceiling-capped signal through,
 * and pre-#150 stored results get this stable documented default.
 */
const LEGACY_RESULT_CONFIDENCE = 0.8;

function mapFinding(finding: EngineFinding): CritiqueFinding {
  return {
    finding_id: finding.id,
    severity: mapSeverity(finding.severity),
    // The engine's severity carries the original dimension of judgment; until a
    // dedicated dimension field lands upstream we surface the engine severity as
    // the dimension so the agent can group findings.
    dimension: finding.severity,
    title: finding.title,
    description: finding.description,
    route: finding.route,
    viewport: finding.viewport,
    element_ref: finding.element,
    suggestion: finding.suggestion,
    evidence_id: finding.screenshotId,
    confidence: finding.confidence ?? LEGACY_RESULT_CONFIDENCE,
  };
}

export function mapEngineResultToCritique(reviewId: string, result: EngineReviewResult): Critique {
  return {
    review_id: reviewId,
    grade: result.grade,
    confidence: result.confidence ?? LEGACY_RESULT_CONFIDENCE,
    overall: result.overall,
    findings: result.findings.map(mapFinding),
    not_reviewed: result.notReviewed,
  };
}
