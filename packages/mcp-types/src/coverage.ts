import type { EngineReviewCoverage, EngineReviewResult, EngineViewport } from "./engine.js";

/**
 * How much of the requested review actually happened.
 *
 * `provenance.ts` answers "did a model judge this page?". This module answers
 * the question next to it: "what did it judge?". Both are needed, and neither
 * substitutes for the other. An engine truthfully stamps
 * `provenance.model_backed: true` for a run whose triage concluded a deep review
 * was needed and then named no route to run it on: a model client really was
 * configured and really was called, and the pages it was called about were never
 * judged. That run still arrives shaped like a clean review, `grade: "ship"`
 * with `findings: []`, and README tells an agent that `model_backed === true` is
 * the one thing it has to check.
 *
 * Three different producers reach that state:
 *   1. every route's critique failing validation (`"<route>: no valid critique"`),
 *   2. an empty capture (zero model calls on zero pixels), and
 *   3. triage answering that a deep review is needed and naming no route.
 *
 * All three mean nothing was reviewed. A FOURTH state looks the same on the wire
 * and is not the same thing: the grounding gate deleting every finding the model
 * emitted. That is the behaviour the grounding gate exists for, the routes WERE
 * judged, and it is reported separately as `hallucinationDrops`. Coverage is
 * built from what the pipeline did, not from what survived the pipeline.
 *
 * WHY NOT INFER THIS FROM `notReviewed`. The obvious rule, "zero findings plus a
 * non-empty `notReviewed` is not a pass", is wrong, and the golden fixture is
 * the counterexample: it skips `/checkout` and the tablet viewport and carries
 * real findings on the routes it did review. Once those findings are fixed that
 * same run legitimately becomes `ship` with zero findings and a non-empty
 * `notReviewed`, and refusing it would punish an honest partial review for
 * saying what it skipped. `notReviewed` is also free prose an engine may leave
 * empty entirely. Coverage is on the contract instead.
 *
 * The vocabulary here is `apatureai/gate`'s, name for name
 * (`packages/delivery/src/coverage.ts`). Gate renders a Check Run and Bastion
 * answers an agent over MCP, but the classification of an engine result is the
 * same question with the same four answers, and a second dialect for it would
 * mean an operator reading both repositories has to hold two.
 */
export type CoverageState =
  /** Every requested route and viewport was reviewed. */
  | "full"
  /** Something was reviewed, but not everything that was asked for. */
  | "partial"
  /** Nothing was reviewed. Whatever grade the result carries describes nothing. */
  | "nothing"
  /** The engine did not report coverage. Not the same as "everything". */
  | "unstated";

/** Classify a result's coverage. Absent coverage is `unstated`, never assumed full. */
export function coverageState(result: EngineReviewResult): CoverageState {
  const coverage = result.coverage;
  if (!coverage) return "unstated";
  if (coverage.routesReviewed.length === 0) return "nothing";
  return coversEverythingRequested(coverage) ? "full" : "partial";
}

/**
 * True when the reviewed sets account for everything requested.
 *
 * Compared as sets, and the reviewed side is allowed to be a superset: an engine
 * that reviewed a route nobody listed has still covered the ask, and calling
 * that "partial" would report a skipped list that is empty.
 */
function coversEverythingRequested(coverage: EngineReviewCoverage): boolean {
  return (
    skipped(coverage.routesRequested, coverage.routesReviewed).length === 0 &&
    skipped(coverage.viewportsRequested, coverage.viewportsReviewed).length === 0
  );
}

/** Requested items with no counterpart in the reviewed set, in requested order. */
export function skipped<T>(requested: readonly T[], reviewed: readonly T[]): T[] {
  const seen = new Set(reviewed);
  return [...new Set(requested)].filter((item) => !seen.has(item));
}

/** Requested routes the run never formed a judgment about, in requested order. */
export function routesSkipped(coverage: EngineReviewCoverage): string[] {
  return skipped(coverage.routesRequested, coverage.routesReviewed);
}

/** Requested viewports the run never judged, in requested order. */
export function viewportsSkipped(coverage: EngineReviewCoverage): EngineViewport[] {
  return skipped(coverage.viewportsRequested, coverage.viewportsReviewed);
}

/**
 * True when the grade must be suppressed because nothing was reviewed.
 *
 * Deliberately narrow, exactly as in gate: `partial` and `unstated` do NOT
 * suppress. A partial review is a real review of a smaller surface, and its
 * grade is a real verdict about what it covered. `unstated` is the older or
 * third-party engine that does not report coverage at all; blanking its grade
 * would destroy every true result those engines produce, so the payload
 * discloses the uncertainty instead of inventing a refusal.
 */
export function suppressesGradeForCoverage(state: CoverageState): boolean {
  return state === "nothing";
}

/**
 * How many findings the grounding gate deleted, or `null` when the engine did
 * not say. `null` and `0` are different answers and are kept apart: `0` is
 * "the gate ran and deleted nothing", `null` is "no gate reported".
 */
export function hallucinationDrops(result: EngineReviewResult): number | null {
  const drops = result.hallucinationDrops;
  if (typeof drops !== "number" || !Number.isFinite(drops) || drops < 0) return null;
  return drops;
}

/**
 * Whether the engine retracted its own grade.
 *
 * Distinct from coverage: a run can review every requested route and still have
 * nothing to say about them, if every finding was deleted before it could be
 * reported. Coverage is full on that run and the grade is not a verdict.
 */
export function gradeRetraction(result: EngineReviewResult): string | null {
  const reason = result.gradeUnavailableReason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}
