import { describe, expect, it } from "vitest";
import { buildMultimediaCritiqueContent } from "../src/multimedia-content.js";
import type { AnnotatedImage, Critique, CritiqueFinding } from "@apature/mcp-types";

/**
 * D3 multimedia design_review content shaping (#58). Load-bearing: an overall
 * text block leads; each finding is a text block; an annotated crop becomes an
 * image block ONLY when the host supports images and a real image/* crop was
 * supplied; a non-multimedia host gets the text and an explicit images_withheld
 * list (honest downgrade, never a broken block); non-image MIME is not emitted;
 * deterministic + order-preserving.
 */

function finding(over: Partial<CritiqueFinding> = {}): CritiqueFinding {
  return {
    finding_id: "f1",
    severity: "blocker",
    dimension: "color",
    title: "Off-token color",
    description: "Uses #3B82F6",
    route: "/pricing",
    viewport: "desktop",
    element_ref: "button.cta",
    suggestion: "use color.brand.primary",
    evidence_id: "ev-1",
    confidence: 0.9,
    ...over,
  };
}

function critique(findings: CritiqueFinding[], over: Partial<Critique> = {}): Critique {
  return {
    review_id: "r1",
    grade: "blocked",
    confidence: 0.9,
    overall: "One blocker.",
    findings,
    not_reviewed: [],
    ...over,
  };
}

const png = (evidenceId: string): AnnotatedImage => ({ evidenceId, data: "AAAA", mimeType: "image/png" });

describe("buildMultimediaCritiqueContent", () => {
  it("emits an image block after a finding when the host supports images", () => {
    const r = buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: true });
    expect(r.multimedia).toBe(true);
    expect(r.images_withheld).toEqual([]);
    // overall text, finding text, image
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "image"]);
    const img = r.content[2];
    expect(img).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("downgrades honestly for a non-multimedia host: text only + images_withheld", () => {
    const r = buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: false });
    expect(r.multimedia).toBe(false);
    expect(r.images_withheld).toEqual(["ev-1"]);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text"]); // no image block
  });

  it("does not fabricate an image block when no crop was supplied for a finding", () => {
    const r = buildMultimediaCritiqueContent(critique([finding()]), [], { images: true });
    expect(r.multimedia).toBe(false);
    expect(r.images_withheld).toEqual([]);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text"]);
  });

  it("ignores a non-image MIME type (never emits it or withholds it)", () => {
    const bad: AnnotatedImage = { evidenceId: "ev-1", data: "AAAA", mimeType: "text/html" };
    const r = buildMultimediaCritiqueContent(critique([finding()]), [bad], { images: true });
    expect(r.multimedia).toBe(false);
    expect(r.images_withheld).toEqual([]);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text"]);
  });

  it("handles a finding with no evidence_id (text only)", () => {
    const r = buildMultimediaCritiqueContent(critique([finding({ evidence_id: null })]), [png("ev-1")], { images: true });
    expect(r.content.map((c) => c.type)).toEqual(["text", "text"]);
    expect(r.multimedia).toBe(false);
  });

  it("preserves finding order and appends a not-reviewed note", () => {
    const c = critique(
      [finding({ finding_id: "a", evidence_id: "ev-a" }), finding({ finding_id: "b", evidence_id: "ev-b" })],
      { not_reviewed: ["/checkout"] },
    );
    const r = buildMultimediaCritiqueContent(c, [png("ev-a"), png("ev-b")], { images: true });
    // overall, a-text, a-img, b-text, b-img, not-reviewed
    expect(r.content.map((b) => b.type)).toEqual(["text", "text", "image", "text", "image", "text"]);
    expect((r.content.at(-1) as { text: string }).text).toContain("/checkout");
  });

  it("is deterministic", () => {
    const build = () => buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: true });
    expect(build()).toEqual(build());
  });
});
