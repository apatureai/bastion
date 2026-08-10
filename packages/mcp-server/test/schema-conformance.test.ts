import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import type { EngineClient, EngineRecheckRequest } from "../src/engine-client.js";
import { MockEngineClient } from "../src/engine-client.js";
import { createLocalReviewServer } from "../src/local-server.js";
import type { NormalizedReviewRequest } from "../src/normalize.js";
import {
  stampProvenance,
  stampRecheckProvenance,
  verdictCliProvenance,
} from "../src/provenance.js";

/**
 * The gate that says a payload IS the published contract, rather than merely
 * having the right keys somewhere in it.
 *
 * Every other schema assertion in this suite reaches into
 * `schemas/mcp-tools.json`, pulls out a `required` list, and loops it with
 * `toHaveProperty`. That is a presence check, and presence checks are blind in
 * exactly one direction: they cannot see a field the payload emits and the
 * schema does not declare. `design_review_get`'s output schema sets
 * `additionalProperties: false`, so the `presentation` object the evidence view
 * has emitted since it shipped made that view INVALID against its own contract,
 * and a strict MCP client would have rejected it. Nothing here caught it,
 * because nothing here ever ran a validator.
 *
 * So this file runs one: Ajv in Draft 2020-12 mode, the dialect the catalog
 * declares, over the structured content of every tool result the server can
 * produce, on both the judged and the unjudged path. It is deliberately written
 * to fail on an UNDECLARED field as loudly as on a missing one, because that is
 * the class of drift the presence checks let through.
 */

const CATALOG_PATH = fileURLToPath(new URL("../../../schemas/mcp-tools.json", import.meta.url));
const ERROR_SCHEMA_PATH = fileURLToPath(
  new URL("../../../schemas/review-error.schema.json", import.meta.url),
);

type ToolCatalog = {
  tools: Array<{ name: string; outputSchema?: Record<string, unknown> }>;
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/** One tool payload the server actually produced, and the tool it came from. */
type CapturedPayload = {
  /** A stable label naming the call, e.g. `design_review_get[evidence]`. */
  label: string;
  tool: string;
  payload: Record<string, unknown>;
};

/** A backend standing in for a real, live, model-backed verdict run. */
class LiveModelEngine extends MockEngineClient {
  override async review(request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    const result = await super.review(request);
    return stampProvenance(result, verdictCliProvenance("live", result));
  }
  override async recheck(request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    return stampRecheckProvenance(await super.recheck(request), {
      model_backed: true,
      source: "model",
      engine: "verdict-cli",
      model: "qwen3-vl",
      detail: "chromium re-captured the flagged elements and a vision model judged the capture",
    });
  }
}

/** Render Ajv's errors the way a strict client would report a rejection. */
function explain(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `   [${error.instancePath}] ${error.message ?? "invalid"}`)
    .join("\n");
}

/**
 * Drive one server through every payload-producing call it has. Both engines go
 * through the identical script, so the judged and the unjudged shape of each
 * payload are held to the same contract.
 */
async function capturePayloads(engine: EngineClient, tag: string): Promise<CapturedPayload[]> {
  const server = createLocalReviewServer({ engine });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-conformance-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const captured: CapturedPayload[] = [];
  const call = async (
    label: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
    expect(result.isError, `${label} unexpectedly errored`).toBeFalsy();
    expect(result.structuredContent, `${label} returned no structured content`).toBeDefined();
    captured.push({ label: `${label} (${tag})`, tool, payload: result.structuredContent! });
    return result;
  };

  const submit = await call("design_review", "design_review", {
    url: "https://preview.example.com/pricing",
    routes: ["/pricing"],
    viewports: ["mobile", "desktop"],
    client_request_id: `conformance-${tag}-review`,
  });
  const jobId = (submit.structuredContent?.job as { job_id: string }).job_id;

  for (const view of ["status", "summary", "findings", "focus", "evidence"]) {
    await call(`design_review_get[${view}]`, "design_review_get", { job_id: jobId, view });
  }
  const summary = await call("design_review_get[default]", "design_review_get", { job_id: jobId });
  const review = summary.structuredContent?.review as {
    review_id: string;
    findings: Array<{ finding_id: string }>;
  };

  await call("design_review_panel_action[apply_fix]", "design_review_panel_action", {
    job_id: jobId,
    action: "apply_fix",
    finding_id: review.findings[0]!.finding_id,
  });
  await call("design_review_panel_action[recheck]", "design_review_panel_action", {
    job_id: jobId,
    action: "recheck",
  });

  await call("design_recheck", "design_recheck", {
    review_id: review.review_id,
    finding_ids: review.findings.map((f) => f.finding_id),
    expected_revision: "deploy-2",
    client_request_id: `conformance-${tag}-recheck`,
  });

  await call("design_review_cancel", "design_review_cancel", { job_id: jobId });

  await client.close();
  return captured;
}

/** The one error payload every deployment can produce: an unverified host. */
async function captureError(): Promise<Record<string, unknown>> {
  const server = createLocalReviewServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-conformance-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const denied = (await client.callTool({
    name: "design_review",
    arguments: { url: "https://evil.example.org/", client_request_id: "conformance-ssrf" },
  })) as ToolResult;
  expect(denied.isError).toBe(true);
  await client.close();
  return (denied.structuredContent as { error: Record<string, unknown> }).error;
}

describe("every tool payload validates against schemas/mcp-tools.json", () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as ToolCatalog;
  const validators = new Map<string, ValidateFunction>();
  let payloads: CapturedPayload[] = [];

  beforeAll(async () => {
    // Draft 2020-12, the dialect every outputSchema in the catalog declares.
    // `strict: false` only silences Ajv's own style warnings; `allErrors` makes
    // a failure report every violation rather than the first.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const tool of catalog.tools) {
      if (tool.outputSchema) validators.set(tool.name, ajv.compile(tool.outputSchema));
    }
    payloads = [
      ...(await capturePayloads(new MockEngineClient(), "unjudged")),
      ...(await capturePayloads(new LiveModelEngine(), "judged")),
    ];
  });

  it("declares an outputSchema for every tool, so nothing can opt out of the gate", () => {
    expect(catalog.tools.map((t) => t.name).sort()).toEqual([
      "design_recheck",
      "design_review",
      "design_review_cancel",
      "design_review_get",
      "design_review_panel_action",
    ]);
    for (const tool of catalog.tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("exercises every tool in the catalog", () => {
    const exercised = new Set(payloads.map((p) => p.tool));
    for (const tool of catalog.tools) {
      expect(exercised.has(tool.name), `${tool.name} produced no payload to validate`).toBe(true);
    }
  });

  it("validates every captured payload with a real Draft 2020-12 validator", () => {
    const failures: string[] = [];
    for (const { label, tool, payload } of payloads) {
      const validate = validators.get(tool);
      if (!validate) continue;
      // Validate what crosses the wire, not the in-process object: a serializer
      // that drops an undefined or narrows a number is part of the contract.
      if (!validate(JSON.parse(JSON.stringify(payload)))) {
        failures.push(`${label} vs ${tool} -> INVALID\n${explain(validate.errors)}`);
      }
    }
    expect(failures.join("\n"), failures.join("\n")).toBe("");
  });

  it("rejects a payload carrying a field the contract does not declare", () => {
    // The guard on the guard. `additionalProperties: false` is what makes the
    // undeclared-field class detectable at all, so prove it is still in force:
    // if this stopped failing, the test above would stop being a gate.
    const validate = validators.get("design_review_get")!;
    const evidence = payloads.find((p) => p.label.startsWith("design_review_get[evidence]"))!;
    expect(validate(JSON.parse(JSON.stringify(evidence.payload)))).toBe(true);
    expect(validate({ ...evidence.payload, undeclared_extra: true })).toBe(false);
  });

  it("validates a tool error against schemas/review-error.schema.json", async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(ERROR_SCHEMA_PATH, "utf8")));
    const error = await captureError();
    expect(validate(error) || explain(validate.errors)).toBe(true);
  });
});
