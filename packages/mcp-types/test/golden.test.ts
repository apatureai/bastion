import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_ENGINE_RESULT_PATH,
  hasDisplayableEngineConfidence,
  loadGoldenEngineResult,
  loadPreCalibrationEngineResult,
  PRE_CALIBRATION_ENGINE_RESULT_PATH,
} from "../src/index.js";
import type {
  EngineFinding,
  EngineGrade,
  EngineReviewResult,
  EngineSeverity,
} from "../src/index.js";

const GRADES: EngineGrade[] = ["ship", "ship_with_nits", "needs_work", "blocked"];
const SEVERITIES: EngineSeverity[] = ["nit", "minor", "major", "blocker"];
const JUDGMENT_ENGINE_GOLDEN_BLOB = "54a7add15f3431964f092f9795af2a72800d33a0";
const JUDGMENT_ENGINE_PRE_CALIBRATION_BLOB = "7d1c7e4780b5967c1df937f12667875e4d38ffb8";

describe("golden EngineReviewResult fixture", () => {
  // Compile-time guarantee: the loader's return type IS EngineReviewResult.
  const golden: EngineReviewResult = loadGoldenEngineResult();

  it("has a valid grade", () => {
    expect(GRADES).toContain(golden.grade);
  });

  it("has a non-empty overall summary", () => {
    expect(typeof golden.overall).toBe("string");
    expect(golden.overall.length).toBeGreaterThan(0);
  });

  it("is byte-identical to the pinned Judgment Engine fixtures", () => {
    for (const [path, expected] of [
      [GOLDEN_ENGINE_RESULT_PATH, JUDGMENT_ENGINE_GOLDEN_BLOB],
      [PRE_CALIBRATION_ENGINE_RESULT_PATH, JUDGMENT_ENGINE_PRE_CALIBRATION_BLOB],
    ] as const) {
      const bytes = readFileSync(path);
      const oid = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      expect(oid).toBe(expected);
    }
  });

  it("authorizes only complete report-backed confidence", () => {
    expect(golden.calibration?.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(golden.blockingEnabled).toBe(true);
    expect(hasDisplayableEngineConfidence(golden)).toBe(true);

    const historical = loadPreCalibrationEngineResult();
    expect(typeof historical.confidence).toBe("number");
    expect(historical.calibration).toBeUndefined();
    expect(hasDisplayableEngineConfidence(historical)).toBe(false);
  });

  it("has structurally valid findings", () => {
    expect(Array.isArray(golden.findings)).toBe(true);
    for (const f of golden.findings as EngineFinding[]) {
      expect(typeof f.id).toBe("string");
      expect(SEVERITIES).toContain(f.severity);
      expect(typeof f.title).toBe("string");
      expect(typeof f.description).toBe("string");
      expect(typeof f.route).toBe("string");
      expect(["mobile", "tablet", "desktop"]).toContain(f.viewport);
      expect(f.element === null || typeof f.element === "string").toBe(true);
      expect(f.screenshotId === null || typeof f.screenshotId === "string").toBe(true);
      expect(f.suggestion === null || typeof f.suggestion === "string").toBe(true);
    }
  });

  it("exposes notReviewed as an array of strings", () => {
    expect(Array.isArray(golden.notReviewed)).toBe(true);
    for (const n of golden.notReviewed) expect(typeof n).toBe("string");
  });

  it("annotated screenshots reference real findings", () => {
    const findingIds = new Set(golden.findings.map((f) => f.id));
    for (const shot of golden.artifacts.annotatedScreenshots) {
      expect(findingIds.has(shot.findingId)).toBe(true);
      expect(typeof shot.url).toBe("string");
    }
  });

  it("metadata is engine-neutral and traceable (no model hard-coding)", () => {
    const { metadata } = golden;
    expect(typeof metadata.engineVersion).toBe("string");
    expect(typeof metadata.model).toBe("string");
    expect(typeof metadata.promptVersion).toBe("string");
    expect(typeof metadata.captureVersion).toBe("string");
    expect(metadata.uiDnaVersion === null || typeof metadata.uiDnaVersion === "string").toBe(true);

    // MCP Review must never hard-code Claude as the judge in the boundary.
    const serialized = JSON.stringify(golden).toLowerCase();
    expect(serialized).not.toContain("claude");
    expect(serialized).not.toContain("anthropic");
  });
});
