import { describe, expect, it } from "vitest";
import type { AnnotatedImage, Critique, CritiqueFinding } from "@apature/mcp-types";
import { renderReviewPanel } from "../src/panel-html.js";
import { buildPanelFindings, reviewFixItemsFromCritique } from "../src/panel-findings.js";

/**
 * The panel document. Load-bearing: findings quote a page an attacker may control,
 * so every interpolation is escaped and nothing is fetched (evidence is a data:
 * URI); and the on-screen routing label must match what the reducer would decide,
 * so the panel can never advertise a fix the reducer would refuse.
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
  not_reviewed: ["route /checkout (no preview matched)"],
});

const render = (c: Critique, images: AnnotatedImage[] = []): string =>
  renderReviewPanel(c, buildPanelFindings(reviewFixItemsFromCritique(c)), images);

describe("renderReviewPanel", () => {
  it("renders the verdict, every finding, and the not-reviewed list", () => {
    const html = render(critique([finding(), finding({ finding_id: "f_002", title: "Grid overflows" })]));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("needs_work");
    expect(html).toContain("Off-token CTA");
    expect(html).toContain("Grid overflows");
    expect(html).toContain("route /checkout (no preview matched)");
  });

  it("escapes page-derived text instead of emitting it as markup", () => {
    const html = render(
      critique([
        finding({
          title: "<script>alert(1)</script>",
          description: 'quote " and \'apostrophe\' & ampersand',
          element_ref: "<img onerror=x>",
        }),
      ]),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&amp; ampersand");
  });

  it("labels a grounded finding agent-appliable and an advisory one needs-a-human", () => {
    const html = render(
      critique([finding(), finding({ finding_id: "f_002", element_ref: null, suggestion: null })]),
    );
    expect(html).toContain("agent-appliable");
    expect(html).toContain("needs a human");
    expect(html).toContain("advisory judgment");
  });

  it("embeds matched evidence as a data URI and never references a remote URL", () => {
    const html = render(critique([finding()]), [
      { evidenceId: "shot_001", data: "QUJD", mimeType: "image/png" },
    ]);
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("renders text-only when a finding has no evidence", () => {
    const html = render(critique([finding({ evidence_id: null })]));
    expect(html).toContain("No evidence crop for this finding.");
    expect(html).not.toContain("<img class=\"evidence\"");
  });

  it("is deterministic", () => {
    const c = critique([finding()]);
    expect(render(c)).toBe(render(c));
  });
});
