/**
 * Interactive MCP-Apps review panel contract (idea #64). The design-review panel
 * (#58/#60) renders in the host's sandboxed iframe and talks back to the host over
 * MCP-Apps' JSON-RPC-`postMessage` bridge. These are the messages that bridge
 * carries: the ACTIONS the panel emits (a reviewer/agent interacting with a
 * finding) and the RESPONSES the host returns.
 *
 * The load-bearing invariant is **eyes-not-hands**: the panel can REQUEST that a
 * finding's grounded fix be handed to the coding agent, but it never edits. And a
 * finding whose fix is model JUDGMENT (advisory), not a rule-cited grounded fix,
 * can never be auto-applied; the response is `human_only`. So the panel routes
 * work (grounded → agent, advisory → human) exactly like `routeGateNode`; it does
 * not perform it.
 */

/** One finding as the interactive panel needs it, supplied by the review side. */
export type PanelFinding = {
  finding_id: string;
  /**
   * The agent-appliable fix (a rule-cited grounded fix), or null when the finding
   * is advisory model judgment with no auto-appliable fix.
   */
  fix: string | null;
  /**
   * True when the fix is grounded and may be handed to the coding agent; false for
   * advisory findings that require human sign-off. (grounded → agent, advisory → human.)
   */
  appliable: boolean;
  /** Refs to re-verify after a fix (the gate node's recheck handle), if any. */
  recheck_refs?: string[];
};

/** An action the panel emits to the host over the postMessage bridge. */
export type PanelAction =
  /** The reviewer/agent asks to apply a finding's grounded fix. */
  | { type: "apply_fix"; finding_id: string }
  /** Re-run the review to confirm fixes, optionally scoped to one finding. */
  | { type: "recheck"; finding_id?: string };

/** The host's response to a `PanelAction`. */
export type PanelResponse =
  /** The finding's grounded fix, to be handed to the coding agent (not applied here). */
  | { type: "fix"; finding_id: string; fix: string }
  /** The finding is advisory (model judgment): it needs a human, not an auto-fix. */
  | { type: "human_only"; finding_id: string }
  /**
   * Nothing judged the review this finding came from, so there is no fix to
   * hand over and no advisory judgment to refer to a human either. A `fix`
   * string derived from a fixture is fiction, and handing fiction to a coding
   * agent is the one thing this surface exists to prevent. Same vocabulary as
   * the `unjudged` grade and the `unjudged` recheck outcome, set under the same
   * condition: `provenance.model_backed === false`.
   */
  | { type: "unjudged"; finding_id: string }
  /** The recheck refs to re-verify (drives the graph cycle-back). */
  | { type: "recheck"; refs: string[] }
  /** The action referenced a finding not in this review. */
  | { type: "unknown_finding"; finding_id: string };
