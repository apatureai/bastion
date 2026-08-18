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
 * declares, over every tool result the server can produce, on both the judged
 * and the unjudged path. It is deliberately written to fail on an UNDECLARED
 * field as loudly as on a missing one, because that is the class of drift the
 * presence checks let through.
 *
 * It validates INPUTS too, and validates both against what `tools/list`
 * ADVERTISES rather than against the catalog file directly. Three defects
 * survived three passes because of the gap between those two: the wire served a
 * Zod-derived input schema while the catalog served a different one, no
 * `outputSchema` reached the wire at all, and the catalog's own input schemas
 * rejected calls the server happily accepted (`design_review_get`'s `allOf`
 * required `finding_ids`/`evidence_ids` it never declared under
 * `additionalProperties: false`; `design_recheck` floored finding ids at 8
 * characters while the engine's own fixture ids are five). Validating live calls
 * against the live listing is what makes that class of defect impossible to
 * merge.
 *
 * It only validates calls THIS repository writes, though, which leaves it blind
 * to a catalog that permits more than the server accepts: no call written here
 * would exercise the extra permission, so the suite stays green while a client
 * that trusts the advertised contract gets a runtime rejection. That direction
 * is issue #1 and it is covered next door, in `schema-permissiveness.test.ts`,
 * which generates inputs from the advertised schema instead of from ours.
 */

const CATALOG_PATH = fileURLToPath(new URL("../../../schemas/mcp-tools.json", import.meta.url));
const ERROR_SCHEMA_PATH = fileURLToPath(
  new URL("../../../schemas/review-error.schema.json", import.meta.url),
);

type JsonSchema = Record<string, unknown>;

type ToolCatalog = {
  tools: Array<{ name: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema }>;
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/** One tool call the server actually served: what went in, and what came out. */
type CapturedCall = {
  /** A stable label naming the call, e.g. `design_review_get[evidence]`. */
  label: string;
  tool: string;
  args: Record<string, unknown>;
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

/**
 * A backend that really was called and really judged nothing: a live model, and
 * a triage answer that named no route to deep-review.
 *
 * It is the third shape a payload can take, alongside judged and unjudged, and
 * the one the published contract had no field for at all. `grade` becomes
 * `nothing_reviewed`, `coverage.state` becomes `nothing`, and
 * `hallucination_drops` is a real number: all three are validated here against
 * what `tools/list` advertises, exactly like every other payload, so a strict
 * client cannot receive a shape the contract does not declare.
 */
class NothingReviewedEngine extends LiveModelEngine {
  override async review(request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    const result = await super.review(request);
    return {
      ...result,
      coverage: {
        routesRequested: [...request.routes],
        routesReviewed: [],
        viewportsRequested: [...request.viewports],
        viewportsReviewed: [],
      },
      hallucinationDrops: 2,
    };
  }
}

/** Render Ajv's errors the way a strict client would report a rejection. */
function explain(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `   [${error.instancePath}] ${error.message ?? "invalid"}`)
    .join("\n");
}

async function connect(engine?: EngineClient): Promise<Client> {
  const server = createLocalReviewServer(engine ? { engine } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-conformance-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** What `tools/list` advertises, as a client receives it over the transport. */
async function wireListing(): Promise<Map<string, { inputSchema?: JsonSchema; outputSchema?: JsonSchema }>> {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  return new Map(
    tools.map((tool) => [
      tool.name,
      JSON.parse(JSON.stringify({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })) as {
        inputSchema?: JsonSchema;
        outputSchema?: JsonSchema;
      },
    ]),
  );
}

/**
 * Drive one server through every payload-producing call it has. Both engines go
 * through the identical script, so the judged and the unjudged shape of each
 * payload are held to the same contract.
 *
 * The script mirrors what `pnpm demo` does, call for call, including the two
 * views and the recheck whose arguments the published input schemas used to
 * reject.
 */
async function captureCalls(engine: EngineClient, tag: string): Promise<CapturedCall[]> {
  const client = await connect(engine);

  const captured: CapturedCall[] = [];
  const call = async (
    label: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
    expect(result.isError, `${label} unexpectedly errored`).toBeFalsy();
    expect(result.structuredContent, `${label} returned no structured content`).toBeDefined();
    captured.push({ label: `${label} (${tag})`, tool, args, payload: result.structuredContent! });
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
    // The engine's own ids, "f_001" and friends: five characters, which the
    // published schema used to reject.
    finding_ids: review.findings.map((f) => f.finding_id),
    expected_revision: "deploy-2",
    client_request_id: `conformance-${tag}-recheck`,
  });

  await call("design_review_cancel", "design_review_cancel", { job_id: jobId });

  await client.close();
  return captured;
}

/** The one error every deployment can produce: an unverified host. */
async function captureError(): Promise<{ args: Record<string, unknown>; payload: Record<string, unknown> }> {
  const client = await connect();
  const args = { url: "https://evil.example.org/", client_request_id: "conformance-ssrf" };
  const denied = (await client.callTool({ name: "design_review", arguments: args })) as ToolResult;
  expect(denied.isError).toBe(true);
  await client.close();
  return { args, payload: denied.structuredContent as Record<string, unknown> };
}

describe("every tool call and payload validates against what tools/list advertises", () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as ToolCatalog;
  const inputValidators = new Map<string, ValidateFunction>();
  const outputValidators = new Map<string, ValidateFunction>();
  let advertised: Map<string, { inputSchema?: JsonSchema; outputSchema?: JsonSchema }> = new Map();
  let calls: CapturedCall[] = [];
  let denied: { args: Record<string, unknown>; payload: Record<string, unknown> };

  beforeAll(async () => {
    advertised = await wireListing();
    // Draft 2020-12, the dialect every schema in the catalog declares.
    // `strict: false` only silences Ajv's own style warnings; `allErrors` makes
    // a failure report every violation rather than the first.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const [name, schemas] of advertised) {
      if (schemas.inputSchema) inputValidators.set(name, ajv.compile(schemas.inputSchema));
      if (schemas.outputSchema) outputValidators.set(name, ajv.compile(schemas.outputSchema));
    }
    calls = [
      ...(await captureCalls(new MockEngineClient(), "unjudged")),
      ...(await captureCalls(new LiveModelEngine(), "judged")),
      ...(await captureCalls(new NothingReviewedEngine(), "nothing-reviewed")),
    ];
    denied = await captureError();
  });

  it("advertises an inputSchema and an outputSchema for every tool", () => {
    expect([...advertised.keys()].sort()).toEqual([
      "design_recheck",
      "design_review",
      "design_review_cancel",
      "design_review_get",
      "design_review_panel_action",
    ]);
    for (const [name, schemas] of advertised) {
      // Without an advertised outputSchema a strict client cannot validate
      // structured content at all, and the contract is enforced repo-side only.
      expect(schemas.outputSchema, `${name} outputSchema`).toBeDefined();
      expect(schemas.inputSchema, `${name} inputSchema`).toBeDefined();
    }
  });

  it("advertises the catalog's own schemas, so the wire and the catalog cannot drift", () => {
    for (const tool of catalog.tools) {
      const wire = advertised.get(tool.name);
      expect(wire?.inputSchema, `${tool.name} inputSchema`).toEqual(tool.inputSchema);
      expect(wire?.outputSchema, `${tool.name} outputSchema`).toEqual(tool.outputSchema);
    }
  });

  it("exercises every advertised tool", () => {
    const exercised = new Set(calls.map((c) => c.tool));
    for (const name of advertised.keys()) {
      expect(exercised.has(name), `${name} produced no call to validate`).toBe(true);
    }
  });

  it("validates every call's arguments against the advertised inputSchema", () => {
    const failures: string[] = [];
    for (const { label, tool, args } of [...calls, { label: "design_review[denied]", tool: "design_review", args: denied.args }]) {
      const validate = inputValidators.get(tool);
      if (!validate) continue;
      if (!validate(JSON.parse(JSON.stringify(args)))) {
        failures.push(`${label} vs ${tool} -> INVALID\n${explain(validate.errors)}`);
      }
    }
    expect(failures.join("\n"), failures.join("\n")).toBe("");
  });

  it("accepts the three calls the published input schemas used to reject", () => {
    // Regression cases, named as the validator reported them:
    //   06-get-focus    additionalProperty "finding_ids"
    //   07-get-evidence additionalProperty "evidence_ids"
    //   10-recheck      finding_ids[0] "f_001" fewer than 8 characters
    const get = inputValidators.get("design_review_get")!;
    const recheck = inputValidators.get("design_recheck")!;
    const jobId = "job_00000000-0000-4000-8000-000000000000";

    expect(get({ job_id: jobId, view: "focus" }) || explain(get.errors)).toBe(true);
    expect(get({ job_id: jobId, view: "evidence" }) || explain(get.errors)).toBe(true);
    expect(
      recheck({
        review_id: "rev_00000000-0000-4000-8000-000000000000",
        finding_ids: ["f_001", "f_002", "f_003"],
        client_request_id: "conformance-regression",
      }) || explain(recheck.errors),
    ).toBe(true);

    // And the schema is still closed: an undeclared argument is still rejected.
    expect(get({ job_id: jobId, view: "focus", finding_ids: ["f_001"] })).toBe(false);
  });

  it("validates every captured payload against the advertised outputSchema", () => {
    const failures: string[] = [];
    for (const { label, tool, payload } of calls) {
      const validate = outputValidators.get(tool);
      if (!validate) continue;
      // Validate what crosses the wire, not the in-process object: a serializer
      // that drops an undefined or narrows a number is part of the contract.
      if (!validate(JSON.parse(JSON.stringify(payload)))) {
        failures.push(`${label} vs ${tool} -> INVALID\n${explain(validate.errors)}`);
      }
    }
    expect(failures.join("\n"), failures.join("\n")).toBe("");
  });

  it("declares every field the review payload actually carries, and requires it", () => {
    // The blind spot the presence checks share with an open sub-schema. The
    // review object is `additionalProperties: true`, so an undeclared field
    // validates silently: `not_reviewed` was emitted on every review and named
    // in README three times while appearing nowhere in this file, and
    // `coverage` and `hallucination_drops` did not exist here at all. A field an
    // agent is told to read must be in the published contract, not merely
    // tolerated by it.
    const review = (
      (catalog.tools.find((t) => t.name === "design_review_get")!.outputSchema!
        .properties as Record<string, JsonSchema>).review
    );
    const declared = Object.keys(review.properties as Record<string, unknown>);
    const required = review.required as string[];
    for (const field of ["not_reviewed", "coverage", "hallucination_drops"]) {
      expect(declared, `${field} is not declared`).toContain(field);
      expect(required, `${field} is not required`).toContain(field);
    }
    // And every review payload the server actually served carries them.
    for (const { label, payload } of calls) {
      const body = payload.review as Record<string, unknown> | undefined;
      if (body === undefined) continue;
      expect(Object.keys(body), `${label} review fields`).toEqual(
        expect.arrayContaining(["not_reviewed", "coverage", "hallucination_drops"]),
      );
    }
  });

  it("validates the nothing-reviewed shape, which no engine emits and the server substitutes", () => {
    // A live, model-backed run that judged no route. Its grade and its
    // coverage.state are values that only exist because Bastion refuses to
    // report the engine's `ship`, so both have to be in the advertised enums.
    const nothing = calls.find((c) =>
      c.label.startsWith("design_review_get[summary] (nothing-reviewed)"),
    );
    expect(nothing, "the nothing-reviewed engine produced no summary call").toBeDefined();
    const review = nothing!.payload.review as {
      grade: string;
      coverage: { state: string; routes_reviewed: string[] };
      hallucination_drops: number | null;
      provenance: { model_backed: boolean | null };
    };
    expect(review.provenance.model_backed).toBe(true);
    expect(review.coverage.routes_reviewed).toEqual([]);
    expect(review.coverage.state).toBe("nothing");
    expect(review.grade).toBe("nothing_reviewed");
    expect(review.hallucination_drops).toBe(2);
    const validate = outputValidators.get("design_review_get")!;
    expect(validate(JSON.parse(JSON.stringify(nothing!.payload))) || explain(validate.errors)).toBe(
      true,
    );
  });

  it("rejects a payload carrying a field the contract does not declare", () => {
    // The guard on the guard. `additionalProperties: false` is what makes the
    // undeclared-field class detectable at all, so prove it is still in force:
    // if this stopped failing, the test above would stop being a gate.
    const validate = outputValidators.get("design_review_get")!;
    const evidence = calls.find((c) => c.label.startsWith("design_review_get[evidence]"))!;
    expect(validate(JSON.parse(JSON.stringify(evidence.payload)))).toBe(true);
    expect(validate({ ...evidence.payload, undeclared_extra: true })).toBe(false);
  });

  it("validates a tool error against the advertised outputSchema and the error schema", async () => {
    // An error result carries structuredContent too, and a strict client
    // validates it against the same advertised outputSchema, so the contract has
    // to declare the error envelope rather than pretend it is never emitted.
    const validate = outputValidators.get("design_review")!;
    expect(validate(JSON.parse(JSON.stringify(denied.payload))) || explain(validate.errors)).toBe(true);
    // A result envelope and an error envelope are never both present.
    expect(validate({ ...denied.payload, schema_version: "1.0.0" })).toBe(false);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const errorSchema = ajv.compile(JSON.parse(readFileSync(ERROR_SCHEMA_PATH, "utf8")));
    const error = (denied.payload as { error: Record<string, unknown> }).error;
    expect(errorSchema(error) || explain(errorSchema.errors)).toBe(true);
  });
});
