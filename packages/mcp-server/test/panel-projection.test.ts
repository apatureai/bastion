import { describe, expect, it } from "vitest";
import type { Critique, CritiqueFinding } from "@apature/mcp-types";
import { buildPanelFindings, reviewFixItemsFromCritique } from "../src/panel-findings.js";
import { handlePanelAction } from "../src/panel-interaction.js";

/**
 * The projection that gives the panel producer a real call site: a completed
 * review's Critique -> fix items -> PanelFindings -> the reducer.
 *
 * Load-bearing: groundedness is element_ref AND suggestion (the agent must know
 * both what to change and what to change it to); anything else is advisory and can
 * only ever reach a human; ids are preserved verbatim so a recheck_ref is a valid
 * design_recheck argument; grounded items lead the worklist.
 */

function finding(over: Partial<CritiqueFinding> = {}): CritiqueFinding {
  return {
    finding_id: "f_001",
    severity: "should_fix",
    dimension: "color_contrast",
    title: "Off-token CTA",
    description: "The CTA renders with the default blue.",
    route: "/pricing",
    viewport: "mobile",
    element_ref: "button.cta",
    suggestion: "Apply the --color-accent token.",
    evidence_id: "shot_001",
    confidence: 0.9,
    ...over,
  };
}

const critique = (findings: CritiqueFinding[]): Critique => ({
  review_id: "rev_1",
  grade: "needs_work",
  confidence: 0.7,
  overall: "Two issues.",
  findings,
  not_reviewed: [],
});

describe("reviewFixItemsFromCritique", () => {
  it("a localizable finding with a concrete suggestion is grounded", () => {
    expect(reviewFixItemsFromCritique(critique([finding()]))).toEqual([
      { ref: "f_001", instruction: "Apply the --color-accent token.", grounded: true },
    ]);
  });

  it("a finding with no element_ref is advisory — its suggestion is text for a human", () => {
    const items = reviewFixItemsFromCritique(
      critique([finding({ finding_id: "f_002", element_ref: null })]),
    );
    expect(items).toEqual([
      { ref: "f_002", instruction: "Apply the --color-accent token.", grounded: false },
    ]);
  });

  it("a finding with no suggestion is advisory even when it is localizable", () => {
    const items = reviewFixItemsFromCritique(
      critique([finding({ finding_id: "f_003", suggestion: null, description: "Off-brand." })]),
    );
    expect(items).toEqual([{ ref: "f_003", instruction: "Off-brand.", grounded: false }]);
  });

  it("orders grounded items first, keeping engine order inside each group", () => {
    const items = reviewFixItemsFromCritique(
      critique([
        finding({ finding_id: "a", element_ref: null }),
        finding({ finding_id: "b" }),
        finding({ finding_id: "c", suggestion: null }),
        finding({ finding_id: "d" }),
      ]),
    );
    expect(items.map((i) => i.ref)).toEqual(["b", "d", "a", "c"]);
  });

  it("feeds the reducer: grounded -> fix, advisory -> human_only, refs are finding ids", () => {
    const findings = buildPanelFindings(
      reviewFixItemsFromCritique(
        critique([finding(), finding({ finding_id: "f_002", element_ref: null })]),
      ),
    );
    expect(handlePanelAction({ type: "apply_fix", finding_id: "f_001" }, findings)).toEqual({
      type: "fix",
      finding_id: "f_001",
      fix: "Apply the --color-accent token.",
    });
    expect(handlePanelAction({ type: "apply_fix", finding_id: "f_002" }, findings)).toEqual({
      type: "human_only",
      finding_id: "f_002",
    });
    expect(handlePanelAction({ type: "recheck" }, findings)).toEqual({
      type: "recheck",
      refs: ["f_001", "f_002"],
    });
  });

  it("is deterministic and an empty review yields no items", () => {
    expect(reviewFixItemsFromCritique(critique([]))).toEqual([]);
    const build = () => reviewFixItemsFromCritique(critique([finding()]));
    expect(build()).toEqual(build());
  });
});
