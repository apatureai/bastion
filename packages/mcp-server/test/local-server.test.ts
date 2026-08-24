import { loadGoldenEngineResult } from "@apatureai/bastion-types";
import type { EngineReviewResult } from "@apatureai/bastion-types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { EngineClient, EngineRecheckRequest } from "../src/engine-client.js";
import { EngineDependencyError } from "../src/engine-http-client.js";
import type { NormalizedReviewRequest } from "../src/normalize.js";
import {
  createLocalDnsResolver,
  createLocalReviewServer,
  LOCAL_ALLOWED_HOST,
  LOCAL_RESOLVED_ADDRESS,
} from "../src/local-server.js";
import type { LocalReviewServerOptions } from "../src/local-server.js";

/**
 * The local composition root: the server a stranger runs with no credentials.
 * This is the same path `pnpm demo` drives, asserted end to end.
 *
 * Load-bearing: it exposes the WHOLE catalog (not a demo subset); the SSRF boundary
 * is still enforced (an unverified host is rejected exactly as in production, and
 * the fail-closed default is not weakened for convenience); the review loop
 * completes with fixture judgments; the evidence view really produces image and
 * panel blocks so the multimedia surface is reachable without a capture service;
 * and a configured critique backend reaches the tool surface intact, with no
 * silent fallback to a fixture when it fails.
 */

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; resource?: { text?: string } }>;
  structuredContent?: Record<string, unknown>;
};

async function connect(options: LocalReviewServerOptions = {}) {
  const server = createLocalReviewServer(options);
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
      not_reviewed: string[];
      provenance: { model_backed: boolean | null; source: string };
    };
    // The local server runs fixture judgments by default, and says so in the
    // payload: the grade, the provenance and the not_reviewed disclosure all
    // agree that nothing looked at the page.
    expect(review.grade).toBe("unjudged");
    expect(review.provenance).toMatchObject({ model_backed: false, source: "fixture" });
    expect(review.not_reviewed[0]).toContain("[bastion] no model judged this page");
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
    // The local server judges from a fixture, so no fix is handed over: the
    // panel action reports `unjudged` and the payload says why.
    expect((applied.structuredContent?.response as { type: string }).type).toBe("unjudged");
    expect(applied.structuredContent?.provenance).toMatchObject({
      model_backed: false,
      source: "fixture",
    });

    const recheck = await call(client, "design_recheck", {
      review_id: review.review_id,
      finding_ids: review.findings.map((f) => f.finding_id),
      expected_revision: "deploy-2",
      client_request_id: "local-e2e-0002",
    });
    const outcomes = (
      recheck.structuredContent?.recheck as {
        outcomes: Array<{ outcome: string; confidence: number | null }>;
      }
    ).outcomes;
    expect(outcomes).toHaveLength(3);
    // Nothing captured or compared anything, so no outcome claims an
    // observation of the target and none carries a confidence.
    expect(outcomes.every((o) => o.outcome === "unjudged")).toBe(true);
    expect(outcomes.every((o) => o.confidence === null)).toBe(true);
    expect((recheck.structuredContent?.recheck as { provenance: { source: string } }).provenance)
      .toMatchObject({ model_backed: false, source: "fixture" });
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

/**
 * The seam that makes a judgment real: the local server takes a critique
 * backend, so the same five tools can be served by `verdict` instead of the
 * golden fixture. These tests use a recording stand-in rather than verdict
 * itself, because the point under test is the wiring: what the backend is
 * handed, what reaches the agent, and what happens when it fails.
 */
class RecordingEngine implements EngineClient {
  readonly requests: NormalizedReviewRequest[] = [];

  constructor(private readonly result: EngineReviewResult | Error) {}

  async review(request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    this.requests.push(request);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async recheck(_request: EngineRecheckRequest): Promise<never> {
    throw new EngineDependencyError("this backend cannot recheck");
  }
}

describe("createLocalReviewServer with a configured critique backend", () => {
  const host = "preview.mycompany.test";
  const resolver = { resolve: async (): Promise<string[]> => [LOCAL_RESOLVED_ADDRESS] };

  const backedResult = (): EngineReviewResult => ({
    ...loadGoldenEngineResult(),
    overall: "a judgment of the target, not a fixture",
    findings: [
      {
        id: "v_001",
        severity: "major",
        title: "Hero heading contrast is below AA",
        description: "The hero subtitle sits at 3.2:1 against its background.",
        route: "/pricing",
        viewport: "desktop",
        element: "#hero-subtitle",
        screenshotId: null,
        suggestion: "Use the --color-text token on the subtitle.",
      },
    ],
  });

  it("hands the backend the normalized request and returns its findings", async () => {
    const engine = new RecordingEngine(backedResult());
    const client = await connect({ engine, allowedHosts: [host], resolver });

    const submit = await call(client, "design_review", {
      url: `https://${host}/pricing`,
      routes: ["/pricing"],
      viewports: ["desktop"],
      client_request_id: "backend-0001",
    });
    expect(submit.isError).toBeFalsy();
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]).toMatchObject({
      url: `https://${host}/pricing`,
      routes: ["/pricing"],
      viewports: ["desktop"],
      depth: "deep",
    });

    const jobId = (submit.structuredContent?.job as { job_id: string }).job_id;
    const summary = await call(client, "design_review_get", { job_id: jobId });
    const review = summary.structuredContent?.review as {
      overall: string;
      findings: Array<{ finding_id: string; title: string; severity: string }>;
    };
    expect(review.overall).toBe("a judgment of the target, not a fixture");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      finding_id: "v_001",
      title: "Hero heading contrast is below AA",
      severity: "should_fix",
    });
  });

  it("reports a backend failure instead of falling back to fixture judgments", async () => {
    const engine = new RecordingEngine(new EngineDependencyError("chromium is not installed"));
    const client = await connect({ engine, allowedHosts: [host], resolver });

    const submit = await call(client, "design_review", {
      url: `https://${host}/`,
      client_request_id: "backend-0002",
    });
    expect(submit.isError).toBe(true);
    const error = (submit.structuredContent as { error: { code: string } }).error;
    expect(error.code).toBe("INTERNAL_ERROR");
    // The fixture engine must not have answered in its place.
    expect(JSON.stringify(submit.structuredContent)).not.toContain("f_001");
  });

  it("still enforces the SSRF boundary for a backend-configured host", async () => {
    const engine = new RecordingEngine(backedResult());
    const client = await connect({
      engine,
      allowedHosts: [host],
      // A verified host whose DNS answer is a private address is still rejected.
      resolver: { resolve: async (): Promise<string[]> => ["10.0.0.5"] },
    });
    const denied = await call(client, "design_review", {
      url: `https://${host}/`,
      client_request_id: "backend-0003",
    });
    expect(denied.isError).toBe(true);
    expect((denied.structuredContent as { error: { code: string } }).error.code).toBe(
      "DNS_TARGET_PROHIBITED",
    );
    expect(engine.requests).toHaveLength(0);
  });
});

describe("createLocalDnsResolver", () => {
  it("answers the demo host from a constant, so the offline demo makes no lookup", async () => {
    const asked: string[] = [];
    const resolver = createLocalDnsResolver({
      resolve: async (host: string) => {
        asked.push(host);
        return ["203.0.113.9"];
      },
    });
    await expect(resolver.resolve(LOCAL_ALLOWED_HOST)).resolves.toEqual([LOCAL_RESOLVED_ADDRESS]);
    expect(asked).toEqual([]);
  });

  it("resolves every other host for real, so an added host is never authorized unlooked-up", async () => {
    const asked: string[] = [];
    const resolver = createLocalDnsResolver({
      resolve: async (host: string) => {
        asked.push(host);
        return ["93.184.216.34"];
      },
    });
    await expect(resolver.resolve("preview.mycompany.test")).resolves.toEqual(["93.184.216.34"]);
    expect(asked).toEqual(["preview.mycompany.test"]);
  });
});
