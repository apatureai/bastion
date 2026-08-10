import type { EngineRecheckResult, JudgmentProvenance, Recheck } from "@apature/mcp-types";
import { isUnjudged } from "@apature/mcp-types";
import { UNATTESTED_PROVENANCE, unjudgedRecheckReason } from "./provenance.js";

/**
 * Map an engine `EngineRecheckResult` into the agent-facing `Recheck`, and
 * apply the "nothing judged this target" rule to it exactly once.
 *
 * This is the recheck twin of `critique-map.ts`, and it exists for a sharper
 * reason than symmetry. A review is something an agent reads before it acts; a
 * RECHECK is what it reads to decide the fix landed and it can stop. A recheck
 * outcome of `passed` with a confidence of 0.86 and the sentence "the flagged
 * issue is no longer observed at the target" is a specific claim about a
 * specific place at a specific time, and on the fixture path nothing observed
 * anything: the outcome came from a hash of the finding id.
 *
 * So on an unjudged path the outcome, the confidence and the reason are all
 * replaced, not annotated, on the same principle the review narrative is: a
 * consumer that truncates or concatenates the field must not be able to end up
 * quoting the fiction. `inconclusive` is deliberately NOT the substitute, since
 * it means "something looked and could not tell", which is a real observation
 * and a far stronger claim than the truth here.
 *
 * Every path into a `Recheck` runs through this function, so a backend cannot
 * skip what the fixture engine does, and vice versa.
 */
export function mapEngineRecheckToRecheck(
  recheckId: string,
  reviewId: string,
  result: EngineRecheckResult,
): Recheck {
  // An unstamped result is `unknown`, never assumed judged: `model_backed` is
  // null, so a consumer that requires a real judgment still refuses it, while a
  // remote backend that may genuinely have looked keeps its outcomes.
  const provenance: JudgmentProvenance = result.provenance ?? UNATTESTED_PROVENANCE;
  const unjudged = isUnjudged(provenance);
  const reason = unjudged ? unjudgedRecheckReason(provenance) : "";
  return {
    recheck_id: recheckId,
    review_id: reviewId,
    before_fingerprint: result.beforeFingerprint,
    after_fingerprint: result.afterFingerprint,
    capture_scope: result.captureScope,
    outcomes: result.outcomes.map((outcome) =>
      unjudged
        ? { finding_id: outcome.findingId, outcome: "unjudged" as const, confidence: null, reason }
        : {
            finding_id: outcome.findingId,
            outcome: outcome.outcome,
            confidence: outcome.confidence,
            reason: outcome.reason,
          },
    ),
    provenance,
  };
}
