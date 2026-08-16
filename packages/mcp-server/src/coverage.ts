import type { Critique, CritiqueCoverage, EngineReviewResult } from "@apature/mcp-types";
import {
  coverageState,
  hallucinationDrops,
  routesSkipped,
  viewportsSkipped,
} from "@apature/mcp-types";

/**
 * Everything Bastion SAYS about coverage, in one module.
 *
 * The classification itself lives in `@apature/mcp-types`
 * (`coverage.ts`: `CoverageState`, `coverageState`,
 * `suppressesGradeForCoverage`), next to `isUnjudged`, because it is a pure
 * reading of the engine contract. The sentences live here, next to
 * `provenance.ts`'s `noModelDisclosure`, because they are this server's own
 * words. That split is Bastion's existing one for the judgment question; the
 * coverage question follows it rather than inventing a second layout.
 *
 * The words themselves are `apatureai/gate`'s
 * (`packages/delivery/src/coverage.ts` and `check-run.ts`), deliberately. Gate
 * publishes a Check Run and Bastion answers an agent over MCP, but both are
 * reporting the same fact about the same run, and an operator who reads a green
 * tick in one and a JSON payload in the other must not have to reconcile two
 * vocabularies. "Nothing reviewed", "0 of N route(s) reviewed", and "deleted for
 * citing a route or element the capture never produced" are gate's phrasings and
 * are reused verbatim where the surface allows.
 */

/**
 * The prefix every "nothing was reviewed" disclosure starts with. Stable and
 * greppable for the same reason `NO_MODEL_DISCLOSURE_PREFIX` is: it is what a
 * consumer greps for, what the mapper deduplicates on, and what the README
 * points a reader at.
 */
export const NOTHING_REVIEWED_DISCLOSURE_PREFIX = "[bastion] nothing was reviewed";

/** The prefix on the grounding disclosure, in the same greppable family. */
export const GROUNDING_DISCLOSURE_PREFIX = "[bastion] grounding";

/** "no routes" or "N requested route(s)", as gate phrases the denominator. */
function requestedRoutesPhrase(coverage: CritiqueCoverage): string {
  const requested = coverage.routes_requested.length;
  if (requested === 0) return "no routes";
  return `${requested} requested route${requested === 1 ? "" : "s"}`;
}

/**
 * The narrative for a result that judged no route.
 *
 * Gate's `nothingReviewedReason` and `NOTHING_REVIEWED_REMEDY`, joined into one
 * paragraph because this surface has no Markdown sections to separate them, and
 * with gate's `**No grade.**` written out as plain text because an agent reads
 * this as a string, not as rendered Markdown.
 *
 * It REPLACES the engine's `overall` rather than annotating it, for the same
 * reason `unjudgedOverall` does: the engine's narrative on this path describes a
 * page that was never judged, and presenting it as a description of the target
 * is the same false claim as the grade, just in prose. A caller that
 * concatenates or truncates the field must not be able to end up quoting it.
 */
export function nothingReviewedOverall(coverage: CritiqueCoverage): string {
  return (
    `No grade. The engine reviewed nothing: 0 of ${requestedRoutesPhrase(coverage)} were judged ` +
    "on this run, so nothing below is an assessment of the target. This run is not a pass and " +
    "not a failure. A result with no findings grades ship by construction, which is why the " +
    "grade is nothing_reviewed rather than ship: there was nothing to find because nothing was " +
    "looked at. The routes and the reason each was skipped are in not_reviewed."
  );
}

/** Render a bounded, comma-joined list so a long route set cannot flood a line. */
function renderItems(items: readonly string[], max = 12): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * One line stating what the run covered, for every state including `unstated`.
 *
 * Gate's `coverageCaveat`, minus the Markdown. Always renderable, so a reader
 * never has to infer coverage from the absence of a caveat, and so the payload
 * and the content blocks beside it cannot tell different stories about one run.
 */
export function coverageSummaryLine(coverage: CritiqueCoverage): string {
  if (coverage.state === "unstated") {
    // ABSENT COVERAGE, THE DELIBERATE CHOICE. An older or third-party engine
    // will not send this field, and Bastion does NOT flip such a run on the
    // heuristic "zero findings plus a non-empty not_reviewed". That heuristic
    // fails the golden fixture's honest partial, and not_reviewed is prose an
    // engine may never populate. Bastion says what it cannot confirm instead of
    // implying a completeness it cannot verify.
    return (
      "Coverage: the engine did not report which routes and viewports it reviewed, so this " +
      "result cannot be confirmed to cover the whole target. An engine that reports coverage " +
      "states it on the result as coverage.routesReviewed."
    );
  }
  const parts = [
    `${coverage.routes_reviewed.length} of ${new Set(coverage.routes_requested).size} route(s) reviewed`,
  ];
  if (coverage.routes_reviewed.length > 0) {
    parts.push(`reviewed ${renderItems(coverage.routes_reviewed)}`);
  }
  if (coverage.routes_skipped.length > 0) parts.push(`skipped ${renderItems(coverage.routes_skipped)}`);
  if (coverage.viewports_skipped.length > 0) {
    parts.push(`viewports skipped: ${renderItems(coverage.viewports_skipped)}`);
  }
  return `Coverage: ${parts.join("; ")}.`;
}

/**
 * The `not_reviewed` line added whenever nothing was reviewed, so the structural
 * disclosure and the prose disclosure say the same thing. Twin of
 * `noModelDisclosure` in `provenance.ts`, down to the closing pointer.
 */
export function nothingReviewedDisclosure(coverage: CritiqueCoverage): string {
  return (
    `${NOTHING_REVIEWED_DISCLOSURE_PREFIX}: 0 of ${requestedRoutesPhrase(coverage)} were judged ` +
    'on this run. The grade is reported as "nothing_reviewed" and nothing in this result is an ' +
    "assessment of the target. Re-run the review; if it keeps returning nothing, the routes " +
    "below say why each was skipped."
  );
}

/**
 * Gate's grounding line, verbatim apart from the prefix that makes it greppable
 * alongside Bastion's other disclosures.
 *
 * "Zero findings" and "four findings, none of which could be grounded" both
 * arrive as an empty array under a `ship` grade. Only the engine knows which
 * happened, so say it rather than letting the reader assume the first. It never
 * changes the grade: the routes were judged, and deleting ungroundable findings
 * is the grounding gate working, not a failure to review.
 */
export function groundingDisclosure(drops: number): string {
  return (
    `${GROUNDING_DISCLOSURE_PREFIX}: ${drops} model finding(s) were deleted for citing a route ` +
    "or element the capture never produced, so they are not shown above."
  );
}

/**
 * Project the engine's coverage onto the agent surface. Absent coverage becomes
 * an explicit `unstated` with empty lists rather than a missing key: a consumer
 * that has to branch on `coverage === undefined` will eventually forget to, and
 * the forgetting defaults to "everything was reviewed".
 */
export function mapCoverage(result: EngineReviewResult): CritiqueCoverage {
  const state = coverageState(result);
  const coverage = result.coverage;
  if (!coverage) {
    return {
      state,
      routes_requested: [],
      routes_reviewed: [],
      routes_skipped: [],
      viewports_requested: [],
      viewports_reviewed: [],
      viewports_skipped: [],
    };
  }
  return {
    state,
    routes_requested: [...new Set(coverage.routesRequested)],
    routes_reviewed: [...new Set(coverage.routesReviewed)],
    routes_skipped: routesSkipped(coverage),
    viewports_requested: [...new Set(coverage.viewportsRequested)],
    viewports_reviewed: [...new Set(coverage.viewportsReviewed)],
    viewports_skipped: viewportsSkipped(coverage),
  };
}

/** The engine's grounding-gate count as the agent surface reports it. */
export function mapHallucinationDrops(result: EngineReviewResult): number | null {
  return hallucinationDrops(result);
}

/**
 * Just the two fields a prose surface needs. Narrower than `Critique` so the
 * terminal reporters, which read the tool result as a locally-declared shape
 * rather than importing the full type, can call `coverageLines` without a cast.
 */
export type CoverageReportable = Pick<Critique, "coverage" | "hallucination_drops">;

/**
 * The coverage and grounding lines a prose surface should print for a critique,
 * in that order, omitting the grounding line when the engine reported no drops.
 *
 * One function so the MCP content blocks, the HTML panel and the CLI report
 * cannot drift into three different accounts of the same run: gate's lesson from
 * `notReviewedSection` was that the surface which gates the decision must never
 * be the quieter of the two.
 */
export function coverageLines(critique: CoverageReportable): string[] {
  const lines = [coverageSummaryLine(critique.coverage)];
  const drops = critique.hallucination_drops;
  if (drops !== null && drops > 0) lines.push(groundingDisclosure(drops));
  return lines;
}
