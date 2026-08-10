import { loadGoldenEngineResult, loadPreCalibrationEngineResult } from "@apature/mcp-types";
import { describe, expect, it } from "vitest";
import { EngineResultError, parseEngineReviewResult } from "../src/engine-result.js";

/**
 * The boundary check on a result that arrived from another program.
 *
 * The golden fixture is the contract both repositories agree on, so it must
 * pass unchanged: a validator that rejects the contract would make every real
 * backend unusable, and one that accepts anything would let `undefined` reach an
 * agent-facing finding. Both directions are pinned here.
 */

const golden = loadGoldenEngineResult();

/** The fixture with one field replaced, as an unknown payload. */
function withField(key: string, value: unknown): unknown {
  return { ...(golden as unknown as Record<string, unknown>), [key]: value };
}

describe("parseEngineReviewResult", () => {
  it("accepts the golden engine contract unchanged", () => {
    expect(parseEngineReviewResult(golden, "golden")).toEqual(golden);
  });

  it("accepts the pre-calibration counterexample, which omits every optional field", () => {
    const legacy = loadPreCalibrationEngineResult();
    expect(parseEngineReviewResult(legacy, "legacy")).toEqual(legacy);
  });

  it("preserves fields it does not know about, so a newer engine is not downgraded", () => {
    const parsed = parseEngineReviewResult(withField("futureField", { a: 1 }), "future");
    expect((parsed as unknown as Record<string, unknown>).futureField).toEqual({ a: 1 });
  });

  it("preserves unknown fields on a finding too", () => {
    const findings = golden.findings.map((finding, index) =>
      index === 0 ? { ...finding, futureFindingField: "kept" } : finding,
    );
    const parsed = parseEngineReviewResult(withField("findings", findings), "future");
    expect((parsed.findings[0] as unknown as Record<string, unknown>).futureFindingField).toBe(
      "kept",
    );
  });

  it("names the field that failed, and the source it came from", () => {
    expect(() => parseEngineReviewResult(withField("grade", "great"), "review.json")).toThrow(
      EngineResultError,
    );
    expect(() => parseEngineReviewResult(withField("grade", "great"), "review.json")).toThrow(
      /grade must be one of ship, ship_with_nits, needs_work, blocked \(from review\.json\)/,
    );
  });

  it.each([
    ["a non-object payload", "not json"],
    ["a missing findings array", withField("findings", undefined)],
    ["a missing metadata block", withField("metadata", undefined)],
    ["a non-string notReviewed entry", withField("notReviewed", [7])],
    ["a negative retention", withField("screenshotRetentionSeconds", -1)],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseEngineReviewResult(payload, "source")).toThrow(EngineResultError);
  });

  it("rejects a finding that is missing a required field", () => {
    const findings = golden.findings.map((finding, index) =>
      index === 0 ? { ...finding, element: 7 } : finding,
    );
    expect(() => parseEngineReviewResult(withField("findings", findings), "source")).toThrow(
      /findings\[0\]\.element must be a string/,
    );
  });

  it("rejects a confidence outside [0, 1] instead of passing it to the mapper", () => {
    const findings = golden.findings.map((finding, index) =>
      index === 0 ? { ...finding, confidence: 1.4 } : finding,
    );
    expect(() => parseEngineReviewResult(withField("findings", findings), "source")).toThrow(
      /findings\[0\]\.confidence must be a number in \[0, 1\]/,
    );
  });
});
