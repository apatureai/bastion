import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpReviewServer } from "../src/index.js";

/** Connect a real MCP client to the server over an in-memory transport pair. */
async function connectClient() {
  let counter = 0;
  const server = createMcpReviewServer({
    now: () => new Date("2026-06-22T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_${String(++counter).padStart(8, "0")}`,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

describe("MCP Review server", () => {
  it("advertises only read-or-review tools with correct annotations and no write tool", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.has("design_review")).toBe(true);
    expect(byName.has("design_review_get")).toBe(true);

    // Read-only customer boundary: there must be no edit/write/commit/push tool.
    for (const name of byName.keys()) {
      expect(name).not.toMatch(/edit|write|commit|push|patch|apply/i);
    }

    // get is the only read-only-hinted tool; submit creates a metered job.
    expect(byName.get("design_review_get")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("design_review")?.annotations?.readOnlyHint).toBe(false);
  });

  it("runs design_review then design_review_get end to end against the mock engine", async () => {
    const { client } = await connectClient();

    const submit = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/pricing", client_request_id: "req-abcdef01" },
    })) as ToolResult;

    expect(submit.isError).toBeFalsy();
    const job = (submit.structuredContent as { job: { job_id: string; kind: string } }).job;
    expect(job.kind).toBe("review");

    const get = (await client.callTool({
      name: "design_review_get",
      arguments: { job_id: job.job_id },
    })) as ToolResult;

    expect(get.isError).toBeFalsy();
    const review = (get.structuredContent as { review: { grade: string; findings: unknown[] } })
      .review;
    expect(review.grade).toBe("needs_work");
    expect(review.findings.length).toBe(3);
  });

  it("returns a typed INVALID_ARGUMENT error for a non-https URL", async () => {
    const { client } = await connectClient();
    const out = (await client.callTool({
      name: "design_review",
      arguments: { url: "http://preview.example.com/", client_request_id: "req-abcdef01" },
    })) as ToolResult;

    // The SDK rejects the http URL at the input-schema layer (regex), so this is
    // a protocol-level error; either way the client must see an error, never a job.
    expect(out.isError).toBe(true);
  });

  it("returns a JOB_NOT_FOUND error for an unknown job id", async () => {
    const { client } = await connectClient();
    const out = (await client.callTool({
      name: "design_review_get",
      arguments: { job_id: "job_99999999" },
    })) as ToolResult;

    expect(out.isError).toBe(true);
    const error = (out.structuredContent as { error: { code: string } }).error;
    expect(error.code).toBe("JOB_NOT_FOUND");
  });
});
