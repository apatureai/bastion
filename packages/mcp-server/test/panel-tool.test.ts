import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import { createMcpReviewServer } from "../src/index.js";
import type { EngineClient, EngineRecheckRequest } from "../src/engine-client.js";
import type { NormalizedReviewRequest } from "../src/normalize.js";
import { stampProvenance, verdictCliProvenance } from "../src/provenance.js";

/**
 * `design_review_panel_action`: the live call site for the panel producer and the
 * pure reducer. The panel rendered into the evidence view is inert markup; this is
 * the tool the host calls when a reviewer acts on a finding.
 *
 * Load-bearing (the product boundary): apply_fix RETURNS a fix for the coding agent
 * and never edits; a finding the projection judged advisory can only come back
 * human_only; a review NOTHING judged comes back unjudged with no fix string at
 * all, because a fixture-derived instruction handed to a coding agent is the
 * failure this surface exists to prevent; recheck returns refs that are valid
 * design_recheck arguments; and the tool is metered-free and readOnly, because it
 * creates no job.
 */

/** A backend standing in for a real, live, model-backed verdict run. */
class LiveModelEngine implements EngineClient {
  async review(_request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    const result = loadGoldenEngineResult();
    return stampProvenance(result, verdictCliProvenance("live", result));
  }
  async recheck(_request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    throw new Error("not used");
  }
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

async function connect(engine?: EngineClient) {
  const server = createMcpReviewServer({
    allowlist: { tenantId: "tenant-test", targets: [{ kind: "host", host: "preview.example.com" }] },
    resolver: { resolve: async () => ["93.184.216.34"] },
    ...(engine ? { engine } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "panel-tool-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

let requestSeq = 0;
async function completedJob(client: Client): Promise<string> {
  const submit = (await client.callTool({
    name: "design_review",
    arguments: {
      url: "https://preview.example.com/pricing",
      client_request_id: `panel-${String(++requestSeq).padStart(6, "0")}`,
    },
  })) as ToolResult;
  return (submit.structuredContent?.job as { job_id: string }).job_id;
}

const act = async (
  client: Client,
  args: Record<string, unknown>,
): Promise<ToolResult> =>
  (await client.callTool({ name: "design_review_panel_action", arguments: args })) as ToolResult;

describe("design_review_panel_action", () => {
  it("is advertised as a read-only, unmetered tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "design_review_panel_action");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?._meta?.["com.apature/metered"]).toBe(false);
  });

  it("apply_fix returns a grounded finding's fix for the coding agent to apply", async () => {
    const client = await connect(new LiveModelEngine());
    const jobId = await completedJob(client);
    const result = await act(client, { job_id: jobId, action: "apply_fix", finding_id: "f_001" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.response).toEqual({
      type: "fix",
      finding_id: "f_001",
      fix: "Apply the `--color-accent` token (or the `btn-primary` class) so the CTA matches the brand accent used elsewhere.",
    });
    expect(result.structuredContent?.job_id).toBe(jobId);
    expect(String(result.structuredContent?.review_id)).toMatch(/^rev_/);
    // The routed fix is a string the caller acts on, so the payload says where
    // the judgment behind it came from without a second call.
    expect(result.structuredContent?.provenance).toMatchObject({
      model_backed: true,
      source: "model",
    });
  });

  it("apply_fix on a review nothing judged returns unjudged and no fix string", async () => {
    // Default server = fixture engine. The suggestion on f_001 is invented, so
    // the one thing this tool must never do is hand it to a coding agent.
    const client = await connect();
    const jobId = await completedJob(client);
    const result = await act(client, { job_id: jobId, action: "apply_fix", finding_id: "f_001" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.response).toEqual({ type: "unjudged", finding_id: "f_001" });
    expect(result.structuredContent?.provenance).toMatchObject({
      model_backed: false,
      source: "fixture",
      engine: "bastion-fixture",
    });
    // Decidable from the serialized payload alone, which is all an agent has.
    expect(JSON.stringify(result.structuredContent)).not.toContain("--color-accent");
  });

  it("recheck returns every finding's ref, and one finding's ref when scoped", async () => {
    const client = await connect();
    const jobId = await completedJob(client);

    const all = await act(client, { job_id: jobId, action: "recheck" });
    expect(all.structuredContent?.response).toEqual({
      type: "recheck",
      refs: ["f_001", "f_002", "f_003"],
    });

    const scoped = await act(client, { job_id: jobId, action: "recheck", finding_id: "f_002" });
    expect(scoped.structuredContent?.response).toEqual({ type: "recheck", refs: ["f_002"] });
  });

  it("the refs it returns are accepted by design_recheck", async () => {
    const client = await connect();
    const jobId = await completedJob(client);
    const summary = (await client.callTool({
      name: "design_review_get",
      arguments: { job_id: jobId },
    })) as ToolResult;
    const reviewId = (summary.structuredContent?.review as { review_id: string }).review_id;
    const refs = (
      (await act(client, { job_id: jobId, action: "recheck" })).structuredContent?.response as {
        refs: string[];
      }
    ).refs;

    const recheck = (await client.callTool({
      name: "design_recheck",
      arguments: {
        review_id: reviewId,
        finding_ids: refs,
        expected_revision: "deploy-2",
        client_request_id: "panel-refs-0001",
      },
    })) as ToolResult;
    expect(recheck.isError).toBeFalsy();
    expect((recheck.structuredContent?.recheck as { outcomes: unknown[] }).outcomes).toHaveLength(
      refs.length,
    );
  });

  it("apply_fix without a finding_id is INVALID_ARGUMENT", async () => {
    const client = await connect();
    const result = await act(client, { job_id: await completedJob(client), action: "apply_fix" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("an unknown finding is FINDING_NOT_FOUND, an unknown job is JOB_NOT_FOUND", async () => {
    const client = await connect();
    const unknownFinding = await act(client, {
      job_id: await completedJob(client),
      action: "apply_fix",
      finding_id: "f_999",
    });
    expect(unknownFinding.isError).toBe(true);
    expect((unknownFinding.structuredContent as { error: { code: string } }).error.code).toBe(
      "FINDING_NOT_FOUND",
    );

    const unknownJob = await act(client, {
      job_id: "job_does_not_exist_0001",
      action: "recheck",
    });
    expect(unknownJob.isError).toBe(true);
    expect((unknownJob.structuredContent as { error: { code: string } }).error.code).toBe(
      "JOB_NOT_FOUND",
    );
  });
});
