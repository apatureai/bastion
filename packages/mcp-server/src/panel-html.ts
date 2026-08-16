import type { AnnotatedImage, Critique, CritiqueFinding, PanelFinding } from "@apature/mcp-types";
import { coverageLines } from "./coverage.js";

/**
 * Renderer for the interactive MCP-Apps review panel's HTML.
 *
 * `buildDesignReviewContent` takes the panel markup as a caller-supplied string:
 * dependency inversion, because the original renderer lived outside this repo. That
 * left the panel branch unreachable from any live tool. This is a renderer for it:
 * a self-contained, offline HTML document (no scripts, no external stylesheets, no
 * remote URLs) that presents the same worklist the reducer acts on.
 *
 * Two properties matter more than the styling:
 *   1. **Everything is escaped.** Findings quote a page the customer's users, or
 *      an attacker, control. Page-derived text is data, never markup and never
 *      instruction; every interpolation goes through `escapeHtml`, and evidence is
 *      embedded as a `data:` URI so the panel never fetches anything.
 *   2. **The panel shows the routing, it does not perform it.** Each finding is
 *      labelled `agent-appliable` or `needs a human`, matching exactly what
 *      `handlePanelAction` will return for it. There is no fix button that edits:
 *      acting on a finding is a `design_review_panel_action` tool call the host
 *      makes, and even then the response is a fix handed to the coding agent.
 *
 * The document renders identically in a host's sandboxed MCP-Apps iframe and in a
 * plain browser, which is what makes it inspectable offline. Pure and deterministic.
 */

/** Escape text for interpolation into HTML element content or an attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SEVERITY_COLOR: Record<CritiqueFinding["severity"], string> = {
  blocker: "#b3261e",
  should_fix: "#8a5300",
  nit: "#4a5568",
};

function findingSection(
  finding: CritiqueFinding,
  panel: PanelFinding | undefined,
  image: AnnotatedImage | undefined,
): string {
  const appliable = panel?.appliable === true;
  const routing = appliable
    ? `<span class="tag tag-agent">agent-appliable</span>`
    : `<span class="tag tag-human">needs a human</span>`;
  // Per item, like the structured finding and its text block: a reader scrolling
  // the panel takes in one card at a time and never re-reads the header.
  const unjudged =
    finding.unjudged === true ? ` <span class="tag tag-unjudged">unjudged</span>` : "";
  const suggestion = finding.suggestion
    ? `<p class="fix"><strong>Suggested fix:</strong> ${escapeHtml(finding.suggestion)}</p>`
    : `<p class="fix"><strong>Suggested fix:</strong> none: advisory judgment.</p>`;
  const element = finding.element_ref
    ? `<code>${escapeHtml(finding.element_ref)}</code>`
    : `<span class="muted">not localizable</span>`;
  const evidence = image
    ? `<img class="evidence" alt="Evidence crop for ${escapeHtml(finding.finding_id)}" src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}">`
    : `<p class="muted">No evidence crop for this finding.</p>`;

  return `      <section class="finding">
        <h3>
          <span class="sev" style="color:${SEVERITY_COLOR[finding.severity]}">${escapeHtml(finding.severity)}</span>
          ${escapeHtml(finding.title)} ${routing}${unjudged}
        </h3>
        <p class="where">${escapeHtml(finding.route)} &middot; ${escapeHtml(finding.viewport)} &middot; ${element}</p>
        <p>${escapeHtml(finding.description)}</p>
        ${suggestion}
        ${evidence}
        <p class="muted">finding_id <code>${escapeHtml(finding.finding_id)}</code></p>
      </section>`;
}

/**
 * Render a completed review as the MCP-Apps panel document.
 *
 * `panelFindings` is the reducer's own worklist (from `buildPanelFindings`), so the
 * agent-appliable / needs-a-human label on screen is the same decision
 * `handlePanelAction` makes, so the panel cannot claim a fix the reducer would refuse.
 * `images` are matched to findings by `evidence_id`; a finding with no image renders
 * text-only.
 */
export function renderReviewPanel(
  critique: Critique,
  panelFindings: readonly PanelFinding[],
  images: readonly AnnotatedImage[] = [],
): string {
  const panelById = new Map(panelFindings.map((p) => [p.finding_id, p]));
  const imageById = new Map(images.map((i) => [i.evidenceId, i]));
  const sections = critique.findings
    .map((f) =>
      findingSection(
        f,
        panelById.get(f.finding_id),
        f.evidence_id === null ? undefined : imageById.get(f.evidence_id),
      ),
    )
    .join("\n");
  const notReviewed =
    critique.not_reviewed.length > 0
      ? `      <section class="not-reviewed"><h3>Not reviewed</h3><ul>${critique.not_reviewed
          .map((n) => `<li>${escapeHtml(n)}</li>`)
          .join("")}</ul></section>`
      : "";
  const confidence = critique.confidence === null ? "unavailable" : critique.confidence.toFixed(2);
  // What the run covered and what its grounding gate deleted, in the same words
  // the structured payload and the MCP content blocks use. Rendered on every
  // path, so the panel a human looks at is never the quieter surface.
  const coverage = coverageLines(critique)
    .map((line) => `<p class="muted">${escapeHtml(line)}</p>`)
    .join("\n      ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Design review ${escapeHtml(critique.review_id)}</title>
    <style>
      body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; color: #1a1a1a; background: #fff; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h3 { font-size: 15px; margin: 0 0 6px; font-weight: 600; }
      .grade { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #eef1f5; font-weight: 600; }
      .finding { border: 1px solid #e2e6ec; border-radius: 8px; padding: 14px 16px; margin: 14px 0; }
      .sev { text-transform: uppercase; font-size: 11px; letter-spacing: .04em; margin-right: 6px; }
      .tag { font-size: 11px; padding: 1px 6px; border-radius: 10px; margin-left: 6px; white-space: nowrap; }
      .tag-agent { background: #e6f4ea; color: #14532d; }
      .tag-human { background: #fdeceb; color: #7f1d1d; }
      .tag-unjudged { background: #fff4d6; color: #6b4b00; }
      .where, .muted { color: #5c6773; font-size: 13px; }
      .fix { background: #f7f9fc; border-left: 3px solid #c7d2e0; padding: 8px 12px; }
      .evidence { display: block; max-width: 100%; border-radius: 6px; margin: 10px 0; }
      code { background: #f2f4f7; padding: 1px 4px; border-radius: 3px; font-size: 13px; }
      footer { color: #5c6773; font-size: 12px; border-top: 1px solid #e2e6ec; margin-top: 20px; padding-top: 12px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Design review <span class="grade">${escapeHtml(critique.grade)}</span></h1>
      <p class="where">review ${escapeHtml(critique.review_id)} &middot; confidence ${escapeHtml(confidence)} &middot; ${critique.findings.length} finding(s)</p>
      <p>${escapeHtml(critique.overall)}</p>
      ${coverage}
    </header>
${sections}
${notReviewed}
    <footer>
      Apature never edits code. &ldquo;Agent-appliable&rdquo; means the fix can be handed to your
      coding agent; &ldquo;needs a human&rdquo; means the judgment has no mechanically appliable fix.
      Acting on a finding is a <code>design_review_panel_action</code> call by the host.
    </footer>
  </body>
</html>
`;
}
