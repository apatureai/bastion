import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENGINE_CANCEL_MAPPING_VERSION,
  ENGINE_CANCELED_ERROR,
  isTerminalStatus,
  mapEngineStatusToMcp,
  type EnginePollStatus,
} from "../src/engine-cancel.js";

/**
 * Cross-repo cancel-state mapping (#32) against the pinned golden. Any change
 * to Judgment Engine's public cancel surfacing must update the golden AND the
 * mapping together, or this test fails — which is the whole point of pinning a
 * contract instead of inferring cancellation from transport timing.
 */
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/engine-cancel-mapping.golden.json", import.meta.url)), "utf8"),
) as {
  mappingVersion: string;
  canceledErrorSentinel: string;
  rows: Array<{ engine: EnginePollStatus; mcp: { status: string; terminal: boolean } }>;
};

describe("engine cancel-state mapping (#32 cross-repo golden)", () => {
  it("pins the mapping version and the canceled sentinel to the code", () => {
    expect(golden.mappingVersion).toBe(ENGINE_CANCEL_MAPPING_VERSION);
    expect(golden.canceledErrorSentinel).toBe(ENGINE_CANCELED_ERROR);
  });

  it.each(golden.rows.map((r) => [JSON.stringify(r.engine), r] as const))(
    "maps engine %s to the golden MCP status",
    (_label, row) => {
      expect(mapEngineStatusToMcp(row.engine)).toEqual(row.mcp);
    },
  );

  it("only the canceled sentinel makes a failed job map to cancelled", () => {
    expect(mapEngineStatusToMcp({ state: "failed", error: ENGINE_CANCELED_ERROR }).status).toBe("cancelled");
    // Any other failure — including a lookalike — stays failed, never cancelled.
    for (const error of ["capture_timeout", "model_error", "CANCELED", "cancelled", null, undefined]) {
      expect(mapEngineStatusToMcp({ state: "failed", error }).status).toBe("failed");
    }
  });

  it("treats an in-flight cancel (cancelling) as non-terminal running", () => {
    expect(mapEngineStatusToMcp({ state: "cancelling" })).toEqual({ status: "running", terminal: false });
  });

  it("classifies terminal statuses", () => {
    expect((["completed", "failed", "cancelled"] as const).every(isTerminalStatus)).toBe(true);
    expect((["queued", "running"] as const).some(isTerminalStatus)).toBe(false);
  });
});
