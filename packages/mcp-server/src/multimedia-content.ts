import type {
  AnnotatedImage,
  Critique,
  CritiqueFinding,
  HostMediaCapability,
  McpContentBlock,
  MultimediaCritiqueContent,
} from "@apature/mcp-types";

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
 *      plus an explicit list of which images were withheld — never a broken or
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

/** One finding rendered as agent-readable text (severity, where, and the fix). */
function findingText(f: CritiqueFinding): string {
  const where = f.element_ref ? `${f.route} (${f.viewport}, \`${f.element_ref}\`)` : `${f.route} (${f.viewport})`;
  const fix = f.suggestion ? ` — ${f.suggestion}` : "";
  return `[${f.severity}] ${f.title} @ ${where}${fix}`;
}

/**
 * Build the multimedia `design_review` content for a critique. Emits one text
 * block for the overall verdict, then per finding a text block and — when the
 * host supports images and an annotated crop was supplied for that finding — an
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
    { type: "text", text: `Design review — ${critique.grade}: ${critique.overall}` },
  ];
  const imagesWithheld: string[] = [];
  let emittedImage = false;

  for (const f of critique.findings) {
    content.push({ type: "text", text: findingText(f) });

    const img = f.evidence_id === null ? undefined : imageByEvidence.get(f.evidence_id);
    if (img === undefined) continue;

    if (capability.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      emittedImage = true;
    } else {
      // Honest downgrade: the crop exists but the host can't render it — say so.
      imagesWithheld.push(img.evidenceId);
    }
  }

  if (critique.not_reviewed.length > 0) {
    content.push({ type: "text", text: `Not reviewed: ${critique.not_reviewed.join(", ")}` });
  }

  return { content, multimedia: emittedImage, images_withheld: imagesWithheld };
}
