import { describe, expect, it } from "vitest";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import type { EngineMeasurementReport, EngineReviewResult } from "@apature/mcp-types";
import { mapEngineResultToCritique } from "../src/index.js";
import { stampProvenance, verdictCliProvenance } from "../src/provenance.js";

/**
 * The measured half, on the agent surface.
 *
 * Everything else Bastion returns is downstream of a model having run, which is
 * why the README tells an agent to check `provenance.model_backed` before
 * believing any of it. These are downstream of a `getComputedStyle` call, so
 * that instruction is wrong for them: gating a measurement behind a model stamp
 * discards the only trustworthy thing in an unjudged payload.
 *
 * The rules pinned here are the two halves of that. Measurements are carried on
 * EVERY path, including the ones that suppress the grade and replace the
 * narrative. And a measurement is never dressed as a finding: no severity, no
 * confidence, no dimension, never in `findings[]`, and never stamped with the
 * per-item `unjudged` marker.
 */

const REPORT: EngineMeasurementReport = {
  checksRun: ["contrast", "overflow", "touch_target"],
  violations: [
    {
      kind: "contrast",
      route: "/pricing",
      viewports: ["mobile", "desktop"],
      element: "#hero-subtitle",
      detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
      blockEligible: true,
    },
    {
      kind: "touch_target",
      route: "/pricing",
      viewports: ["mobile"],
      element: "#icon-close",
      detail: "touch target 28x28px is below 44x44px",
      blockEligible: false,
    },
  ],
};

const measured = (over: Partial<EngineReviewResult> = {}): EngineReviewResult => ({
  ...loadGoldenEngineResult(),
  measurements: REPORT,
  ...over,
});

const judged = (result: EngineReviewResult): EngineReviewResult =>
  stampProvenance(result, verdictCliProvenance("live", result));

describe("measurements on the Critique", () => {
  it("maps every field verbatim into this surface's casing", () => {
    const critique = mapEngineResultToCritique("review_m1", judged(measured()));

    expect(critique.measurements.state).toBe("reported");
    expect(critique.measurements.checks_run).toEqual(["contrast", "overflow", "touch_target"]);
    expect(critique.measurements.violations).toEqual([
      {
        kind: "contrast",
        route: "/pricing",
        viewports: ["mobile", "desktop"],
        element_ref: "#hero-subtitle",
        detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
        block_eligible: true,
      },
      {
        kind: "touch_target",
        route: "/pricing",
        viewports: ["mobile"],
        element_ref: "#icon-close",
        detail: "touch target 28x28px is below 44x44px",
        block_eligible: false,
      },
    ]);
  });

  it("is present on every critique, `unstated` when the engine sent nothing", () => {
    // Never a missing key. A missing key reads as an older payload and invites a
    // default; `unstated` cannot be mistaken for one.
    const critique = mapEngineResultToCritique("review_m2", judged(loadGoldenEngineResult()));

    expect(critique.measurements).toEqual({ state: "unstated", checks_run: [], violations: [] });
  });

  it("never synthesizes `reported` from silence", () => {
    // `unstated` with empty arrays and `reported` with an empty `violations` are
    // different answers: the second says the checks ran and the page is clean.
    const critique = mapEngineResultToCritique("review_m3", judged(loadGoldenEngineResult()));
    expect(critique.measurements.state).not.toBe("reported");

    const cleanEngine = measured({ measurements: { checksRun: ["contrast"], violations: [] } });
    const clean = mapEngineResultToCritique("review_m4", judged(cleanEngine));
    expect(clean.measurements).toEqual({
      state: "reported",
      checks_run: ["contrast"],
      violations: [],
    });
  });
});

describe("a measurement is never a finding", () => {
  const critique = mapEngineResultToCritique("review_m5", judged(measured()));

  it("does not enter findings[] and carries no judgment fields", () => {
    const elements = critique.findings.map((finding) => finding.element_ref);
    expect(elements).not.toContain("#hero-subtitle");
    expect(critique.findings).toHaveLength(loadGoldenEngineResult().findings.length);

    for (const violation of critique.measurements.violations) {
      expect(violation).not.toHaveProperty("severity");
      expect(violation).not.toHaveProperty("confidence");
      expect(violation).not.toHaveProperty("dimension");
      expect(violation).not.toHaveProperty("finding_id");
    }
  });

  it("does not change the grade", () => {
    expect(critique.grade).toBe(loadGoldenEngineResult().grade);
  });
});

describe("measurements survive every path that suppresses the grade", () => {
  it("an unjudged run keeps them, unmarked", () => {
    // The per-item `unjudged` marker tells an agent not to act on an item. A
    // measurement is true on an unjudged run, and marking it would tell the
    // agent to discard the only trustworthy thing it received.
    const unjudged = stampProvenance(measured(), {
      model_backed: false,
      source: "canned",
      engine: "bastion-fixture",
      model: null,
      detail: "no model was configured, so a stand-in filled the critique",
    });
    const critique = mapEngineResultToCritique("review_m6", unjudged);

    expect(critique.grade).toBe("unjudged");
    expect(critique.measurements.violations).toHaveLength(2);
    for (const violation of critique.measurements.violations) {
      expect(violation).not.toHaveProperty("unjudged");
    }
    // Every FINDING on the same payload is marked, which is the contrast.
    for (const finding of critique.findings) expect(finding.unjudged).toBe(true);
  });

  it("a nothing-reviewed run keeps them", () => {
    const golden = loadGoldenEngineResult();
    const nothing = judged(
      measured({
        coverage: { ...golden.coverage!, routesReviewed: [], viewportsReviewed: [] },
      }),
    );
    const critique = mapEngineResultToCritique("review_m7", nothing);

    expect(critique.grade).toBe("nothing_reviewed");
    expect(critique.measurements.violations).toHaveLength(2);
  });

  it("a retracted grade keeps them, and that is the payload's only usable half", () => {
    const critique = mapEngineResultToCritique(
      "review_m8",
      judged(measured({ findings: [], gradeUnavailableReason: "measured_facts_unjudged" })),
    );

    expect(critique.grade).toBe("unjudged");
    expect(critique.findings).toEqual([]);
    expect(critique.measurements.violations).toHaveLength(2);
    expect(critique.measurements.violations[0]?.detail).toContain("3.23:1");
  });
});
