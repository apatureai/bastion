import type { JobStatus } from "@apature/mcp-types";

/**
 * Cross-repo cancel-state mapping (#32). Judgment Engine owns cooperative
 * cancellation (#66): `DELETE /jobs/:id` accepts a cancel and the job passes
 * through a NON-terminal `cancelling` state before finalizing. Its current
 * PUBLIC poll contract surfaces the terminal internal `canceled` as
 * `{ state: "failed", error: "canceled" }`, so MCP Review must map that exact
 * shape rather than infer cancellation from transport timing (which would race
 * a late ordinary failure into a false `cancelled`).
 *
 * This mapping is the versioned contract; `test/fixtures/engine-cancel-mapping.golden.json`
 * pins every row, so a change to Judgment Engine's cancel surfacing (e.g. a
 * future typed terminal `canceled` state) breaks this test and forces an
 * explicit, reviewed remap instead of silent drift.
 */

/** Version of this mapping; bump when the engine's cancel contract changes. */
export const ENGINE_CANCEL_MAPPING_VERSION = "1";

/**
 * The sentinel error string Judgment Engine's public poll uses to disclose a
 * terminal internal `canceled` as a `failed` state. The ONLY `failed` that maps
 * to MCP `cancelled`; every other failure stays `failed`.
 */
export const ENGINE_CANCELED_ERROR = "canceled";

/** How Judgment Engine's public poll reports a job (the shape MCP Review reads). */
export interface EnginePollStatus {
  /** `cancelling` is non-terminal; `failed` carries `error` to disambiguate cancel. */
  state: "queued" | "running" | "cancelling" | "succeeded" | "failed";
  error?: string | null;
}

export interface MappedEngineStatus {
  /** The externally-visible MCP job status. */
  status: JobStatus;
  /**
   * Whether this is a terminal state. A running job whose cancel is in flight
   * (`cancelling`) is NON-terminal and stays externally `running`. MCP Review
   * never invents a `cancelling` job status, and never reports terminal
   * `cancelled` until the engine proves no late result can publish.
   */
  terminal: boolean;
}

/**
 * Map a Judgment Engine poll status to the MCP-visible job status. Pure and
 * total. The cancel-specific rows:
 *  - `cancelling`                     → `running`, non-terminal (cancel in flight);
 *  - `failed` + error `"canceled"`    → `cancelled`, terminal (cancel confirmed);
 *  - `failed` + any other/no error    → `failed`, terminal (ordinary failure,
 *                                        NEVER reported as a cancellation).
 */
export function mapEngineStatusToMcp(poll: EnginePollStatus): MappedEngineStatus {
  switch (poll.state) {
    case "queued":
      return { status: "queued", terminal: false };
    case "running":
      return { status: "running", terminal: false };
    case "cancelling":
      return { status: "running", terminal: false };
    case "succeeded":
      return { status: "completed", terminal: true };
    case "failed":
      return poll.error === ENGINE_CANCELED_ERROR
        ? { status: "cancelled", terminal: true }
        : { status: "failed", terminal: true };
  }
}

/** True for a job status that cancel must treat as a no-op (already terminal). */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
