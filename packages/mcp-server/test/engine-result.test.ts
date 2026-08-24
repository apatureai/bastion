import { loadGoldenEngineResult, loadPreCalibrationEngineResult } from "@apatureai/bastion-types";
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

/**
 * The golden fixture minus the one field the parser is required to strip.
 *
 * The shared upstream fixture carries a `provenance` block, because verdict
 * stamps one on every result it writes. Bastion's parser drops it: provenance is
 * Bastion's statement about whether anything judged the page, and honouring one
 * that arrived over the wire would let a backend certify itself. So "unchanged"
 * means "unchanged except that", stated here rather than left implicit.
 */
const { provenance: goldenWireProvenance, ...goldenEngineFields } = golden;

/** The fixture with one field replaced, as an unknown payload. */
function withField(key: string, value: unknown): unknown {
  return { ...(golden as unknown as Record<string, unknown>), [key]: value };
}

describe("parseEngineReviewResult", () => {
  it("accepts the golden engine contract unchanged, apart from stripping provenance", () => {
    expect(goldenWireProvenance, "the shared fixture carries an engine provenance").toBeDefined();
    expect(parseEngineReviewResult(golden, "golden")).toEqual(goldenEngineFields);
  });

  it("preserves the engine's coverage and grounding count, which the mapper needs", () => {
    // These two survived this validator as unrecognized extras and were then
    // dropped by `mapEngineResultToCritique`. The mapper carries them now, so
    // the boundary has to be pinned on keeping them: a future rewrite of this
    // function that enumerates fields instead of spreading would silently
    // reintroduce the defect.
    const parsed = parseEngineReviewResult(golden, "golden");
    expect(parsed.coverage).toEqual(golden.coverage);
    expect(parsed.coverage?.routesReviewed).toEqual(["/pricing"]);
    const withDrops = parseEngineReviewResult(withField("hallucinationDrops", 4), "golden");
    expect(withDrops.hallucinationDrops).toBe(4);
  });

  it("accepts the pre-calibration counterexample, which omits every optional field", () => {
    const legacy = loadPreCalibrationEngineResult();
    expect(parseEngineReviewResult(legacy, "legacy")).toEqual(legacy);
  });

  it("preserves fields it does not know about, so a newer engine is not downgraded", () => {
    const parsed = parseEngineReviewResult(withField("futureField", { a: 1 }), "future");
    expect((parsed as unknown as Record<string, unknown>).futureField).toEqual({ a: 1 });
  });

  it("drops a provenance that arrived on the wire, the one field an engine may not set", () => {
    // Unknown fields are preserved because the engine owns the contract, but
    // `provenance` is Bastion's statement about whether anything judged the
    // page. Honouring one from the wire would let a backend certify itself.
    const parsed = parseEngineReviewResult(
      withField("provenance", {
        model_backed: true,
        source: "model",
        engine: "totally-legit",
        model: "gpt-imaginary",
        detail: "trust me",
      }),
      "review.json",
    );
    expect(parsed.provenance).toBeUndefined();
    expect(parsed).toEqual(goldenEngineFields);
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
