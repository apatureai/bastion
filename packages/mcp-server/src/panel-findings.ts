/**
 * Panel findings producer (idea #64) — the review-side half of the interactive
 * MCP-Apps panel contract. `PanelFinding` is documented as "supplied by the review
 * side", and `handlePanelAction` consumes it, but nothing built it: the panel had
 * to be fed by hand. This is that producer — it projects a review's fix plan into
 * the `PanelFinding[]` the panel renders and the reducer acts on.
 *
 * It is dependency-inverted: the input is a STRUCTURAL `ReviewFixItem` (the shape
 * of the combined review's fix-plan item — pointer's axis-tagged `AxisFixItem`),
 * declared here so mcp-review imports nothing from the review engine. The
 * eyes-not-hands split is preserved by construction: a grounded item carries its
 * instruction as the appliable `fix`; an advisory item gets `fix: null` +
 * `appliable: false`, so the reducer can only ever route it to a human.
 *
 * The cited anchor (`ref`) is the finding identity and the per-finding recheck
 * handle — after a fix at `ref`, the panel re-verifies `ref`. When the item is
 * cross-axis (`axis` set), the id is namespaced `axis:ref` so two axes citing the
 * same anchor stay distinct. Pure and deterministic.
 */

import type { PanelFinding } from "@apature/mcp-types";

/**
 * A review-side fix item the panel is built from — structurally the combined
 * review's fix-plan item (pointer's `CombinedFixItem`: an axis-tagged
 * `AxisFixItem`). Declared HERE, not imported, so mcp-review stays dependency-free
 * of the review engine (structural typing / dependency inversion).
 */
export interface ReviewFixItem {
  /** The cited anchor (token / element / frame ref) — the finding identity. */
  ref: string;
  /** The agent-actionable fix instruction. */
  instruction: string;
  /** Grounded (agent-appliable) vs advisory (human sign-off). */
  grounded: boolean;
  /** The axis that produced it, when cross-axis — namespaces the finding id. */
  axis?: string;
}

/**
 * Project one review fix item into a `PanelFinding`. A grounded item's instruction
 * becomes the appliable `fix`; an advisory item gets `fix: null` + `appliable:
 * false` (routed to a human, never auto-applied). The `ref` is the recheck handle.
 */
export function toPanelFinding(item: ReviewFixItem): PanelFinding {
  return {
    finding_id: item.axis ? `${item.axis}:${item.ref}` : item.ref,
    fix: item.grounded ? item.instruction : null,
    appliable: item.grounded,
    recheck_refs: [item.ref],
  };
}

/**
 * Build the panel's findings from a review fix plan's items (grounded then
 * advisory, as the fix plan already orders them). Preserves input order so the
 * panel gets a stable, blockers-first worklist. Pure and deterministic.
 */
export function buildPanelFindings(items: readonly ReviewFixItem[]): PanelFinding[] {
  return items.map(toPanelFinding);
}
