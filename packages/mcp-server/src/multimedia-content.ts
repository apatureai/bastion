import type {
  AnnotatedImage,
  ContentBlockMeta,
  Critique,
  CritiqueFinding,
  DesignReviewContent,
  HostMediaCapability,
  ImageContentBlock,
  McpContentBlock,
  MultimediaCritiqueContent,
  ResourceContentBlock,
  TextContentBlock,
} from "@apatureai/bastion-types";
import { coverageLines } from "./coverage.js";

/**
 * Multimedia-native `design_review` result shaping (D3, issue #58). Apature is
 * inherently visual: a design-review tool that returns ANNOTATED SCREENSHOTS an
 * agent can see has no text-only code-review equivalent, and the 2026-07-28 MCP
 * spec makes image content a first-class citizen. This turns the agent-facing
 * `Critique` (+ the annotated crops the engine captured) into the ordered MCP
 * content blocks the tool returns.
 *
 * Two invariants make it honest rather than flashy:
 *   1. **Capability downgrade.** A host that cannot render images
 *      (`capability.images === false`) gets the SAME text/structured findings
 *      plus an explicit list of which images were withheld, never a broken or
 *      silently-dropped image block. The agent always knows what it is not seeing.
 *   2. **Only real image bytes become image blocks.** A finding's
 *      `evidence_id` yields an image block only when a matching `AnnotatedImage`
 *      with an `image/*` MIME type was actually supplied; otherwise the finding
 *      is text-only. We never fabricate an evidence block.
 *
 * Dependency-inverted and pure: the engine/capture plane produces the pixels and
 * passes them in as `AnnotatedImage[]`; this function only shapes content. No
 * I/O, deterministic.
 */

function isImageMime(mimeType: string): boolean {
  return /^image\/[a-z0-9.+-]+$/i.test(mimeType);
}

/**
 * The `_meta` key a content block carries when the finding it renders is one
 * nothing judged. Same word as `CritiqueFinding.unjudged` and as the `[unjudged]`
 * marker in the text, because a second vocabulary for one fact is how the two
 * surfaces end up disagreeing.
 */
export const UNJUDGED_BLOCK_META_KEY = "com.apature/unjudged";

/** The `_meta` key carrying the sentence a human reads for the same fact. */
export const UNJUDGED_DISCLOSURE_META_KEY = "com.apature/unjudged_disclosure";

/**
 * The one sentence every unjudged content block says, in the text where there
 * is text and in `_meta` on every marked block. Exported so the assertion that
 * an image and its text block say the same thing compares one constant rather
 * than two copies of a sentence.
 */
export const UNJUDGED_BLOCK_DISCLOSURE =
  "Nothing judged this page, so this is not an observation of the target.";

/**
 * The `_meta` for a block rendering one finding, or `undefined` when the finding
 * was judged.
 *
 * The `undefined` is the point: a judged block carries no `_meta` at all, so the
 * marker's absence asserts nothing on its own and `provenance` stays the only
 * authority. Identical for text and image blocks, from one function, because an
 * image block that could drift from the text block beside it is the defect this
 * closes.
 */
function unjudgedBlockMeta(f: CritiqueFinding): ContentBlockMeta | undefined {
  if (f.unjudged !== true) return undefined;
  return {
    [UNJUDGED_BLOCK_META_KEY]: true,
    [UNJUDGED_DISCLOSURE_META_KEY]: UNJUDGED_BLOCK_DISCLOSURE,
  };
}

/**
 * One finding rendered as agent-readable text (severity, where, and the fix).
 *
 * The `unjudged` marker is per item for the same reason it is per item on
 * `structuredContent.findings[]`: a client that renders `content[]` shows these
 * blocks one at a time, and at that scope confident, specific advice about a
 * page nothing looked at is indistinguishable from a real finding. The envelope
 * block says the review is unjudged; this block has to say it too, because
 * nothing guarantees the two are read together. It is the envelope's own word,
 * `unjudged`, not a second vocabulary, and it is emitted only on payloads that
 * carry the field, so its absence claims nothing on its own.
 *
 * The same fact also rides in `_meta` on this block and on the image block for
 * the same finding, so a host that renders content rather than reading prose
 * still has it, and so the two blocks cannot be separated from it.
 */
function findingText(f: CritiqueFinding): string {
  const where = f.element_ref ? `${f.route} (${f.viewport}, \`${f.element_ref}\`)` : `${f.route} (${f.viewport})`;
  const marker = f.unjudged === true ? "[unjudged] " : "";
  const fix = f.suggestion ? ` Fix: ${f.suggestion}` : "";
  const disclosure = f.unjudged === true ? ` ${UNJUDGED_BLOCK_DISCLOSURE}` : "";
  return `[${f.severity}] ${marker}${f.title} @ ${where}.${fix}${disclosure}`;
}

/**
 * Build the multimedia `design_review` content for a critique. Emits one text
 * block for the overall verdict, then per finding a text block and, when the
 * host supports images and an annotated crop was supplied for that finding, an
 * image block. For a non-multimedia host, image blocks are omitted and their
 * `evidence_id`s are reported in `images_withheld`. Deterministic; preserves
 * `critique.findings` order.
 */
export function buildMultimediaCritiqueContent(
  critique: Critique,
  images: readonly AnnotatedImage[],
  capability: HostMediaCapability,
): MultimediaCritiqueContent {
  const imageByEvidence = new Map<string, AnnotatedImage>();
  for (const img of images) {
    // Last-wins on duplicate ids; only admit real image MIME types.
    if (isImageMime(img.mimeType)) imageByEvidence.set(img.evidenceId, img);
  }

  const content: McpContentBlock[] = [
    { type: "text", text: `Design review (${critique.grade}): ${critique.overall}` },
    // What the run covered, on every path including "the engine did not say",
    // and what its grounding gate deleted. Rendered here as well as carried in
    // `structuredContent.coverage`, because a client that renders `content[]`
    // shows these blocks and never opens the structured payload: the surface an
    // agent actually reads must not be the quieter of the two.
    ...coverageLines(critique).map((text) => ({ type: "text" as const, text })),
  ];
  const imagesWithheld: string[] = [];
  let emittedImage = false;

  for (const f of critique.findings) {
    const meta = unjudgedBlockMeta(f);
    const text: TextContentBlock = { type: "text", text: findingText(f) };
    if (meta) text._meta = meta;
    content.push(text);

    const img = f.evidence_id === null ? undefined : imageByEvidence.get(f.evidence_id);
    if (img === undefined) continue;

    if (capability.images) {
      // An image block has no prose, so the disclosure its sibling text block
      // spells out in words rides in `_meta`. Without it a host that renders
      // pictures prominently could show an "annotated screenshot" for a page
      // nothing looked at, with the only disclosure in a block beside it that
      // nothing guarantees is read.
      const block: ImageContentBlock = { type: "image", data: img.data, mimeType: img.mimeType };
      if (meta) block._meta = meta;
      content.push(block);
      emittedImage = true;
    } else {
      // Honest downgrade: the crop exists but the host can't render it, so say so.
      imagesWithheld.push(img.evidenceId);
    }
  }

  if (critique.not_reviewed.length > 0) {
    content.push({ type: "text", text: `Not reviewed: ${critique.not_reviewed.join(", ")}` });
  }

  return { content, multimedia: emittedImage, images_withheld: imagesWithheld };
}

/** Stable in-host URI for a review's MCP-Apps panel resource. */
function panelUri(reviewId: string): string {
  return `ui://apature/design-review/${reviewId}`;
}

/**
 * The MIME type that marks an MCP-Apps interactive HTML panel (ext-apps spec,
 * 2026-01-26). It is NOT plain `text/html`: the `;profile=mcp-app` parameter is
 * how a host distinguishes a panel it should render in its sandboxed MCP-Apps
 * iframe (with `postMessage` bridge) from a generic HTML resource. Getting this
 * wrong silently downgrades the panel to inert markup.
 */
export const MCP_APP_PANEL_MIME = "text/html;profile=mcp-app";

/**
 * Build the full `design_review` content: the interactive MCP-Apps HTML panel
 * (when the host supports it) followed by the multimedia findings. The panel is
 * an annotated, in-host review surface rendered in the host's sandboxed iframe,
 * supplied by the caller as rendered HTML (dependency inversion: the renderer
 * lives outside this repo, so nothing here depends on it). Both
 * surfaces degrade honestly: a host that can't render an MCP-Apps panel gets the
 * text/image result with `panel_withheld: true` (never a broken resource block),
 * exactly as image blocks degrade for a non-multimedia host.
 *
 * Pass no `panelHtml` (or an empty string) to return the multimedia result with
 * no panel. Pure and deterministic; the panel block leads so the host renders the
 * interactive surface first, with the text/image blocks as the accessible fallback.
 */
export function buildDesignReviewContent(
  critique: Critique,
  images: readonly AnnotatedImage[],
  capability: HostMediaCapability,
  panelHtml?: string,
): DesignReviewContent {
  const media = buildMultimediaCritiqueContent(critique, images, capability);
  const content: McpContentBlock[] = [...media.content];

  let panel = false;
  let panelWithheld = false;
  if (panelHtml !== undefined && panelHtml.length > 0) {
    if (capability.appsPanel === true) {
      const block: ResourceContentBlock = {
        type: "resource",
        resource: { uri: panelUri(critique.review_id), mimeType: MCP_APP_PANEL_MIME, text: panelHtml },
      };
      content.unshift(block); // panel first; text/image blocks are the fallback
      panel = true;
    } else {
      panelWithheld = true; // honest downgrade: the panel exists, the host can't show it
    }
  }

  return {
    content,
    panel,
    panel_withheld: panelWithheld,
    multimedia: media.multimedia,
    images_withheld: media.images_withheld,
  };
}
