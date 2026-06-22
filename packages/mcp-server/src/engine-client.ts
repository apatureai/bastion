import type { EngineReviewResult } from "@apature/mcp-types";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import type { NormalizedReviewRequest } from "./normalize.js";

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
}
