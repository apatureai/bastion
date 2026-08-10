import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createLocalReviewServer, LOCAL_ALLOWED_HOST } from "../src/local-server.js";

/**
 * The offline composition root: the server a stranger runs with no credentials.
 * This is the same path `pnpm demo` drives, asserted end to end.
 *
 * Load-bearing: it exposes the WHOLE catalog (not a demo subset); the SSRF boundary
 * is still enforced (an unverified host is rejected exactly as in production, and
 * the fail-closed default is not weakened for convenience); the review loop
 * completes with fixture judgments; and the evidence view really produces image and
 * panel blocks so the multimedia surface is reachable without a capture service.
 */

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; resource?: { text?: string } }>;
  structuredContent?: Record<string, unknown>;
};

async function connect() {
  const server = createLocalReviewServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "local-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;

describe("createLocalReviewServer", () => {
  it("exposes the full five-tool catalog", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "design_recheck",
      "design_review",
      "design_review_cancel",
      "design_review_get",
      "design_review_panel_action",
    ]);
  });

  it("runs review -> evidence -> panel action -> recheck against fixture judgments", async () => {
    const client = await connect();

    const submit = await call(client, "design_review", {
      url: `https://${LOCAL_ALLOWED_HOST}/pricing`,
      routes: ["/pricing"],
      viewports: ["mobile", "desktop"],
      client_request_id: "local-e2e-0001",
    });
    expect(submit.isError).toBeFalsy();
    const jobId = (submit.structuredContent?.job as { job_id: string; status: string }).job_id;

    const summary = await call(client, "design_review_get", { job_id: jobId });
    const review = summary.structuredContent?.review as {
      review_id: string;
      grade: string;
      findings: Array<{ finding_id: string }>;
    };
    expect(review.grade).toBe("needs_work");
    expect(review.findings.map((f) => f.finding_id)).toEqual(["f_001", "f_002", "f_003"]);

    const evidence = await call(client, "design_review_get", { job_id: jobId, view: "evidence" });
    expect((evidence.content ?? []).filter((b) => b.type === "image")).toHaveLength(2);
    const panel = (evidence.content ?? []).find((b) => b.type === "resource")?.resource?.text ?? "";
    expect(panel).toContain("Primary CTA uses an off-brand color on mobile");
    expect(panel).toContain("data:image/png;base64,");
    expect(evidence.structuredContent?.presentation).toMatchObject({ panel: true, multimedia: true });

    const applied = await call(client, "design_review_panel_action", {
      job_id: jobId,
      action: "apply_fix",
      finding_id: "f_001",
    });
    expect((applied.structuredContent?.response as { type: string }).type).toBe("fix");

    const recheck = await call(client, "design_recheck", {
      review_id: review.review_id,
      finding_ids: review.findings.map((f) => f.finding_id),
      expected_revision: "deploy-2",
      client_request_id: "local-e2e-0002",
    });
    const outcomes = (recheck.structuredContent?.recheck as { outcomes: Array<{ outcome: string }> })
      .outcomes;
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => ["passed", "failed", "inconclusive"].includes(o.outcome))).toBe(true);
  });

  it("still enforces the SSRF boundary: an unverified host is rejected", async () => {
    const client = await connect();
    const denied = await call(client, "design_review", {
      url: "https://evil.example.org/",
      client_request_id: "local-ssrf-0001",
    });
    expect(denied.isError).toBe(true);
    expect((denied.structuredContent as { error: { code: string } }).error.code).toBe(
      "DOMAIN_UNVERIFIED",
    );
  });

  it("holds the cancel scope, so cancelling a completed job is an idempotent no-op", async () => {
    const client = await connect();
    const submit = await call(client, "design_review", {
      url: `https://${LOCAL_ALLOWED_HOST}/`,
      client_request_id: "local-cancel-0001",
    });
    const jobId = (submit.structuredContent?.job as { job_id: string }).job_id;
    const cancelled = await call(client, "design_review_cancel", { job_id: jobId });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.structuredContent).toMatchObject({
      status: "completed",
      upstream_cancellation: "already_terminal",
    });
  });
});
