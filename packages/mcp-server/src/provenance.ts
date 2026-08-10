import type { EngineReviewResult, JudgmentProvenance } from "@apature/mcp-types";

/**
 * Where every judgment-provenance stamp in this server is minted.
 *
 * One module, so the fixture path, the CLI backend and the job-API backend
 * cannot disagree about what an honest payload looks like. The rule each
 * factory below encodes is the same one: say what this process actually knows,
 * and never more. A stamp claims `model_backed: true` only when a model was
 * called on a capture of the requested target; it claims `false` only when this
 * process can prove nothing judged the page; otherwise it says `null` and lets
 * the consumer decide.
 */

/**
 * The prefix every "nothing judged this page" disclosure starts with, on every
 * backend. It is a stable string on purpose: it is what a consumer greps for,
 * what `critique-map.ts` deduplicates on so one disclosure is not added twice,
 * and what the README points a reader at.
 */
export const NO_MODEL_DISCLOSURE_PREFIX = "[bastion] no model judged this page";

/** Provenance for the offline fixture engine: a replayed golden result. */
export const FIXTURE_PROVENANCE: JudgmentProvenance = {
  model_backed: false,
  source: "fixture",
  engine: "bastion-fixture",
  model: null,
  detail:
    "the offline fixture engine replayed the golden result in @apature/mcp-types; " +
    "it describes a fictional pricing page and not the target that was requested",
};

/**
 * Provenance for a result whose adapter did not attest. A custom `EngineClient`
 * is free not to stamp, and the honest reading of an unstamped result is "this
 * process does not know", not "a model judged it": `model_backed` is `null`, so
 * a consumer that requires a real judgment still refuses it.
 */
export const UNATTESTED_PROVENANCE: JudgmentProvenance = {
  model_backed: null,
  source: "unknown",
  engine: "unattested",
  model: null,
  detail:
    "the engine adapter that produced this result did not attest to how it was produced, " +
    "so whether a model judged the page cannot be established from this process",
};

/**
 * Provenance for the verdict CLI backend. Only `--model live` means a model saw
 * the page; `mock` and `canned` run the real capture and measurement pipeline
 * and then fill the critique from a deterministic stand-in, which is a `false`,
 * not a `null`, because this process chose that mode itself.
 */
export function verdictCliProvenance(
  model: "mock" | "canned" | "live",
  result?: EngineReviewResult,
): JudgmentProvenance {
  if (model === "live") {
    return {
      model_backed: true,
      source: "model",
      engine: "verdict-cli",
      model: result?.metadata.model ?? null,
      detail:
        "verdict ran with --model live: Chromium captured the target and a vision model judged the capture",
    };
  }
  return {
    model_backed: false,
    source: "canned",
    engine: "verdict-cli",
    model: null,
    detail:
      `verdict ran with --model ${model}: capture and measurement were real, but the grade, the ` +
      "narrative and any findings came from verdict's stand-in client rather than from a model",
  };
}

/**
 * Provenance for a remote verdict deployment reached over its job API. Whether
 * that deployment has a model configured is not visible from this process, and
 * guessing would be exactly the invention this module exists to prevent, so
 * `model_backed` is `null`.
 */
export function verdictHttpProvenance(baseUrl: string): JudgmentProvenance {
  return {
    model_backed: null,
    source: "unknown",
    engine: "verdict-http",
    model: null,
    detail:
      `the judgment came from the verdict deployment at ${baseUrl}; this process cannot see how ` +
      "that deployment's model is configured and does not claim to",
  };
}

/**
 * The `not_reviewed` line added whenever `model_backed` is `false`, so the
 * structural disclosure and the prose disclosure say the same thing.
 */
export function noModelDisclosure(provenance: JudgmentProvenance): string {
  return (
    `${NO_MODEL_DISCLOSURE_PREFIX}: ${provenance.detail}. ` +
    `The grade is reported as "unjudged" and nothing in this result is a judgment of the target. ` +
    "See the README section \"Getting real judgments\" to configure a critique backend."
  );
}

/**
 * Attach Bastion's attestation to an engine result, replacing anything that
 * arrived under that name. Overwriting rather than merging is the point: the
 * stamp must be this process's statement, never a backend's claim about itself.
 */
export function stampProvenance(
  result: EngineReviewResult,
  provenance: JudgmentProvenance,
): EngineReviewResult {
  return { ...result, provenance };
}
