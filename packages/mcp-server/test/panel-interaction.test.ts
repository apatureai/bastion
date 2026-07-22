import { describe, expect, it } from "vitest";
import { handlePanelAction } from "../src/panel-interaction.js";
import type { PanelFinding } from "@apature/mcp-types";

/**
 * Interactive review-panel reducer (idea #64). Load-bearing eyes-not-hands:
 * apply_fix on a grounded finding returns its fix (for the agent, not applied);
 * apply_fix on an advisory finding → human_only; recheck returns deduped refs
 * (whole review or one finding); unknown finding is reported; deterministic.
 */

const findings: PanelFinding[] = [
  { finding_id: "g", fix: "use color.brand.primary", appliable: true, recheck_refs: ["ptr:1", "ptr:2"] },
  { finding_id: "a", fix: "consider tighter spacing", appliable: false, recheck_refs: ["ptr:3"] },
  { finding_id: "n", fix: null, appliable: true },
];

describe("handlePanelAction — apply_fix", () => {
  it("hands the grounded fix to the host (for the agent), never applies it", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "g" }, findings)).toEqual({
      type: "fix",
      finding_id: "g",
      fix: "use color.brand.primary",
    });
  });

  it("returns human_only for an advisory finding (model judgment, not auto-fixable)", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "a" }, findings)).toEqual({
      type: "human_only",
      finding_id: "a",
    });
  });

  it("returns human_only when a finding has no auto-appliable fix", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "n" }, findings)).toEqual({
      type: "human_only",
      finding_id: "n",
    });
  });

  it("reports an unknown finding", () => {
    expect(handlePanelAction({ type: "apply_fix", finding_id: "zzz" }, findings)).toEqual({
      type: "unknown_finding",
      finding_id: "zzz",
    });
  });
});

describe("handlePanelAction — recheck", () => {
  it("returns the whole review's recheck refs, deduped, in order", () => {
    expect(handlePanelAction({ type: "recheck" }, findings)).toEqual({
      type: "recheck",
      refs: ["ptr:1", "ptr:2", "ptr:3"],
    });
  });

  it("scopes recheck to a single finding when given", () => {
    expect(handlePanelAction({ type: "recheck", finding_id: "a" }, findings)).toEqual({
      type: "recheck",
      refs: ["ptr:3"],
    });
  });

  it("reports an unknown finding on a scoped recheck", () => {
    expect(handlePanelAction({ type: "recheck", finding_id: "zzz" }, findings)).toEqual({
      type: "unknown_finding",
      finding_id: "zzz",
    });
  });

  it("is deterministic", () => {
    const build = () => handlePanelAction({ type: "recheck" }, findings);
    expect(build()).toEqual(build());
  });
});
