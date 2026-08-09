import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { HostMediaCapability } from "@apature/mcp-types";
import { createMcpReviewServer, type McpReviewServerDeps } from "../src/index.js";
import { MCP_APP_PANEL_MIME } from "../src/multimedia-content.js";
import { SyntheticEvidenceProvider } from "../src/synthetic-evidence.js";

/**
 * `design_review_get`'s `view` parameter, and the multimedia/panel surfaces it
 * reaches. Before this, `view` was accepted and ignored and the content shaping in
 * multimedia-content.ts had no live call site.
 *
 * Load-bearing: `status` never carries a result body (a polling loop stays cheap);
 * `focus` drops nits; `evidence` returns MCP content blocks; and the capability
 * downgrade a host sees is honest — a host that cannot render images or an MCP-Apps
 * panel is TOLD what was withheld rather than being handed a broken block.
 */

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; resource?: { mimeType?: string; text?: string } }>;
  structuredContent?: Record<string, unknown>;
};

async function connect(over: Partial<McpReviewServerDeps> = {}) {
  const server = createMcpReviewServer({
    allowlist: { tenantId: "tenant-test", targets: [{ kind: "host", host: "preview.example.com" }] },
    resolver: { resolve: async () => ["93.184.216.34"] },
    evidence: new SyntheticEvidenceProvider(),
    ...over,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "views-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

let requestSeq = 0;
async function completedJob(client: Client): Promise<string> {
  const submit = (await client.callTool({
    name: "design_review",
    arguments: {
      url: "https://preview.example.com/pricing",
      client_request_id: `views-${String(++requestSeq).padStart(6, "0")}`,
    },
  })) as ToolResult;
  return (submit.structuredContent?.job as { job_id: string }).job_id;
}

const get = async (client: Client, jobId: string, view?: string): Promise<ToolResult> =>
  (await client.callTool({
    name: "design_review_get",
    arguments: { job_id: jobId, ...(view ? { view } : {}) },
  })) as ToolResult;

describe("design_review_get views", () => {
  it("status returns the job with no result body", async () => {
    const client = await connect();
    const result = await get(client, await completedJob(client), "status");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.job).toMatchObject({ status: "completed" });
    expect(result.structuredContent).not.toHaveProperty("review");
  });

  it("summary is the default and returns the full critique", async () => {
    const client = await connect();
    const jobId = await completedJob(client);
    const explicit = await get(client, jobId, "summary");
    const implicit = await get(client, jobId);
    expect(implicit.structuredContent).toEqual(explicit.structuredContent);
    const review = explicit.structuredContent?.review as { findings: unknown[]; grade: string };
    expect(review.grade).toBe("needs_work");
    expect(review.findings).toHaveLength(3);
  });

  it("focus drops nits and keeps the actionable findings", async () => {
    const client = await connect();
    const result = await get(client, await completedJob(client), "focus");
    const review = result.structuredContent?.review as {
      findings: Array<{ severity: string }>;
      not_reviewed: string[];
    };
    expect(review.findings.map((f) => f.severity)).toEqual(["should_fix", "should_fix"]);
    expect(review.not_reviewed.length).toBeGreaterThan(0);
  });

  it("evidence returns panel + text + image content blocks for a capable host", async () => {
    const client = await connect({ hostMedia: { images: true, appsPanel: true } });
    const result = await get(client, await completedJob(client), "evidence");
    expect(result.isError).toBeFalsy();

    const blocks = result.content ?? [];
    expect(blocks[0]?.type).toBe("resource");
    expect(blocks[0]?.resource?.mimeType).toBe(MCP_APP_PANEL_MIME);
    expect(blocks[0]?.resource?.text).toContain("Design review");
    // The golden fixture carries a crop for two of its three findings.
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(result.structuredContent?.presentation).toEqual({
      panel: true,
      panel_withheld: false,
      multimedia: true,
      images_withheld: [],
    });
  });

  it("a text-only host is told what was withheld instead of being sent a broken block", async () => {
    const hostMedia: HostMediaCapability = { images: false, appsPanel: false };
    const client = await connect({ hostMedia });
    const result = await get(client, await completedJob(client), "evidence");

    expect((result.content ?? []).some((b) => b.type === "image")).toBe(false);
    expect((result.content ?? []).some((b) => b.type === "resource")).toBe(false);
    expect(result.structuredContent?.presentation).toEqual({
      panel: false,
      panel_withheld: true,
      multimedia: false,
      images_withheld: ["shot_001", "shot_002"],
    });
    // The findings themselves are never withheld.
    expect((result.structuredContent?.review as { findings: unknown[] }).findings).toHaveLength(3);
  });

  it("with no evidence provider the evidence view degrades to panel + text", async () => {
    const client = await connect({ evidence: undefined, hostMedia: { images: true, appsPanel: true } });
    const result = await get(client, await completedJob(client), "evidence");
    expect((result.content ?? []).some((b) => b.type === "image")).toBe(false);
    expect(result.structuredContent?.presentation).toMatchObject({
      panel: true,
      multimedia: false,
      images_withheld: [],
    });
  });
});
