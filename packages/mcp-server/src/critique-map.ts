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
    // DELIBERATE PLACEHOLDER (tracked in issue #13). The engine boundary
    // (`EngineFinding`) does not yet carry a per-finding confidence, and MCP
    // Review owns no capture or inference, so any number computed here would be
    // fabricated. We surface a stable calibrated default rather than invent
    // precision; the real fix is upstream (engine emits confidence -> pass it
    // through). Do NOT replace this with a locally-computed score.
    confidence: 0.8,
  };
}

export function mapEngineResultToCritique(reviewId: string, result: EngineReviewResult): Critique {
  return {
    review_id: reviewId,
    grade: result.grade,
    // DELIBERATE PLACEHOLDER (tracked in issue #13). Same rationale as the
    // per-finding confidence above: the engine boundary does not yet emit an
    // overall confidence, so we surface a stable calibrated default instead of
    // fabricating one. Replace only once the engine carries a real signal.
    confidence: 0.8,
    overall: result.overall,
    findings: result.findings.map(mapFinding),
    not_reviewed: result.notReviewed,
  };
}
