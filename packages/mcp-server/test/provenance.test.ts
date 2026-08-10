import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { EngineClient, EngineRecheckRequest } from "../src/engine-client.js";
import { createLocalReviewServer } from "../src/local-server.js";
import type { LocalReviewServerOptions } from "../src/local-server.js";
import type { NormalizedReviewRequest } from "../src/normalize.js";
import { stampProvenance, verdictCliProvenance } from "../src/provenance.js";

/**
 * The regression guard for the trust defect this whole surface exists to
 * prevent: a coding agent receiving a Bastion result must be able to tell,
 * FROM THE JSON ALONE, whether anything actually judged the page.
 *
 * The consumer here is not a person. It never sees the startup banner, the
 * `pnpm review` terminal output, or the README. It sees one tool result. Before
 * `provenance`, the default fixture path handed that consumer `grade:
 * "needs_work"` plus three specific, actionable, entirely invented findings
 * about a page nobody had looked at, with nothing in the payload marking them
 * as fiction. Every assertion below is written the way that consumer reads:
 * serialize the result, parse it back, and decide using nothing else.
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

type ReviewPayload = {
  review_id: string;
  grade: string;
  confidence: number | null;
  overall: string;
  findings: Array<{ finding_id: string; title: string }>;
  not_reviewed: string[];
  provenance: {
    model_backed: boolean | null;
    source: string;
    engine: string;
    model: string | null;
    detail: string;
  };
};

/** A backend that stands in for a real, live, model-backed verdict run. */
class LiveModelEngine implements EngineClient {
  async review(_request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    const result = loadGoldenEngineResult();
    return stampProvenance(result, verdictCliProvenance("live", result));
  }
  async recheck(_request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    throw new Error("not used");
  }
}

async function connect(options: LocalReviewServerOptions = {}): Promise<Client> {
  const server = createLocalReviewServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "provenance-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/**
 * Run one review and return the review body EXACTLY as a consumer would hold
 * it: round-tripped through JSON, so nothing survives that would not survive
 * the wire.
 */
async function reviewOverTheWire(options: LocalReviewServerOptions = {}): Promise<ReviewPayload> {
  const client = await connect(options);
  const submit = (await client.callTool({
    name: "design_review",
    arguments: {
      url: "https://preview.example.com/pricing",
      routes: ["/pricing"],
      client_request_id: `prov-${Math.random().toString(36).slice(2, 12)}`,
    },
  })) as ToolResult;
  expect(submit.isError).toBeFalsy();
  const jobId = (submit.structuredContent?.job as { job_id: string }).job_id;
  const got = (await client.callTool({
    name: "design_review_get",
    arguments: { job_id: jobId },
  })) as ToolResult;
  expect(got.isError).toBeFalsy();
  return JSON.parse(JSON.stringify(got.structuredContent?.review)) as ReviewPayload;
}

/**
 * The decision an agent has to be able to make with the payload and nothing
 * else. Deliberately written as a pure function of the JSON: if it can be
 * implemented, the payload is self-describing.
 */
function judgedByAModel(payload: ReviewPayload): boolean {
  return payload.provenance.model_backed === true;
}

describe("judgment provenance is in the payload, on every path", () => {
  it("a fixture-path payload is distinguishable from a model-backed one by JSON alone", async () => {
    const fixture = await reviewOverTheWire();
    const live = await reviewOverTheWire({ engine: new LiveModelEngine() });

    // The one assertion the whole feature is for.
    expect(judgedByAModel(fixture)).toBe(false);
    expect(judgedByAModel(live)).toBe(true);

    // And it is not a difference of degree: the two payloads disagree on the
    // grade, the narrative, and the disclosure list, not just on one flag.
    expect(fixture.grade).not.toBe(live.grade);
    expect(fixture.overall).not.toBe(live.overall);
    expect(fixture.not_reviewed).not.toEqual(live.not_reviewed);
  });

  it("the default fixture path reports no grade, no confidence, and no invented narrative", async () => {
    const payload = await reviewOverTheWire();
    const golden = loadGoldenEngineResult();

    expect(payload.grade).toBe("unjudged");
    // The fixture's own grade must not appear anywhere in the payload.
    expect(payload.grade).not.toBe(golden.grade);
    // A fabricated confidence is a fabricated number like any other.
    expect(payload.confidence).toBeNull();
    // Prose describing a page nothing looked at is not offered as a description
    // of the page that was requested: the fiction is replaced, not annotated.
    expect(payload.overall).not.toBe(golden.overall);
    expect(payload.overall).not.toContain("reads clearly on desktop");
    expect(payload.overall).toContain("No model judged this page");
  });

  it("the fixture path carries the same not_reviewed disclosure the real backends do", async () => {
    const payload = await reviewOverTheWire();
    // Requirement: prose and structure agree. The disclosure is a structural
    // entry, not only a sentence in `overall`.
    expect(payload.not_reviewed[0]).toContain("[bastion] no model judged this page");
    expect(payload.not_reviewed[0]).toContain("fixture");
    // The engine's own not-reviewed entries survive underneath it.
    expect(payload.not_reviewed.slice(1)).toEqual(loadGoldenEngineResult().notReviewed);
  });

  it("names the fixture engine in full, so the reason is diagnosable from the payload", async () => {
    const payload = await reviewOverTheWire();
    expect(payload.provenance).toEqual({
      model_backed: false,
      source: "fixture",
      engine: "bastion-fixture",
      model: null,
      detail:
        "the offline fixture engine replayed the golden result in @apature/mcp-types; " +
        "it describes a fictional pricing page and not the target that was requested",
    });
  });

  it("a model-backed payload keeps the engine's grade, narrative and confidence", async () => {
    const payload = await reviewOverTheWire({ engine: new LiveModelEngine() });
    const golden = loadGoldenEngineResult();

    // Suppression applies ONLY where nothing judged the page. A real judgment
    // must reach the agent intact, or the honesty rule would be a bug.
    expect(payload.grade).toBe(golden.grade);
    expect(payload.overall).toBe(golden.overall);
    expect(payload.confidence).toBe(golden.confidence);
    expect(payload.not_reviewed).toEqual(golden.notReviewed);
    expect(payload.provenance).toMatchObject({
      model_backed: true,
      source: "model",
      engine: "verdict-cli",
      model: "qwen3-vl",
    });
  });

  it("every view that carries a review carries its provenance", async () => {
    const client = await connect();
    const submit = (await client.callTool({
      name: "design_review",
      arguments: {
        url: "https://preview.example.com/pricing",
        client_request_id: "prov-views-0001",
      },
    })) as ToolResult;
    const jobId = (submit.structuredContent?.job as { job_id: string }).job_id;

    for (const view of ["summary", "findings", "focus", "evidence"]) {
      const got = (await client.callTool({
        name: "design_review_get",
        arguments: { job_id: jobId, view },
      })) as ToolResult;
      const review = got.structuredContent?.review as ReviewPayload | undefined;
      // `focus` narrows findings and `evidence` adds content blocks; neither may
      // drop the field that says whether any of it means anything.
      expect(review?.provenance, view).toMatchObject({ model_backed: false, source: "fixture" });
      expect(review?.grade, view).toBe("unjudged");
    }
  });

  it("matches the documented tool-result contract in schemas/mcp-tools.json", async () => {
    // Provenance is part of the contract a client codes against, not an
    // incidental extra field, so the catalog has to require it.
    const catalog = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../schemas/mcp-tools.json", import.meta.url)), "utf8"),
    ) as {
      tools: Array<{
        name: string;
        outputSchema?: {
          properties?: {
            review?: {
              required?: string[];
              properties?: Record<string, { enum?: string[]; required?: string[] }>;
            };
          };
        };
      }>;
    };
    const review = catalog.tools.find((tool) => tool.name === "design_review_get")?.outputSchema
      ?.properties?.review;
    expect(review?.required).toContain("provenance");
    expect(review?.properties?.grade?.enum).toContain("unjudged");
    expect(review?.properties?.provenance?.required).toEqual([
      "model_backed",
      "source",
      "engine",
      "model",
      "detail",
    ]);

    // And the live payload satisfies what the catalog requires.
    const payload = await reviewOverTheWire();
    for (const key of review?.required ?? []) {
      expect(payload, key).toHaveProperty(key);
    }
    expect(review?.properties?.grade?.enum).toContain(payload.grade);
  });
});
