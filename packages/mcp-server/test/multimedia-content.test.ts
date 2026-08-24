import { describe, expect, it } from "vitest";
import {
  buildMultimediaCritiqueContent,
  buildDesignReviewContent,
  MCP_APP_PANEL_MIME,
  UNJUDGED_BLOCK_DISCLOSURE,
  UNJUDGED_BLOCK_META_KEY,
  UNJUDGED_DISCLOSURE_META_KEY,
} from "../src/multimedia-content.js";
import type {
  AnnotatedImage,
  Critique,
  CritiqueFinding,
  ImageContentBlock,
  TextContentBlock,
} from "@apatureai/bastion-types";

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
    // A Critique carries what the run COVERED as well as who judged it; these
    // fixtures stand in for a real, model-backed review that covered everything
    // it was asked for.
    coverage: {
      state: "full",
      routes_requested: ["/pricing"],
      routes_reviewed: ["/pricing"],
      routes_skipped: [],
      viewports_requested: ["desktop"],
      viewports_reviewed: ["desktop"],
      viewports_skipped: [],
    },
    hallucination_drops: 0,
    // A Critique always carries its judgment provenance; these fixtures stand
    // in for a real, model-backed review.
    provenance: {
      model_backed: true,
      source: "model",
      engine: "verdict-cli",
      model: "qwen3-vl",
      detail: "a model judged the capture",
    },
    ...over,
  };
}

const png = (evidenceId: string): AnnotatedImage => ({ evidenceId, data: "AAAA", mimeType: "image/png" });

describe("buildMultimediaCritiqueContent", () => {
  it("emits an image block after a finding when the host supports images", () => {
    const r = buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: true });
    expect(r.multimedia).toBe(true);
    expect(r.images_withheld).toEqual([]);
    // overall text, coverage text, finding text, image
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "text", "image"]);
    const img = r.content[3];
    expect(img).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("downgrades honestly for a non-multimedia host: text only + images_withheld", () => {
    const r = buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: false });
    expect(r.multimedia).toBe(false);
    expect(r.images_withheld).toEqual(["ev-1"]);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "text"]); // no image block
  });

  it("does not fabricate an image block when no crop was supplied for a finding", () => {
    const r = buildMultimediaCritiqueContent(critique([finding()]), [], { images: true });
    expect(r.multimedia).toBe(false);
    expect(r.images_withheld).toEqual([]);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "text"]);
  });

  it("ignores a non-image MIME type (never emits it or withholds it)", () => {
    const bad: AnnotatedImage = { evidenceId: "ev-1", data: "AAAA", mimeType: "text/html" };
    const r = buildMultimediaCritiqueContent(critique([finding()]), [bad], { images: true });
    expect(r.multimedia).toBe(false);
    expect(r.images_withheld).toEqual([]);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "text"]);
  });

  it("handles a finding with no evidence_id (text only)", () => {
    const r = buildMultimediaCritiqueContent(critique([finding({ evidence_id: null })]), [png("ev-1")], { images: true });
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "text"]);
    expect(r.multimedia).toBe(false);
  });

  it("preserves finding order and appends a not-reviewed note", () => {
    const c = critique(
      [finding({ finding_id: "a", evidence_id: "ev-a" }), finding({ finding_id: "b", evidence_id: "ev-b" })],
      { not_reviewed: ["/checkout"] },
    );
    const r = buildMultimediaCritiqueContent(c, [png("ev-a"), png("ev-b")], { images: true });
    // overall, coverage, a-text, a-img, b-text, b-img, not-reviewed
    expect(r.content.map((b) => b.type)).toEqual(["text", "text", "text", "image", "text", "image", "text"]);
    expect((r.content.at(-1) as { text: string }).text).toContain("/checkout");
  });

  /**
   * The per-item disclosure. `structuredContent.findings[]` marks each item
   * `unjudged`; the parallel `content[]` blocks did not, so a client that
   * renders content rather than reading structured content showed confident,
   * specific advice about a page nothing looked at. A block is read on its own,
   * so it has to say what it is on its own.
   */
  describe("per-item unjudged marking", () => {
    const unjudgedCritique = (): Critique =>
      critique([finding({ unjudged: true }), finding({ finding_id: "f2", evidence_id: null, unjudged: true })], {
        grade: "unjudged",
        confidence: null,
        overall: "No model judged this page.",
        provenance: {
          model_backed: false,
          source: "fixture",
          engine: "bastion-fixture",
          model: null,
          detail: "the offline fixture engine replayed the golden result",
        },
      });

    it("marks every finding block, not only the envelope block", () => {
      const r = buildMultimediaCritiqueContent(unjudgedCritique(), [], { images: true });
      const texts = r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
      // Block 0 is the envelope and block 1 is coverage. Every block after
      // those is a finding, and each one carries the marker by itself.
      expect(texts.length).toBe(4);
      for (const text of texts.slice(2)) {
        expect(text).toContain("[unjudged]");
        expect(text).toContain("not an observation of the target");
      }
    });

    it("uses the structured field's own vocabulary, not a second scheme", () => {
      const [, , first] = buildMultimediaCritiqueContent(unjudgedCritique(), [], { images: true }).content;
      expect((first as { text: string }).text.startsWith("[blocker] [unjudged] ")).toBe(true);
    });

    /**
     * The image block was the last unmarked surface. A `text` block can carry
     * the disclosure in its own words; an `image` block has no words, so a host
     * that renders pictures could show an annotated crop of a page nothing
     * looked at with the disclosure only in a neighbouring block. MCP puts
     * `_meta` on every content block for exactly this, so the marker goes there.
     */
    it("marks the image block, not only the text block beside it", () => {
      const r = buildMultimediaCritiqueContent(unjudgedCritique(), [png("ev-1")], { images: true });
      const image = r.content.find((b): b is ImageContentBlock => b.type === "image");
      expect(image, "no image block was emitted").toBeDefined();
      expect(image!._meta).toEqual({
        [UNJUDGED_BLOCK_META_KEY]: true,
        [UNJUDGED_DISCLOSURE_META_KEY]: UNJUDGED_BLOCK_DISCLOSURE,
      });
    });

    it("says the same thing in the image's _meta as in the text block's words", () => {
      const r = buildMultimediaCritiqueContent(unjudgedCritique(), [png("ev-1")], { images: true });
      const image = r.content.find((b): b is ImageContentBlock => b.type === "image")!;
      const text = r.content.filter((b): b is TextContentBlock => b.type === "text")[2]!;
      // The text block that the image illustrates, and the image itself, carry
      // one sentence from one constant: they cannot drift into two accounts.
      expect(text.text).toContain(UNJUDGED_BLOCK_DISCLOSURE);
      expect(image._meta?.[UNJUDGED_DISCLOSURE_META_KEY]).toBe(UNJUDGED_BLOCK_DISCLOSURE);
      expect(text._meta).toEqual(image._meta);
    });

    it("leaves a judged image block bare, so the marker's absence is not a claim", () => {
      const r = buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: true });
      const image = r.content.find((b): b is ImageContentBlock => b.type === "image")!;
      expect(image).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
      expect(Object.keys(image)).not.toContain("_meta");
    });

    it("says nothing on a judged finding, so the marker's absence is not a claim", () => {
      const r = buildMultimediaCritiqueContent(critique([finding()]), [], { images: true });
      const text = (r.content[2] as { text: string }).text;
      expect(text).not.toContain("unjudged");
      expect(text).toContain("[blocker] Off-token color");
    });

    it("emits no em dash in any block, because block text is program output", () => {
      const blocks = [
        ...buildMultimediaCritiqueContent(unjudgedCritique(), [], { images: true }).content,
        ...buildMultimediaCritiqueContent(critique([finding()], { not_reviewed: ["/checkout"] }), [], {
          images: true,
        }).content,
      ];
      for (const block of blocks) {
        if (block.type === "text") expect((block as { text: string }).text).not.toContain("—");
      }
    });
  });

  it("is deterministic", () => {
    const build = () => buildMultimediaCritiqueContent(critique([finding()]), [png("ev-1")], { images: true });
    expect(build()).toEqual(build());
  });
});

describe("buildDesignReviewContent — MCP-Apps panel + multimedia", () => {
  const PANEL = "<section>review panel</section>";

  it("leads with the HTML panel resource block when the host supports MCP-Apps", () => {
    const r = buildDesignReviewContent(critique([finding()]), [png("ev-1")], { images: true, appsPanel: true }, PANEL);
    expect(r.panel).toBe(true);
    expect(r.panel_withheld).toBe(false);
    expect(r.content[0]).toEqual({
      type: "resource",
      resource: { uri: "ui://apature/design-review/r1", mimeType: MCP_APP_PANEL_MIME, text: PANEL },
    });
    // The MCP-Apps profile marker, not plain text/html, is what makes the host
    // render it as an interactive panel.
    expect(MCP_APP_PANEL_MIME).toBe("text/html;profile=mcp-app");
    // panel first, then the multimedia blocks (overall, coverage, finding, image)
    expect(r.content.map((b) => b.type)).toEqual(["resource", "text", "text", "text", "image"]);
  });

  it("withholds the panel honestly when the host lacks MCP-Apps (no resource block)", () => {
    const r = buildDesignReviewContent(critique([finding()]), [png("ev-1")], { images: true, appsPanel: false }, PANEL);
    expect(r.panel).toBe(false);
    expect(r.panel_withheld).toBe(true);
    expect(r.content.some((b) => b.type === "resource")).toBe(false);
    expect(r.multimedia).toBe(true); // images still flow
  });

  it("treats absent appsPanel capability as unsupported (withheld)", () => {
    const r = buildDesignReviewContent(critique([finding()]), [], { images: false }, PANEL);
    expect(r.panel).toBe(false);
    expect(r.panel_withheld).toBe(true);
  });

  it("emits no panel and does not mark it withheld when no panel HTML is supplied", () => {
    const r = buildDesignReviewContent(critique([finding()]), [png("ev-1")], { images: true, appsPanel: true });
    expect(r.panel).toBe(false);
    expect(r.panel_withheld).toBe(false);
    expect(r.content.some((b) => b.type === "resource")).toBe(false);
  });

  it("carries the multimedia downgrade flags through", () => {
    const r = buildDesignReviewContent(critique([finding()]), [png("ev-1")], { images: false, appsPanel: true }, PANEL);
    expect(r.panel).toBe(true); // panel supported
    expect(r.multimedia).toBe(false); // but images are not
    expect(r.images_withheld).toEqual(["ev-1"]);
  });

  it("is deterministic", () => {
    const build = () =>
      buildDesignReviewContent(critique([finding()]), [png("ev-1")], { images: true, appsPanel: true }, PANEL);
    expect(build()).toEqual(build());
  });
});
