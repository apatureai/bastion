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

function mapFinding(finding: EngineFinding): CritiqueFinding {
  return {
    finding_id: finding.id,
    severity: mapSeverity(finding.severity),
    // The engine's rubric dimension (judgment-engine#159), passed through
    // verbatim. Legacy results without it surface `null` — an explicit
    // "unavailable", never a dimension synthesized from severity.
    dimension: finding.dimension ?? null,
    title: finding.title,
    description: finding.description,
    route: finding.route,
    viewport: finding.viewport,
    element_ref: finding.element,
    suggestion: finding.suggestion,
    evidence_id: finding.screenshotId,
    confidence: finding.confidence ?? null,
  };
}

export function mapEngineResultToCritique(reviewId: string, result: EngineReviewResult): Critique {
  return {
    review_id: reviewId,
    grade: result.grade,
    confidence: result.confidence ?? null,
    overall: result.overall,
    findings: result.findings.map(mapFinding),
    not_reviewed: result.notReviewed,
  };
}
