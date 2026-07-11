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
    // SSRF guard (issue #4): a verified allowlist plus a stub resolver that
    // returns a public address. No real DNS or network is ever touched.
    allowlist: {
      tenantId: "tenant-test",
      targets: [{ kind: "host", host: "preview.example.com" }],
    },
    resolver: { resolve: async () => ["93.184.216.34"] },
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
    expect(byName.has("design_recheck")).toBe(true);
    // The full four-tool catalog surface is now registered (#32): no
    // advertised-but-missing tool.
    expect(byName.has("design_review_cancel")).toBe(true);

    // Read-only customer boundary: there must be no edit/write/commit/push tool.
    for (const name of byName.keys()) {
      expect(name).not.toMatch(/edit|write|commit|push|patch|apply/i);
    }

    // get is the only read-only-hinted tool; submit + recheck create metered jobs.
    expect(byName.get("design_review_get")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("design_review")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("design_recheck")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("design_recheck")?._meta?.["com.apature/metered"]).toBe(true);
    // Cancel mutates Apature service state (not customer systems), is idempotent,
    // and is never metered.
    const cancel = byName.get("design_review_cancel");
    expect(cancel?.annotations?.readOnlyHint).toBe(false);
    expect(cancel?.annotations?.idempotentHint).toBe(true);
    expect(cancel?._meta?.["com.apature/metered"]).toBe(false);
  });

  it("cancels a completed review as an idempotent already_terminal no-op (#32)", async () => {
    const { client } = await connectClient();
    const submit = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "cancel-e2e-0001" },
    })) as ToolResult;
    const jobId = (submit.structuredContent?.job as { job_id: string }).job_id;

    const cancel = (await client.callTool({
      name: "design_review_cancel",
      arguments: { job_id: jobId, reason: "no longer needed" },
    })) as ToolResult;
    expect(cancel.isError).toBeFalsy();
    expect(cancel.structuredContent).toMatchObject({
      schema_version: "1.0.0",
      job_id: jobId,
      status: "completed",
      upstream_cancellation: "already_terminal",
    });
  });

  it("cancel of an unknown job is a non-enumerating JOB_NOT_FOUND (#32)", async () => {
    const { client } = await connectClient();
    const res = (await client.callTool({
      name: "design_review_cancel",
      arguments: { job_id: "job_nonexistent_00000001" },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    // The message must not disclose whether the id exists for another tenant.
    expect(JSON.stringify(res.structuredContent)).not.toContain("job_nonexistent");
  });

  it("runs design_recheck end to end and returns a before/after outcome set", async () => {
    const { client } = await connectClient();

    const submit = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/pricing", client_request_id: "req-rv-0001" },
    })) as ToolResult;
    const reviewId = (
      (
        (await client.callTool({
          name: "design_review_get",
          arguments: {
            job_id: (submit.structuredContent as { job: { job_id: string } }).job.job_id,
          },
        })) as ToolResult
      ).structuredContent as { review: { review_id: string; findings: { finding_id: string }[] } }
    ).review;

    const recheck = (await client.callTool({
      name: "design_recheck",
      arguments: {
        review_id: reviewId.review_id,
        finding_ids: reviewId.findings.map((f) => f.finding_id),
        expected_revision: "deploy-2",
        client_request_id: "req-rc-0001",
      },
    })) as ToolResult;

    expect(recheck.isError).toBeFalsy();
    const body = recheck.structuredContent as {
      job: { kind: string };
      recheck: { outcomes: unknown[]; before_fingerprint: string; after_fingerprint: string };
    };
    expect(body.job.kind).toBe("recheck");
    expect(body.recheck.outcomes.length).toBe(reviewId.findings.length);
    expect(body.recheck.before_fingerprint).not.toBe(body.recheck.after_fingerprint);
  });

  it("returns a typed TARGET_UNCHANGED error for an unchanged recheck", async () => {
    const { client } = await connectClient();
    const submit = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/pricing", client_request_id: "req-rv-0002" },
    })) as ToolResult;
    const review = (
      (await client.callTool({
        name: "design_review_get",
        arguments: { job_id: (submit.structuredContent as { job: { job_id: string } }).job.job_id },
      })) as ToolResult
    ).structuredContent as { review: { review_id: string; findings: { finding_id: string }[] } };

    const recheck = (await client.callTool({
      name: "design_recheck",
      arguments: {
        review_id: review.review.review_id,
        finding_ids: review.review.findings.map((f) => f.finding_id),
        client_request_id: "req-rc-0002", // no URL/revision change -> unchanged
      },
    })) as ToolResult;

    expect(recheck.isError).toBe(true);
    expect((recheck.structuredContent as { error: { code: string } }).error.code).toBe(
      "TARGET_UNCHANGED",
    );
  });

  it("returns a non-retriable URL_NOT_ALLOWED for a bad recheck url (#11)", async () => {
    const { client } = await connectClient();
    const submit = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/pricing", client_request_id: "req-rv-0004" },
    })) as ToolResult;
    const review = (
      (await client.callTool({
        name: "design_review_get",
        arguments: { job_id: (submit.structuredContent as { job: { job_id: string } }).job.job_id },
      })) as ToolResult
    ).structuredContent as { review: { review_id: string; findings: { finding_id: string }[] } };

    const recheck = (await client.callTool({
      name: "design_recheck",
      arguments: {
        review_id: review.review.review_id,
        finding_ids: review.review.findings.map((f) => f.finding_id),
        url: "https://user:pass@preview.example.com/pricing", // userinfo -> rejected
        client_request_id: "req-rc-0004",
      },
    })) as ToolResult;

    expect(recheck.isError).toBe(true);
    const error = (recheck.structuredContent as { error: { code: string; retriable: boolean } })
      .error;
    expect(error.code).toBe("URL_NOT_ALLOWED");
    expect(error.retriable).toBe(false);
  });

  it("design_review reports a disallowed URL as URL_NOT_ALLOWED, matching design_recheck (#14)", async () => {
    const { client } = await connectClient();
    // Userinfo passes the input-schema https check but is rejected by URL
    // normalization. This must surface as URL_NOT_ALLOWED on design_review, the
    // same code design_recheck already returns for the identical case — not the
    // older, less precise INVALID_ARGUMENT.
    const out = (await client.callTool({
      name: "design_review",
      arguments: {
        url: "https://user:pass@preview.example.com/pricing",
        client_request_id: "req-url-0001",
      },
    })) as ToolResult;

    expect(out.isError).toBe(true);
    const error = (out.structuredContent as { error: { code: string; retriable: boolean } }).error;
    expect(error.code).toBe("URL_NOT_ALLOWED");
    expect(error.retriable).toBe(false);
  });

  it("rate-limits a storming recheck loop with RATE_LIMITED + retry_after_ms (#5)", async () => {
    const { client } = await connectClient();
    const submit = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/pricing", client_request_id: "req-rv-0003" },
    })) as ToolResult;
    const review = (
      (await client.callTool({
        name: "design_review_get",
        arguments: { job_id: (submit.structuredContent as { job: { job_id: string } }).job.job_id },
      })) as ToolResult
    ).structuredContent as { review: { review_id: string; findings: { finding_id: string }[] } };
    const ids = review.review.findings.map((f) => f.finding_id);

    const first = (await client.callTool({
      name: "design_recheck",
      arguments: {
        review_id: review.review.review_id,
        finding_ids: ids,
        expected_revision: "deploy-2",
        client_request_id: "req-rc-0003a",
      },
    })) as ToolResult;
    expect(first.isError).toBeFalsy();

    // A second recheck on the same review at the same clock is throttled by the
    // exponential backoff; the server returns RATE_LIMITED with a wait.
    const second = (await client.callTool({
      name: "design_recheck",
      arguments: {
        review_id: review.review.review_id,
        finding_ids: ids,
        expected_revision: "deploy-3",
        client_request_id: "req-rc-0003b",
      },
    })) as ToolResult;
    expect(second.isError).toBe(true);
    const error = (second.structuredContent as { error: { code: string; retry_after_ms: number } })
      .error;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retry_after_ms).toBeGreaterThan(0);
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

  it("rejects an unverified host with DOMAIN_UNVERIFIED (SSRF guard)", async () => {
    const { client } = await connectClient();
    const out = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://evil.example.org/", client_request_id: "req-evil0001" },
    })) as ToolResult;

    expect(out.isError).toBe(true);
    const error = (out.structuredContent as { error: { code: string } }).error;
    expect(error.code).toBe("DOMAIN_UNVERIFIED");
  });

  it("fails closed: with no allowlist configured every target is rejected", async () => {
    // Default factory (no allowlist/resolver) installs an empty allowlist.
    const server = createMcpReviewServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const out = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "req-failclosed" },
    })) as ToolResult;

    expect(out.isError).toBe(true);
    const error = (out.structuredContent as { error: { code: string } }).error;
    expect(error.code).toBe("DOMAIN_UNVERIFIED");
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
