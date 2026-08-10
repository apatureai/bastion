import type {
  Critique,
  CritiqueFinding,
  CritiqueSeverity,
  EngineFinding,
  EngineReviewResult,
  EngineSeverity,
  JudgmentProvenance,
} from "@apature/mcp-types";
import { hasDisplayableEngineConfidence, isUnjudged } from "@apature/mcp-types";
import {
  NO_MODEL_DISCLOSURE_PREFIX,
  noModelDisclosure,
  UNATTESTED_PROVENANCE,
} from "./provenance.js";

/**
 * Map an engine `EngineReviewResult` into the agent-facing §6.4 Critique.
 *
 * The engine speaks a four-level severity scale and richer internal fields;
 * the agent surface collapses to three actionable levels and exposes
 * `element_ref` + a concrete suggestion on every finding so the customer's
 * agent can act in-loop without a second round trip (issue #1).
 *
 * This is also the single place where the "nothing judged this page" rule is
 * applied, deliberately, rather than in each backend. Every path into a
 * Critique goes through here: the synchronous engine call, the durable job
 * poll, the fixture engine and the real ones. Enforcing it once means the
 * fixture path cannot quietly skip what the verdict CLI adapter does.
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
 * `unjudged` is stamped on the ITEM, not only on the envelope, because the
 * envelope is not what gets read. An agent that iterates `findings[]` and
 * applies each `suggestion` never looks at `grade`, `overall` or `provenance`:
 * it holds one array element at a time, and at that scope byte-identical
 * fiction with no per-item marker is indistinguishable from a real finding. The
 * marker is the envelope's own word rather than a second scheme, and it appears
 * only on unjudged payloads, so its absence claims nothing on its own.
 */
function mapFinding(
  finding: EngineFinding,
  confidenceIsDisplayable: boolean,
  unjudged: boolean,
): CritiqueFinding {
  return {
    finding_id: finding.id,
    severity: mapSeverity(finding.severity),
    // The engine's rubric dimension (verdict#159), passed through
    // verbatim. Legacy results without it surface `null`: an explicit
    // "unavailable", never a dimension synthesized from severity.
    dimension: finding.dimension ?? null,
    title: finding.title,
    description: finding.description,
    route: finding.route,
    viewport: finding.viewport,
    element_ref: finding.element,
    suggestion: finding.suggestion,
    evidence_id: finding.screenshotId,
    confidence: confidenceIsDisplayable ? (finding.confidence ?? null) : null,
    ...(unjudged ? { unjudged: true as const } : {}),
  };
}

/**
 * The narrative for a result nothing judged. The engine's `overall` on these
 * paths describes a page that was never looked at (the golden fixture's is
 * about a fictional pricing page), and presenting that as a description of the
 * target is the same lie as the grade, just in prose. It is replaced, not
 * annotated: a caller that concatenates or truncates the field must not be able
 * to end up quoting the fiction.
 */
function unjudgedOverall(provenance: JudgmentProvenance): string {
  return (
    `No model judged this page, so there is no assessment of it: ${provenance.detail}. ` +
    "Any findings below are not observations of the target."
  );
}

/**
 * Prepend the disclosure unless an upstream adapter already added it. The
 * verdict CLI backend adds it at the engine boundary so the fact survives even
 * for a caller reading the raw `EngineReviewResult`; without this check that
 * result would carry the line twice.
 */
function withDisclosure(notReviewed: string[], provenance: JudgmentProvenance): string[] {
  if (notReviewed.some((entry) => entry.startsWith(NO_MODEL_DISCLOSURE_PREFIX))) return notReviewed;
  return [noModelDisclosure(provenance), ...notReviewed];
}

export function mapEngineResultToCritique(reviewId: string, result: EngineReviewResult): Critique {
  // An unstamped result is `unknown`, never assumed judged: `model_backed` is
  // null, so a consumer that requires a real judgment still refuses it.
  const provenance = result.provenance ?? UNATTESTED_PROVENANCE;
  // Only a provable `false` suppresses the grade. `null` is the remote-engine
  // case, where a real judgment may well have happened and blanking it would
  // destroy a true result; the payload discloses the uncertainty instead.
  const unjudged = isUnjudged(provenance);
  const confidenceIsDisplayable = !unjudged && hasDisplayableEngineConfidence(result);
  return {
    review_id: reviewId,
    grade: unjudged ? "unjudged" : result.grade,
    confidence: confidenceIsDisplayable ? result.confidence : null,
    overall: unjudged ? unjudgedOverall(provenance) : result.overall,
    findings: result.findings.map((finding) =>
      mapFinding(finding, confidenceIsDisplayable, unjudged),
    ),
    not_reviewed: unjudged ? withDisclosure(result.notReviewed, provenance) : result.notReviewed,
    provenance,
  };
}
