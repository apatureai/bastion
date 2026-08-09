import type { AnnotatedImage } from "@apature/mcp-types";

/**
 * The seam that supplies annotated screenshot BYTES for a completed review.
 *
 * `multimedia-content.ts` shapes images into MCP content blocks but deliberately
 * does not produce pixels: the engine/capture plane owns them. An engine result
 * only carries evidence *references* (`CritiqueFinding.evidence_id` and the
 * engine's artifact URLs) — never bytes — so something has to turn a reference
 * into an image an agent can look at. This interface is that something, and it is
 * injected rather than implemented here for the same reason the engine client is:
 * fetching artifacts is I/O against a service this repo does not contain.
 *
 * No provider is configured by default. A server with no provider returns the
 * text/structured evidence view with no image blocks — the honest degradation,
 * identical to the one `buildMultimediaCritiqueContent` applies for a host that
 * cannot render images.
 */
export interface EvidenceProvider {
  /**
   * Annotated crops for a completed review. `evidenceIds` are the non-null
   * `evidence_id`s of that review's findings, in finding order. Returning fewer
   * images than ids is normal and safe: a finding with no matching image is
   * rendered text-only, never with a fabricated block.
   */
  forReview(reviewId: string, evidenceIds: readonly string[]): Promise<readonly AnnotatedImage[]>;
}
