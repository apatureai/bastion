import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EngineReviewCoverage, EngineReviewResult } from "@apature/mcp-types";
import { mapEngineResultToCritique } from "../src/index.js";
import {
  coverageLines,
  coverageSummaryLine,
  groundingDisclosure,
  NOTHING_REVIEWED_DISCLOSURE_PREFIX,
} from "../src/coverage.js";
import { buildMultimediaCritiqueContent } from "../src/multimedia-content.js";
import { renderReviewPanel } from "../src/panel-html.js";
import { buildPanelFindings, reviewFixItemsFromCritique } from "../src/panel-findings.js";
import {
  FIXTURE_PROVENANCE,
  NO_MODEL_DISCLOSURE_PREFIX,
  stampProvenance,
  verdictCliProvenance,
} from "../src/provenance.js";

/**
 * The defect this file exists for.
 *
 * README tells a coding agent one rule: trust the result only when
 * `provenance.model_backed === true`. That returned `true` for a run that
 * reviewed nothing. Verdict states both facts on every result, `coverage` and
 * `hallucinationDrops`; both survived `parseEngineReviewResult` as unrecognized
 * extras and were then dropped, field by field, by `mapEngineResultToCritique`.
 * A real verdict run whose triage concluded a deep review was needed and then
 * named no route reached an agent as:
 *
 *   {"grade":"ship","findings":[],"provenance":{"model_backed":true, ...}}
 *
 * while gate, reading the identical bytes, published a neutral "Nothing
 * reviewed". These tests pin both halves: that the fields are carried, and that
 * the grade is refused when the reviewed route set is empty.
 */

function loadBlockerEngineResult(): EngineReviewResult {
  const path = new URL("./fixtures/engine-review-result.blocker.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as EngineReviewResult;
}

const base = loadBlockerEngineResult();

const coverage = (over: Partial<EngineReviewCoverage> = {}): EngineReviewCoverage => ({
  routesRequested: ["/pricing", "/checkout"],
  routesReviewed: ["/pricing", "/checkout"],
  viewportsRequested: ["mobile", "desktop"],
  viewportsReviewed: ["mobile", "desktop"],
  ...over,
});

/** A live, model-backed engine result: the state README tells agents to trust. */
function liveResult(over: Partial<EngineReviewResult> = {}): EngineReviewResult {
  const result: EngineReviewResult = { ...base, ...over };
  return stampProvenance(result, verdictCliProvenance("live", result));
}

/** The real shape of the defect: a live model call that judged no route. */
const NOTHING_REVIEWED = coverage({ routesReviewed: [], viewportsReviewed: [] });

describe("the engine's coverage and grounding count reach the agent", () => {
  it("carries coverage through the mapper instead of dropping it", () => {
    const critique = mapEngineResultToCritique(
      "rev_cov_0001",
      liveResult({ coverage: coverage({ routesReviewed: ["/pricing"] }) }),
    );
    expect(critique.coverage.state).toBe("partial");
    expect(critique.coverage.routes_requested).toEqual(["/pricing", "/checkout"]);
    expect(critique.coverage.routes_reviewed).toEqual(["/pricing"]);
    expect(critique.coverage.routes_skipped).toEqual(["/checkout"]);
    expect(critique.coverage.viewports_reviewed).toEqual(["mobile", "desktop"]);
    expect(critique.coverage.viewports_skipped).toEqual([]);
  });

  it("carries the grounding-gate count through, keeping 0 and absent apart", () => {
    expect(
      mapEngineResultToCritique("rev_cov_0002", liveResult({ hallucinationDrops: 4 }))
        .hallucination_drops,
    ).toBe(4);
    expect(
      mapEngineResultToCritique("rev_cov_0003", liveResult({ hallucinationDrops: 0 }))
        .hallucination_drops,
    ).toBe(0);
    const absent = liveResult();
    delete absent.hallucinationDrops;
    expect(mapEngineResultToCritique("rev_cov_0004", absent).hallucination_drops).toBeNull();
  });

  it("reports absent coverage as an explicit `unstated`, never as a missing key", () => {
    // A consumer that has to branch on `coverage === undefined` will eventually
    // forget to, and forgetting defaults to "everything was reviewed".
    const absent = liveResult();
    delete absent.coverage;
    const critique = mapEngineResultToCritique("rev_cov_0005", absent);
    expect(critique.coverage.state).toBe("unstated");
    expect(critique.coverage.routes_reviewed).toEqual([]);
    expect(critique.grade).toBe(base.grade); // and it does NOT suppress the grade
  });
});

describe("a live run that judged nothing is refused a grade", () => {
  const critique = mapEngineResultToCritique(
    "rev_cov_0100",
    liveResult({ coverage: NOTHING_REVIEWED }),
  );

  it("is the exact payload the defect produced: model-backed, and it reviewed nothing", () => {
    // Both facts, side by side, because they are the pair that used to be
    // impossible to see together from a Bastion payload.
    expect(critique.provenance.model_backed).toBe(true);
    expect(critique.coverage.routes_reviewed).toEqual([]);
  });

  it("replaces the grade with nothing_reviewed rather than the engine's ship", () => {
    expect(base.grade).not.toBe("nothing_reviewed");
    expect(critique.grade).toBe("nothing_reviewed");
  });

  it("replaces the narrative rather than annotating it, so the fiction cannot be quoted", () => {
    expect(critique.overall).not.toContain(base.overall);
    expect(critique.overall).toContain("reviewed nothing");
    expect(critique.overall).toContain("0 of 2 requested routes");
  });

  it("withholds confidence, because there is nothing to be confident about", () => {
    expect(critique.confidence).toBeNull();
    expect(critique.findings.every((f) => f.confidence === null)).toBe(true);
  });

  it("marks every finding, because an agent iterating findings never reads the envelope", () => {
    expect(critique.findings.length).toBeGreaterThan(0);
    expect(critique.findings.every((f) => f.unjudged === true)).toBe(true);
  });

  it("discloses it in not_reviewed, in the same greppable family as the no-model line", () => {
    const disclosure = critique.not_reviewed.find((entry) =>
      entry.startsWith(NOTHING_REVIEWED_DISCLOSURE_PREFIX),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain("nothing_reviewed");
  });

  it("adds the disclosure once, even if the engine already said something similar", () => {
    const already = liveResult({
      coverage: NOTHING_REVIEWED,
      notReviewed: [`${NOTHING_REVIEWED_DISCLOSURE_PREFIX}: said upstream`, "/pricing: skipped"],
    });
    const mapped = mapEngineResultToCritique("rev_cov_0101", already);
    expect(
      mapped.not_reviewed.filter((e) => e.startsWith(NOTHING_REVIEWED_DISCLOSURE_PREFIX)),
    ).toHaveLength(1);
  });
});

describe("when nothing was reviewed AND nothing judged the page", () => {
  const both = mapEngineResultToCritique(
    "rev_cov_0200",
    stampProvenance({ ...base, coverage: NOTHING_REVIEWED }, FIXTURE_PROVENANCE),
  );

  it("coverage wins the grade, as it does on gate's Check Run title", () => {
    // An operator whose run judged no page is not helped by being told the
    // judgment stamp was missing too; the stronger, more actionable fact wins.
    expect(both.grade).toBe("nothing_reviewed");
  });

  it("still carries the judgment fact, unchanged, in provenance", () => {
    expect(both.provenance).toEqual(FIXTURE_PROVENANCE);
    expect(both.provenance.model_backed).toBe(false);
  });

  it("keeps the documented not_reviewed[0] invariant, and adds the coverage line after it", () => {
    // README points agents at `not_reviewed[0]` beginning with the no-model
    // prefix. Both disclosures are present; only the order is decided here.
    expect(both.not_reviewed[0]?.startsWith(NO_MODEL_DISCLOSURE_PREFIX)).toBe(true);
    expect(both.not_reviewed[1]?.startsWith(NOTHING_REVIEWED_DISCLOSURE_PREFIX)).toBe(true);
  });
});

describe("what does NOT suppress a grade", () => {
  it("a partial review keeps its grade: it is a real verdict about a smaller surface", () => {
    const partial = mapEngineResultToCritique(
      "rev_cov_0300",
      liveResult({ coverage: coverage({ routesReviewed: ["/pricing"] }) }),
    );
    expect(partial.grade).toBe(base.grade);
    expect(partial.overall).toBe(base.overall);
    expect(partial.findings.some((f) => f.unjudged === true)).toBe(false);
  });

  it("a grounding sweep that deleted everything keeps its grade, and says so instead", () => {
    // Gate's rule, kept identical: the routes WERE judged, and deleting
    // ungroundable findings is the grounding gate working. The disclosure is
    // what stops an empty finding list reading as a clean page.
    const swept = mapEngineResultToCritique(
      "rev_cov_0301",
      liveResult({ coverage: coverage(), findings: [], hallucinationDrops: 4 }),
    );
    expect(swept.grade).toBe(base.grade);
    expect(swept.findings).toEqual([]);
    expect(swept.hallucination_drops).toBe(4);
    expect(coverageLines(swept).join("\n")).toContain(
      "4 model finding(s) were deleted for citing a route or element the capture never produced",
    );
  });

  it("an engine that reports no coverage keeps its grade and is disclosed as unstated", () => {
    const absent = liveResult();
    delete absent.coverage;
    const critique = mapEngineResultToCritique("rev_cov_0302", absent);
    expect(critique.grade).toBe(base.grade);
    expect(coverageSummaryLine(critique.coverage)).toContain("did not report which routes");
  });
});

describe("every surface says the same thing about one run", () => {
  const critique = mapEngineResultToCritique(
    "rev_cov_0400",
    liveResult({ coverage: NOTHING_REVIEWED, hallucinationDrops: 3 }),
  );

  it("the MCP content blocks carry the coverage and grounding lines", () => {
    // A client that renders `content[]` never opens `structuredContent`, so the
    // surface an agent actually reads must not be the quieter one.
    const texts = buildMultimediaCritiqueContent(critique, [], { images: true })
      .content.filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text);
    expect(texts.some((t) => t.startsWith("Coverage: 0 of 2 route(s) reviewed"))).toBe(true);
    expect(texts.some((t) => t.includes("3 model finding(s) were deleted"))).toBe(true);
  });

  it("the HTML panel carries them too", () => {
    const html = renderReviewPanel(
      critique,
      buildPanelFindings(reviewFixItemsFromCritique(critique)),
      [],
    );
    expect(html).toContain("Coverage: 0 of 2 route(s) reviewed");
    expect(html).toContain("3 model finding(s) were deleted");
    expect(html).toContain("nothing_reviewed");
  });

  it("uses gate's words, so a reader of both repositories learns one vocabulary", () => {
    // These strings are lifted from apatureai/gate's delivery/coverage.ts and
    // check-run.ts. Pinned so a future edit here cannot quietly fork the
    // vocabulary the two repositories share.
    expect(coverageSummaryLine(critique.coverage)).toContain("0 of 2 route(s) reviewed");
    expect(groundingDisclosure(2)).toContain(
      "2 model finding(s) were deleted for citing a route or element the capture never produced",
    );
    expect(critique.overall).toContain("This run is not a pass and not a failure.");
    expect(critique.overall).toContain("A result with no findings grades ship by construction");
  });

  it("emits no em dash anywhere, because all of this is program output", () => {
    const surfaces = [
      critique.overall,
      ...critique.not_reviewed,
      ...coverageLines(critique),
      renderReviewPanel(critique, buildPanelFindings(reviewFixItemsFromCritique(critique)), []),
    ];
    for (const text of surfaces) expect(text).not.toContain("—");
  });
});
