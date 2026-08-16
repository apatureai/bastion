import type {
  Critique,
  CritiqueCoverage,
  CritiqueFinding,
  CritiqueSeverity,
  EngineFinding,
  EngineReviewResult,
  EngineSeverity,
  JudgmentProvenance,
} from "@apature/mcp-types";
import {
  coverageState,
  hasDisplayableEngineConfidence,
  gradeRetraction,
  isUnjudged,
  suppressesGradeForCoverage,
} from "@apature/mcp-types";
import {
  mapCoverage,
  mapHallucinationDrops,
  nothingReviewedDisclosure,
  NOTHING_REVIEWED_DISCLOSURE_PREFIX,
  nothingReviewedOverall,
} from "./coverage.js";
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
 *
 * Two independent questions are answered here, and the second was missing until
 * now. `provenance` says whether anything judged the page. `coverage` says what
 * it judged. Verdict answers both on every result, and this mapper used to carry
 * only the first: `coverage` and `hallucinationDrops` survived
 * `parseEngineReviewResult` as unrecognized extras and were then dropped, field
 * by field, right here. The observable consequence was a real verdict run whose
 * triage named no route to review, `coverage.routesReviewed: []`, arriving at an
 * agent as `grade: "ship"`, `findings: []`, `provenance.model_backed: true`:
 * the exact payload README tells an agent it may trust. Gate, reading the same
 * bytes, published a neutral "Nothing reviewed". Both are now carried, in gate's
 * vocabulary (see `coverage.ts`).
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

/**
 * Add the nothing-reviewed disclosure, AFTER any no-model disclosure.
 *
 * The order matters and is not the same as gate's. Gate leads its Check Run
 * summary with the coverage reason because that is the more actionable headline.
 * Here, `not_reviewed[0]` beginning `[bastion] no model judged this page` is a
 * documented invariant an agent is told to check (README §Provenance), so the
 * no-model line keeps index 0 whenever it is present and the coverage line
 * follows it. When there is no no-model line the coverage line is first. Both
 * are always present when they apply, so nothing is hidden by the ordering; only
 * the grade follows gate's "coverage wins" rule, where a single value has to
 * choose.
 */
function withNothingReviewedDisclosure(
  notReviewed: string[],
  coverage: CritiqueCoverage,
): string[] {
  if (notReviewed.some((entry) => entry.startsWith(NOTHING_REVIEWED_DISCLOSURE_PREFIX))) {
    return notReviewed;
  }
  const line = nothingReviewedDisclosure(coverage);
  const leadingNoModel = notReviewed.findIndex((entry) =>
    entry.startsWith(NO_MODEL_DISCLOSURE_PREFIX),
  );
  if (leadingNoModel === -1) return [line, ...notReviewed];
  return [
    ...notReviewed.slice(0, leadingNoModel + 1),
    line,
    ...notReviewed.slice(leadingNoModel + 1),
  ];
}

export function mapEngineResultToCritique(reviewId: string, result: EngineReviewResult): Critique {
  // An unstamped result is `unknown`, never assumed judged: `model_backed` is
  // null, so a consumer that requires a real judgment still refuses it.
  const provenance = result.provenance ?? UNATTESTED_PROVENANCE;
  // Only a provable `false` suppresses the grade. `null` is the remote-engine
  // case, where a real judgment may well have happened and blanking it would
  // destroy a true result; the payload discloses the uncertainty instead.
  const unjudged = isUnjudged(provenance);
  // The second suppression, and it is independent of the first: a live,
  // model-backed run whose triage named no route to review judged nothing, and
  // `provenance` cannot see that. Only `nothing` suppresses; `partial` is a real
  // review of a smaller surface and `unstated` is an engine that does not report
  // coverage, which is disclosed rather than refused.
  const coverage = mapCoverage(result);
  const nothingReviewed = suppressesGradeForCoverage(coverageState(result));
  // An engine can retract its grade for a cause coverage cannot express: every
  // model finding deleted before it could be reported, on a route that WAS
  // reviewed. Coverage reads full and truthful, and the grade means nothing.
  const retraction = gradeRetraction(result);
  // Either suppression means no item in `findings[]` is an observation of the
  // target, so both raise the same per-item marker. An agent holding one array
  // element cannot see the envelope, and at that scope the two causes are the
  // same instruction: do not act on this.
  const ungrounded = unjudged || nothingReviewed || retraction !== null;
  const confidenceIsDisplayable = !ungrounded && hasDisplayableEngineConfidence(result);
  // Coverage wins the grade when both apply, matching gate's rule: an operator
  // whose run judged no page is not helped by being told the judgment stamp was
  // missing too, and `provenance` still carries that fact unchanged.
  const grade = nothingReviewed
    ? "nothing_reviewed"
    : unjudged
      ? "unjudged"
      : retraction !== null
        ? "unjudged"
        : result.grade;
  const overall = nothingReviewed
    ? nothingReviewedOverall(coverage)
    : unjudged
      ? unjudgedOverall(provenance)
      : result.overall;
  let notReviewed = result.notReviewed;
  if (unjudged) notReviewed = withDisclosure(notReviewed, provenance);
  if (nothingReviewed) notReviewed = withNothingReviewedDisclosure(notReviewed, coverage);
  return {
    review_id: reviewId,
    grade,
    confidence: confidenceIsDisplayable ? result.confidence : null,
    overall,
    findings: result.findings.map((finding) =>
      mapFinding(finding, confidenceIsDisplayable, ungrounded),
    ),
    not_reviewed: notReviewed,
    coverage,
    // Carried, never suppressed: the routes WERE judged and the grounding gate
    // deleting every finding is that gate working. It is disclosed so an empty
    // `findings` array is not read as a clean page.
    hallucination_drops: mapHallucinationDrops(result),
    provenance,
  };
}
