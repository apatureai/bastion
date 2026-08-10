import type { PanelAction, PanelFinding, PanelResponse } from "@apature/mcp-types";

/**
 * The pure reducer behind the interactive MCP-Apps review panel (idea #64). Given
 * a panel ACTION (a reviewer/agent clicked a finding or asked to recheck) and the
 * review's findings, it returns the RESPONSE the host sends back over the
 * postMessage bridge. It shapes work; it never performs it.
 *
 * Eyes-not-hands invariant, enforced here:
 *   - `apply_fix` on a grounded (`appliable`) finding returns its fix for the host
 *     to hand to the CODING AGENT; this module never edits code;
 *   - `apply_fix` on an advisory finding (or one with no fix) returns `human_only`,
 *     never an auto-fix, because advisory is model judgment that needs a person;
 *   - `recheck` returns the recheck refs (the graph cycle-back handle), scoped to
 *     one finding or the whole review; a resolution is a recheck verdict Apature
 *     earns, never a status the panel sets.
 *
 * Pure and deterministic; no I/O. The panel HTML/JS and the live host round-trip
 * are the MCP-Apps runtime, and this is the contract they exchange.
 */
export function handlePanelAction(action: PanelAction, findings: readonly PanelFinding[]): PanelResponse {
  if (action.type === "apply_fix") {
    const finding = findings.find((f) => f.finding_id === action.finding_id);
    if (finding === undefined) return { type: "unknown_finding", finding_id: action.finding_id };
    // Advisory judgment, or no auto-appliable fix → a human, not an auto-fix.
    if (!finding.appliable || finding.fix === null) {
      return { type: "human_only", finding_id: action.finding_id };
    }
    return { type: "fix", finding_id: action.finding_id, fix: finding.fix };
  }

  // recheck: gather the refs to re-verify: one finding's, or the whole review's.
  const scoped =
    action.finding_id === undefined
      ? findings
      : findings.filter((f) => f.finding_id === action.finding_id);
  if (action.finding_id !== undefined && scoped.length === 0) {
    return { type: "unknown_finding", finding_id: action.finding_id };
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const f of scoped) {
    for (const ref of f.recheck_refs ?? []) {
      if (!seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    }
  }
  return { type: "recheck", refs };
}
