import { describe, expect, it } from "vitest";
import type { EngineReviewCoverage, EngineReviewResult } from "../src/index.js";
import {
  coverageState,
  hallucinationDrops,
  loadGoldenEngineResult,
  routesSkipped,
  suppressesGradeForCoverage,
  viewportsSkipped,
} from "../src/index.js";

/**
 * The classification, on its own.
 *
 * `provenance` answers "did a model judge this page?" and this answers "what did
 * it judge?". The pair is the whole point: a run can pass the first question and
 * fail the second, and until this existed Bastion only asked the first. The
 * boundary cases below are the ones that decide whether an agent is told to
 * trust a result, so each is pinned rather than left to the mapper's behaviour.
 */

const golden = loadGoldenEngineResult();

function withCoverage(coverage: EngineReviewCoverage | undefined): EngineReviewResult {
  const result = { ...golden };
  if (coverage === undefined) delete result.coverage;
  else result.coverage = coverage;
  return result;
}

const coverage = (over: Partial<EngineReviewCoverage> = {}): EngineReviewCoverage => ({
  routesRequested: ["/pricing", "/checkout"],
  routesReviewed: ["/pricing", "/checkout"],
  viewportsRequested: ["mobile", "desktop"],
  viewportsReviewed: ["mobile", "desktop"],
  ...over,
});

describe("coverageState", () => {
  it("is full when every requested route and viewport was reviewed", () => {
    expect(coverageState(withCoverage(coverage()))).toBe("full");
  });

  it("is partial when a route was requested and never judged", () => {
    expect(coverageState(withCoverage(coverage({ routesReviewed: ["/pricing"] })))).toBe("partial");
  });

  it("is partial when a viewport was requested and never judged", () => {
    expect(coverageState(withCoverage(coverage({ viewportsReviewed: ["mobile"] })))).toBe("partial");
  });

  it("is nothing when the reviewed route set is empty, whatever the grade says", () => {
    const empty = withCoverage(coverage({ routesReviewed: [], viewportsReviewed: [] }));
    // The grade is still `needs_work` on the fixture and would be `ship` on a
    // real empty run. Neither is evidence of anything; the reviewed set is.
    expect(coverageState(empty)).toBe("nothing");
  });

  it("is nothing even when the engine reported no requested routes either", () => {
    const empty = withCoverage(
      coverage({ routesRequested: [], routesReviewed: [], viewportsReviewed: [] }),
    );
    expect(coverageState(empty)).toBe("nothing");
  });

  it("is unstated when the engine did not report coverage, never full", () => {
    expect(coverageState(withCoverage(undefined))).toBe("unstated");
  });

  it("counts a superset as full, so an extra route is not reported as a skip", () => {
    const extra = coverage({ routesReviewed: ["/pricing", "/checkout", "/nobody-asked"] });
    expect(coverageState(withCoverage(extra))).toBe("full");
    expect(routesSkipped(extra)).toEqual([]);
  });

  it("treats a duplicated request as one item, so a repeat is not a phantom skip", () => {
    const dup = coverage({ routesRequested: ["/pricing", "/pricing", "/checkout"] });
    expect(coverageState(withCoverage(dup))).toBe("full");
    expect(routesSkipped(dup)).toEqual([]);
  });
});

describe("suppressesGradeForCoverage", () => {
  it("suppresses only `nothing`", () => {
    expect(suppressesGradeForCoverage("nothing")).toBe(true);
  });

  it("does NOT suppress a partial, which is a real verdict about a smaller surface", () => {
    // The golden fixture is the counterexample the rule exists for: it skipped
    // /checkout and the tablet viewport and still carries real findings. Failing
    // it would punish an honest partial for saying what it skipped.
    expect(coverageState(golden)).toBe("partial");
    expect(suppressesGradeForCoverage("partial")).toBe(false);
    expect(golden.findings.length).toBeGreaterThan(0);
  });

  it("does NOT suppress `unstated`, because an older engine's true results are still true", () => {
    expect(suppressesGradeForCoverage("unstated")).toBe(false);
  });

  it("does NOT suppress `full`", () => {
    expect(suppressesGradeForCoverage("full")).toBe(false);
  });
});

describe("skipped-item lists", () => {
  it("names the requested routes with no counterpart, in requested order", () => {
    expect(
      routesSkipped(
        coverage({
          routesRequested: ["/c", "/a", "/b"],
          routesReviewed: ["/a"],
        }),
      ),
    ).toEqual(["/c", "/b"]);
  });

  it("names the skipped viewports the same way", () => {
    expect(
      viewportsSkipped(
        coverage({ viewportsRequested: ["mobile", "tablet", "desktop"], viewportsReviewed: ["mobile"] }),
      ),
    ).toEqual(["tablet", "desktop"]);
  });
});

describe("hallucinationDrops", () => {
  it("keeps 0 and absent apart: 0 means the gate ran, null means no gate reported", () => {
    expect(hallucinationDrops({ ...golden, hallucinationDrops: 0 })).toBe(0);
    const absent = { ...golden };
    delete absent.hallucinationDrops;
    expect(hallucinationDrops(absent)).toBeNull();
  });

  it("carries a positive count through", () => {
    expect(hallucinationDrops({ ...golden, hallucinationDrops: 4 })).toBe(4);
  });

  it("reports a nonsense value as unstated rather than passing it on", () => {
    // A number Bastion would have to explain is not a number it should print.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3" as unknown as number]) {
      expect(hallucinationDrops({ ...golden, hallucinationDrops: bad })).toBeNull();
    }
  });
});
