import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineReviewResult } from "./engine.js";

/**
 * Path to the golden `EngineReviewResult` fixture. This single fixture is the
 * shared boundary artifact: the mock engine reads it, and the contract test
 * pins its shape, so the mock cannot drift from the live engine contract. It
 * mirrors `apatureai/gate`'s golden review result so both repos stay aligned on
 * one upstream shape. Resolved relative to the compiled file
 * (dist/golden.js -> ../fixtures) so it works from the published package.
 */
export const GOLDEN_ENGINE_RESULT_PATH = fileURLToPath(
  new URL("../fixtures/engine-review-result.golden.json", import.meta.url),
);

/** Load the golden `EngineReviewResult`. Tests and the mock engine share this. */
export function loadGoldenEngineResult(): EngineReviewResult {
  return JSON.parse(readFileSync(GOLDEN_ENGINE_RESULT_PATH, "utf8")) as EngineReviewResult;
}
