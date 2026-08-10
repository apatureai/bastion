import { describe, expect, it } from "vitest";
import { toPanelFinding, buildPanelFindings, type ReviewFixItem } from "../src/panel-findings.js";
import { handlePanelAction } from "../src/panel-interaction.js";
import { verdictCliProvenance } from "../src/provenance.js";

/** These fixtures stand in for a review a model actually judged. */
const JUDGED = verdictCliProvenance("live");

/**
 * Panel findings producer (#64): the review-side half of the panel contract.
 * Load-bearing: a grounded item becomes an appliable fix; an advisory item is
 * fix:null/appliable:false (human-only); the cited ref is the recheck handle;
 * cross-axis ids are namespaced; and the output feeds handlePanelAction cleanly.
 */

const grounded: ReviewFixItem = { ref: "color.brand", instruction: "Use token color.brand", grounded: true };
const advisory: ReviewFixItem = { ref: "hero", instruction: "More breathing room", grounded: false };

describe("toPanelFinding — eyes-not-hands projection", () => {
  it("a grounded item carries its instruction as the appliable fix + recheck handle", () => {
    expect(toPanelFinding(grounded)).toEqual({
      finding_id: "color.brand",
      fix: "Use token color.brand",
      appliable: true,
      recheck_refs: ["color.brand"],
    });
  });

  it("an advisory item is fix:null / appliable:false (never auto-applied)", () => {
    expect(toPanelFinding(advisory)).toEqual({
      finding_id: "hero",
      fix: null,
      appliable: false,
      recheck_refs: ["hero"],
    });
  });

  it("namespaces the finding id by axis when the item is cross-axis", () => {
    expect(toPanelFinding({ ...grounded, axis: "drift" }).finding_id).toBe("drift:color.brand");
  });
});

describe("buildPanelFindings — an ordered worklist that drives the reducer", () => {
  it("preserves input order (grounded-then-advisory as the fix plan orders them)", () => {
    const findings = buildPanelFindings([grounded, advisory]);
    expect(findings.map((f) => f.finding_id)).toEqual(["color.brand", "hero"]);
  });

  it("the produced findings drive handlePanelAction end-to-end (grounded→fix, advisory→human)", () => {
    const findings = buildPanelFindings([{ ...grounded, axis: "drift" }, { ...advisory, axis: "rendered-review" }]);
    expect(handlePanelAction({ type: "apply_fix", finding_id: "drift:color.brand" }, findings, JUDGED)).toEqual({
      type: "fix",
      finding_id: "drift:color.brand",
      fix: "Use token color.brand",
    });
    expect(handlePanelAction({ type: "apply_fix", finding_id: "rendered-review:hero" }, findings, JUDGED)).toEqual({
      type: "human_only",
      finding_id: "rendered-review:hero",
    });
    // recheck (whole review) gathers each finding's ref.
    expect(handlePanelAction({ type: "recheck" }, findings, JUDGED)).toEqual({
      type: "recheck",
      refs: ["color.brand", "hero"],
    });
  });

  it("is deterministic and an empty plan yields no findings", () => {
    expect(buildPanelFindings([])).toEqual([]);
    const build = () => buildPanelFindings([grounded, advisory]);
    expect(build()).toEqual(build());
  });
});
