import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EngineReviewResult } from "@apature/mcp-types";
import { mapEngineResultToCritique } from "../src/index.js";

/**
 * Direct coverage for the engine->Critique severity mapping (issue #14). The
 * shared golden fixture (mcp-types) contains only major/minor/nit findings, so
 * the `blocker -> blocker` branch of `mapSeverity` never executes through the
 * service-level tests. This blocker-bearing fixture variant exercises that
 * branch and pins the full four-level -> three-level collapse. The golden
 * fixture's bytes are deliberately untouched.
 */
function loadBlockerEngineResult(): EngineReviewResult {
  const path = new URL("./fixtures/engine-review-result.blocker.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as EngineReviewResult;
}

describe("mapEngineResultToCritique severity mapping", () => {
  const REVIEW_ID = "review_blocker_0001";
  const engineResult = loadBlockerEngineResult();
  const critique = mapEngineResultToCritique(REVIEW_ID, engineResult);

  it("maps engine blocker severity to the agent-facing blocker (the untested branch)", () => {
    const blocker = critique.findings.find((f) => f.finding_id === "f_b01");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocker");
    // The engine dimension is surfaced verbatim until a dedicated field lands.
    expect(blocker?.dimension).toBe("blocker");
    // Mapping is structure-only: element_ref + suggestion pass through intact.
    expect(blocker?.element_ref).toBe("button[data-testid='place-order']");
    expect(blocker?.suggestion).toContain("footer");
  });

  it("collapses all four engine severities to the three agent levels", () => {
    const byId = new Map(critique.findings.map((f) => [f.finding_id, f.severity]));
    expect(byId.get("f_b01")).toBe("blocker"); // blocker -> blocker
    expect(byId.get("f_b02")).toBe("should_fix"); // major -> should_fix
    expect(byId.get("f_b03")).toBe("should_fix"); // minor -> should_fix
    expect(byId.get("f_b04")).toBe("nit"); // nit -> nit
  });

  it("carries the top-level grade and review id through unchanged", () => {
    expect(critique.review_id).toBe(REVIEW_ID);
    expect(critique.grade).toBe("blocked");
    expect(critique.not_reviewed.length).toBeGreaterThan(0);
  });
});

describe("confidence pass-through (mcp-review#13 / judgment-engine#150)", () => {
  it("passes engine per-finding and result-level confidence through untouched", () => {
    const engineResult = loadBlockerEngineResult();
    const withConfidence: EngineReviewResult = {
      ...engineResult,
      confidence: 0.63,
      findings: engineResult.findings.map((f, i) => ({ ...f, confidence: 0.63 + i * 0.1 })),
    };
    const critique = mapEngineResultToCritique("review_conf_0001", withConfidence);
    expect(critique.confidence).toBe(0.63);
    expect(critique.findings.map((f) => f.confidence)).toEqual(
      withConfidence.findings.map((f) => f.confidence),
    );
  });

  it("falls back to the documented legacy default ONLY when a pre-#150 result omits the field", () => {
    const engineResult = loadBlockerEngineResult();
    const legacy: EngineReviewResult = {
      ...engineResult,
      findings: engineResult.findings.map((f) => {
        const { confidence: _dropped, ...rest } = f;
        return rest;
      }),
    };
    delete legacy.confidence;
    const critique = mapEngineResultToCritique("review_conf_0002", legacy);
    expect(critique.confidence).toBe(0.8);
    for (const f of critique.findings) expect(f.confidence).toBe(0.8);
  });
});
