import { describe, expect, it } from "vitest";
import { handlePanelAction } from "../src/panel-interaction.js";
import { FIXTURE_PROVENANCE, verdictCliProvenance } from "../src/provenance.js";
import type { PanelFinding } from "@apatureai/bastion-types";

/**
 * Interactive review-panel reducer (idea #64). Load-bearing eyes-not-hands:
 * apply_fix on a grounded finding returns its fix (for the agent, not applied);
 * apply_fix on an advisory finding → human_only; apply_fix on a review nothing
 * judged → unjudged, never a fix; recheck returns deduped refs (whole review or
 * one finding); unknown finding is reported; deterministic.
 */

const findings: PanelFinding[] = [
  { finding_id: "g", fix: "use color.brand.primary", appliable: true, recheck_refs: ["ptr:1", "ptr:2"] },
  { finding_id: "a", fix: "consider tighter spacing", appliable: false, recheck_refs: ["ptr:3"] },
  { finding_id: "n", fix: null, appliable: true },
];

/** A review a model actually judged: the grounded/advisory routing applies. */
const JUDGED = verdictCliProvenance("live");
/** A review nothing judged: every fix in it is invented, so none is handed over. */
const UNJUDGED = FIXTURE_PROVENANCE;

describe("handlePanelAction — apply_fix", () => {
  it("hands the grounded fix to the host (for the agent), never applies it", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "g" }, findings, JUDGED)).toEqual({
      type: "fix",
      finding_id: "g",
      fix: "use color.brand.primary",
    });
  });

  it("returns human_only for an advisory finding (model judgment, not auto-fixable)", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "a" }, findings, JUDGED)).toEqual({
      type: "human_only",
      finding_id: "a",
    });
  });

  it("returns human_only when a finding has no auto-appliable fix", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "n" }, findings, JUDGED)).toEqual({
      type: "human_only",
      finding_id: "n",
    });
  });

  it("reports an unknown finding", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "zzz" }, findings, JUDGED)).toEqual({
      type: "unknown_finding",
      finding_id: "zzz",
    });
  });

  it("returns unjudged, and no fix string, when nothing judged the review", () => {
    // The grounded finding is the dangerous one: its `fix` reads as an
    // instruction a coding agent can apply, and on an unjudged path that string
    // was invented. It must not appear in the response at all.
    const response = handlePanelAction({ type: "apply_fix", finding_id: "g" }, findings, UNJUDGED);
    expect(response).toEqual({ type: "unjudged", finding_id: "g" });
    expect(JSON.stringify(response)).not.toContain("use color.brand.primary");
  });

  it("does not disguise an unjudged review as an advisory one", () => {
    // `human_only` means "model judgment that needs a person". There is no
    // model judgment here, so claiming one would be a different lie, not a fix.
    expect(handlePanelAction({ type: "apply_fix", finding_id: "a" }, findings, UNJUDGED)).toEqual({
      type: "unjudged",
      finding_id: "a",
    });
  });

  it("still reports an unknown finding on an unjudged review", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "zzz" }, findings, UNJUDGED)).toEqual({
      type: "unknown_finding",
      finding_id: "zzz",
    });
  });
});

describe("handlePanelAction — recheck", () => {
  it("returns the whole review's recheck refs, deduped, in order", () => {
    expect(handlePanelAction({ type: "recheck" }, findings, JUDGED)).toEqual({
      type: "recheck",
      refs: ["ptr:1", "ptr:2", "ptr:3"],
    });
  });

  it("scopes recheck to a single finding when given", () => {
    expect(handlePanelAction({ type: "recheck", finding_id: "a" }, findings, JUDGED)).toEqual({
      type: "recheck",
      refs: ["ptr:3"],
    });
  });

  it("reports an unknown finding on a scoped recheck", () => {
    expect(handlePanelAction({ type: "recheck", finding_id: "zzz" }, findings, JUDGED)).toEqual({
      type: "unknown_finding",
      finding_id: "zzz",
    });
  });

  it("is deterministic", () => {
    const build = () => handlePanelAction({ type: "recheck" }, findings, JUDGED);
    expect(build()).toEqual(build());
  });

  it("still returns refs on an unjudged review: a ref is a handle, not a claim", () => {
    // Asking to re-verify is the right move when nothing judged the page, and a
    // ref asserts nothing about the target, so this path is unchanged.
    expect(handlePanelAction({ type: "recheck" }, findings, UNJUDGED)).toEqual({
      type: "recheck",
      refs: ["ptr:1", "ptr:2", "ptr:3"],
    });
  });
});
