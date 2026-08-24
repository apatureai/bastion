import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EngineReviewResult } from "@apatureai/bastion-types";
import { mapEngineResultToCritique } from "../src/index.js";
import {
  FIXTURE_PROVENANCE,
  NO_MODEL_DISCLOSURE_PREFIX,
  noModelDisclosure,
  stampProvenance,
  verdictCliProvenance,
} from "../src/provenance.js";

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
    // #159 counterexample: the real rubric dimension crosses to MCP verbatim,
    // independent of severity (a blocker whose dimension is `accessibility`).
    expect(blocker?.dimension).toBe("accessibility");
    // Mapping is structure-only: element_ref + suggestion pass through intact.
    expect(blocker?.element_ref).toBe("button[data-testid='place-order']");
    expect(blocker?.suggestion).toContain("footer");
  });

  it("passes each engine dimension through verbatim, never derived from severity (#159)", () => {
    const byId = new Map(critique.findings.map((f) => [f.finding_id, f.dimension]));
    expect(byId.get("f_b01")).toBe("accessibility"); // blocker, but dimension is accessibility
    expect(byId.get("f_b02")).toBe("spacing");
    expect(byId.get("f_b03")).toBe("typography");
  });

  it("surfaces a legacy finding without a dimension as an explicit null, never a fake one (#159)", () => {
    const legacy = critique.findings.find((f) => f.finding_id === "f_b04");
    expect(legacy?.dimension).toBeNull(); // absent upstream -> unavailable, not "nit"
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

/**
 * The three provenance states, at the layer that enforces them. The mapper is
 * the single place the "nothing judged this page" rule is applied, so every
 * path into a Critique inherits it; these pin what each state does to the
 * grade, the narrative and the disclosure list.
 */
describe("mapEngineResultToCritique judgment provenance", () => {
  const engineResult = loadBlockerEngineResult();

  it("suppresses the grade and the narrative when nothing judged the page", () => {
    const critique = mapEngineResultToCritique(
      "review_prov_0001",
      stampProvenance(engineResult, FIXTURE_PROVENANCE),
    );
    expect(critique.grade).toBe("unjudged");
    expect(critique.confidence).toBeNull();
    expect(critique.overall).not.toBe(engineResult.overall);
    expect(critique.overall).toContain("No model judged this page");
    expect(critique.not_reviewed[0]).toContain(NO_MODEL_DISCLOSURE_PREFIX);
    expect(critique.provenance).toEqual(FIXTURE_PROVENANCE);
  });

  it("adds the disclosure once, even when the backend already added it", () => {
    const provenance = verdictCliProvenance("canned");
    // The verdict CLI backend prepends the disclosure at the engine boundary so
    // it survives for a caller reading the raw EngineReviewResult; the mapper
    // must not then repeat it.
    const alreadyDisclosed = stampProvenance(
      {
        ...engineResult,
        notReviewed: [noModelDisclosure(provenance), ...engineResult.notReviewed],
      },
      provenance,
    );
    const critique = mapEngineResultToCritique("review_prov_0002", alreadyDisclosed);
    const disclosures = critique.not_reviewed.filter((entry) =>
      entry.startsWith(NO_MODEL_DISCLOSURE_PREFIX),
    );
    expect(disclosures).toHaveLength(1);
  });

  it("keeps a real judgment intact rather than suppressing it", () => {
    const provenance = verdictCliProvenance("live", engineResult);
    const critique = mapEngineResultToCritique(
      "review_prov_0003",
      stampProvenance(engineResult, provenance),
    );
    expect(critique.grade).toBe(engineResult.grade);
    expect(critique.overall).toBe(engineResult.overall);
    expect(critique.not_reviewed).toEqual(engineResult.notReviewed);
    expect(critique.provenance.model_backed).toBe(true);
  });

  it("treats an unattested result as unknown, never as judged and never as unjudged", () => {
    // A custom EngineClient is free not to stamp. The honest reading is "this
    // process cannot tell": the grade is not destroyed, because a real judgment
    // may well be behind it, but `model_backed` is null, so a consumer that
    // requires a real judgment still refuses it.
    const critique = mapEngineResultToCritique("review_prov_0004", engineResult);
    expect(critique.grade).toBe(engineResult.grade);
    expect(critique.provenance.model_backed).toBeNull();
    expect(critique.provenance.source).toBe("unknown");
    expect(critique.not_reviewed).toEqual(engineResult.notReviewed);
  });
});

describe("confidence pass-through (bastion#13 / verdict#150)", () => {
  it("passes calibrated boundary values 0 and 1 through untouched", () => {
    const engineResult = loadBlockerEngineResult();
    const withConfidence: EngineReviewResult = {
      ...engineResult,
      confidence: 0,
      calibration: {
        reportId: "calibration_test_1",
        reportHash: "sha256:675dcd6a31db1157aa84fce80a00d1dd2a591e15877226697134b79269a9ac08",
        calibrationVersion: "isotonic@1",
        confidenceSource: "post_hoc_isotonic",
      },
      findings: engineResult.findings.map((f, i, all) => ({
        ...f,
        confidence: i / (all.length - 1),
      })),
    };
    const critique = mapEngineResultToCritique("review_conf_0001", withConfidence);
    expect(critique.confidence).toBe(0);
    expect(critique.findings.map((f) => f.confidence)).toEqual(
      withConfidence.findings.map((f) => f.confidence),
    );
  });

  it("represents omitted legacy confidence as unavailable without synthesizing a number", () => {
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
    expect(critique.confidence).toBeNull();
    for (const f of critique.findings) expect(f.confidence).toBeNull();
    expect(JSON.stringify(critique)).not.toContain('"confidence":0.8');
  });

  it("withholds supplied numeric fields when report provenance is absent", () => {
    const engineResult = loadBlockerEngineResult();
    const supplied: EngineReviewResult = {
      ...engineResult,
      confidence: 0.8,
      findings: engineResult.findings.map((finding) => ({ ...finding, confidence: 0.8 })),
    };
    const critique = mapEngineResultToCritique("review_conf_0003", supplied);
    expect(critique.confidence).toBeNull();
    expect(critique.findings.every((finding) => finding.confidence === null)).toBe(true);
  });

  it("emits supplied confidence only with complete, valid report provenance", () => {
    const engineResult = loadBlockerEngineResult();
    const supplied: EngineReviewResult = {
      ...engineResult,
      confidence: 0.8,
      calibration: {
        reportId: "calibration_test_2",
        reportHash: "sha256:675dcd6a31db1157aa84fce80a00d1dd2a591e15877226697134b79269a9ac08",
        calibrationVersion: "isotonic@1",
        confidenceSource: "post_hoc_isotonic",
      },
      findings: engineResult.findings.map((finding) => ({ ...finding, confidence: 0.8 })),
    };
    const critique = mapEngineResultToCritique("review_conf_0004", supplied);
    expect(critique.confidence).toBe(0.8);
    expect(critique.findings.every((finding) => finding.confidence === 0.8)).toBe(true);
  });

  it("fails closed for malformed provenance or partial confidence", () => {
    const engineResult = loadBlockerEngineResult();
    const base: EngineReviewResult = {
      ...engineResult,
      confidence: 0.8,
      calibration: {
        reportId: "calibration_test_3",
        reportHash: "sha256:675dcd6a31db1157aa84fce80a00d1dd2a591e15877226697134b79269a9ac08",
        calibrationVersion: "isotonic@1",
        confidenceSource: "post_hoc_isotonic",
      },
      findings: engineResult.findings.map((finding) => ({ ...finding, confidence: 0.8 })),
    };
    const malformed = mapEngineResultToCritique("review_conf_0005", {
      ...base,
      calibration: { ...base.calibration!, reportHash: "sha256:not-a-digest" },
    });
    expect(malformed.confidence).toBeNull();
    expect(malformed.findings.every((finding) => finding.confidence === null)).toBe(true);

    const missingFields = mapEngineResultToCritique("review_conf_0005b", {
      ...base,
      calibration: {} as NonNullable<EngineReviewResult["calibration"]>,
    });
    expect(missingFields.confidence).toBeNull();
    expect(missingFields.findings.every((finding) => finding.confidence === null)).toBe(true);

    const partial = mapEngineResultToCritique("review_conf_0006", {
      ...base,
      findings: base.findings.map((finding, index) =>
        index === 0 ? { ...finding, confidence: undefined } : finding),
    });
    expect(partial.confidence).toBeNull();
    expect(partial.findings.every((finding) => finding.confidence === null)).toBe(true);
  });
});
