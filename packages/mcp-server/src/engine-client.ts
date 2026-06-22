import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import type { NormalizedReviewRequest } from "./normalize.js";

/**
 * A normalized recheck request as the engine receives it. The flagged findings
 * carry their prior route/viewport/element so the engine can focus capture
 * (TRD §4.3); `beforeFingerprint`/`afterFingerprint` bracket the change.
 */
export type EngineRecheckRequest = {
  reviewId: string;
  url: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  findings: Array<{ findingId: string; route: string; element: string | null }>;
};

/**
 * The engine boundary as MCP Review sees it. The real implementation lives in
 * `apatureai/judgment-engine`; MCP Review only submits authorized targets and
 * reads results. This interface is the seam that lets tests and local runs use
 * a mock instead of capture + inference.
 */
export interface EngineClient {
  /**
   * Submit a review for an authorized, normalized target and return the engine
   * result. The real engine is asynchronous (capture + multimodal judgment);
   * this seam abstracts that so the tool layer stays transport-agnostic.
   */
  review(request: NormalizedReviewRequest): Promise<EngineReviewResult>;

  /**
   * Re-judge selected prior findings after the target changed, returning a
   * per-finding pass/fail/inconclusive verdict plus the before/after pair.
   */
  recheck(request: EngineRecheckRequest): Promise<EngineRecheckResult>;
}

/**
 * Mock engine backed by the golden fixture. Tests and local development MUST use
 * this — it NEVER performs capture, calls a model, or reaches the network. It is
 * the only engine the test suite is allowed to touch.
 */
export class MockEngineClient implements EngineClient {
  async review(_request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    return loadGoldenEngineResult();
  }

  /**
   * Deterministic stand-in for a real recheck. With no capture or model
   * available, it derives a stable verdict from each finding id so tests are
   * reproducible: a finding "passes" (is resolved) unless its id hashes odd, in
   * which case it still "fails" (persists). Localizable findings (with an
   * element) are focused; otherwise the scope falls back to broad. This is a
   * fixture-grounded stand-in, NOT a judgment of any real UI.
   */
  async recheck(request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    const anyBroad = request.findings.some((f) => f.element === null);
    return {
      beforeFingerprint: request.beforeFingerprint,
      afterFingerprint: request.afterFingerprint,
      captureScope: anyBroad ? "broad_fallback" : "focused",
      outcomes: request.findings.map((f) => {
        const persists = stableParity(f.findingId) === 1;
        return persists
          ? {
              findingId: f.findingId,
              outcome: "failed" as const,
              confidence: 0.82,
              reason: "The flagged issue is still present after the change.",
            }
          : {
              findingId: f.findingId,
              outcome: "passed" as const,
              confidence: 0.86,
              reason: "The flagged issue is no longer observed at the target.",
            };
      }),
    };
  }
}

/** Stable 0/1 parity of a string, used only by the deterministic mock. */
function stableParity(s: string): 0 | 1 {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum = (sum + s.charCodeAt(i)) % 2;
  return (sum % 2) as 0 | 1;
}
