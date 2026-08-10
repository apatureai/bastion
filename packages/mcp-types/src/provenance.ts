/**
 * Judgment provenance: the in-band answer to "did anything actually look at
 * this page?"
 *
 * The consumer of a Bastion result is usually a coding agent, not a person. It
 * never sees the startup banner, the terminal report or the README; it sees one
 * JSON payload and acts on it. So the fact that a run was served by a fixture,
 * or by a capture pipeline with no model behind it, has to live IN that payload
 * or it does not exist. This type is that fact.
 *
 * It is BASTION'S attestation, not the engine's claim. Every adapter stamps it
 * from what it knows about its own configuration, and anything arriving under
 * this name from a remote engine is discarded before the stamp is applied, so a
 * compromised or merely buggy backend cannot assert `model_backed: true` about
 * itself.
 *
 * The field names are snake_case because this object is agent-facing and rides
 * out to MCP clients verbatim, unchanged, on both the engine boundary and the
 * Critique.
 */

/**
 * What produced the judgment:
 *  - `model`:   a vision model was called on a capture of the target.
 *  - `canned`:  a real pipeline ran (capture, measurement) but the critique
 *               came from a deterministic stand-in, not a model.
 *  - `fixture`: nothing ran; a stored result was replayed.
 *  - `unknown`: the adapter that produced this result did not attest, or
 *               attested that it cannot see how its backend is configured.
 */
export type JudgmentSource = "model" | "canned" | "fixture" | "unknown";

/** Bastion's in-band statement about where a judgment came from. */
export type JudgmentProvenance = {
  /**
   * `true` only when a model was called on a capture of the target that was
   * asked for. `false` when this process knows nothing judged the page.
   * `null` when this process genuinely cannot tell, which is the honest answer
   * for a remote engine deployment whose model configuration is not visible
   * from here. A consumer that requires a real judgment must treat anything
   * other than `true` as "not judged".
   */
  model_backed: boolean | null;
  source: JudgmentSource;
  /** Which adapter produced the result, e.g. `bastion-fixture`, `verdict-cli`. */
  engine: string;
  /** The judge model, when one was called. `null` on every other path. */
  model: string | null;
  /** One sentence a human can read in a log without any other context. */
  detail: string;
};

/**
 * True only when a model demonstrably judged the target. Anything else,
 * including the unknown remote case, is not a judgment a consumer may rely on.
 */
export function isModelBacked(provenance: JudgmentProvenance): boolean {
  return provenance.model_backed === true;
}

/**
 * True when this process KNOWS nothing judged the page. Distinct from
 * `!isModelBacked`, which is also true for the unknown case: this is the
 * condition under which Bastion must suppress a grade and a narrative, because
 * it can prove they describe nothing.
 */
export function isUnjudged(provenance: JudgmentProvenance): boolean {
  return provenance.model_backed === false;
}
