import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { createLocalReviewServer } from "../src/local-server.js";
import {
  designRecheckInputSchema,
  designReviewCancelInputSchema,
  designReviewGetInputSchema,
  designReviewInputSchema,
  designReviewPanelActionInputSchema,
} from "../src/tools.js";

/**
 * The other direction of the conformance guard: a published schema that permits
 * MORE than the code accepts.
 *
 * `schema-conformance.test.ts` drives real calls and validates them against the
 * schemas `tools/list` advertises. That catches a catalog STRICTER than the
 * server: a published schema that rejects a call the server is happy to serve.
 * It is blind the other way round, because it only ever validates calls this
 * repository itself writes. A catalog mutated to be laxer than the server
 * (`required` reduced to `["url"]`, an extra `depth` enum value) left the whole
 * suite green, which is issue #1: a client that trusts the advertised contract
 * and builds a call from it gets a runtime rejection, and nothing here would
 * have told us.
 *
 * The fix has to generate inputs FROM the advertised schema rather than from our
 * own imagination, or it degrades into a hand-maintained list that drifts with
 * the next schema edit. So: for every tool, build a matrix of instances that Ajv
 * confirms are valid against the advertised `inputSchema`, and assert the Zod
 * shape the server actually parses with accepts every one of them. Any
 * permission the catalog grants that the parser does not honour fails here, and
 * it fails naming the tool, the property and the value.
 *
 * The candidate values come from three places, one per class of drift:
 *   - the schema's own `enum` members, so a widened enum is exercised by
 *     construction rather than by whether someone thought of the new word;
 *   - lengths and item counts computed from `minLength` / `maxLength` /
 *     `minItems` / `maxItems`, so a loosened bound produces a value at the new
 *     bound;
 *   - a fixed corpus of ordinary JSON leaves (other schemes, other shapes,
 *     spaces, wrong types), so a dropped `pattern`, `format` or `type`
 *     immediately admits something the parser refuses.
 * Every candidate is filtered through Ajv before it is used, so the matrix can
 * only ever contain inputs the published contract really does permit.
 *
 * It parses against the Zod schemas rather than calling the tools because those
 * shapes ARE what `server.ts` registers each tool with; driving live calls would
 * mix schema rejections with NOT_FOUND answers to generated job ids and make the
 * failure ambiguous. The listing and the shapes meeting on the wire is what the
 * sibling file already proves.
 */

type JsonSchema = Record<string, unknown>;

/** The Zod schema each tool is registered with, by tool name. */
const PARSERS: Record<string, ZodType> = {
  design_review: designReviewInputSchema,
  design_review_get: designReviewGetInputSchema,
  design_recheck: designRecheckInputSchema,
  design_review_cancel: designReviewCancelInputSchema,
  design_review_panel_action: designReviewPanelActionInputSchema,
};

/**
 * Ordinary JSON leaves, deliberately not tailored to any one property: other URL
 * schemes, other path shapes, whitespace, the wrong type entirely. Each is kept
 * only where the advertised schema says it is legal, so this list cannot make a
 * test fail on its own; it can only reveal a permission the catalog granted.
 */
const SCALAR_CORPUS: readonly unknown[] = [
  "",
  "a",
  "ab",
  "abc",
  "f_001",
  "abcdefgh",
  "with space",
  "naive-value",
  "UPPER.case_id:1-2",
  "/",
  "/pricing",
  "pricing",
  "../pricing",
  "https://preview.example.com/pricing",
  "https://preview.example.com/",
  "http://preview.example.com/",
  "ftp://preview.example.com/",
  "//preview.example.com/",
  "job_00000000-0000-4000-8000-000000000000",
  "rev_00000000-0000-4000-8000-000000000000",
  0,
  1,
  -1,
  1.5,
  true,
  false,
  null,
  {},
];

/** Filler characters tried, in order, when building a string of a given length. */
const FILLERS = ["a", "A", "0", "-", ".", "_", ":", "/"] as const;

/** Every declared property of an object schema, with its subschema. */
function properties(schema: JsonSchema): Array<[string, JsonSchema]> {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(props);
}

/**
 * Build a string of exactly `length` that the subschema accepts, or `undefined`
 * when no seed and filler combination produces one.
 *
 * Seeded from corpus values the subschema already accepts so that a `pattern` or
 * a `format` requiring a prefix (`^https://`, `^/`) is satisfied by
 * construction, then padded or truncated to the target length. The result is
 * checked against the subschema before it is returned, so a string that only
 * looks valid never enters the matrix.
 */
function stringOfLength(
  length: number,
  accepts: ValidateFunction,
  seeds: readonly string[],
): string | undefined {
  for (const seed of ["", ...seeds]) {
    for (const filler of FILLERS) {
      const padded = seed.length >= length ? seed.slice(0, length) : seed + filler.repeat(length - seed.length);
      if (padded.length === length && accepts(padded)) return padded;
    }
  }
  return undefined;
}

/**
 * Every value this subschema permits that is worth trying: its own enum members,
 * the corpus values it accepts, strings at its declared length bounds, and
 * arrays at its declared item bounds. Filtered through the subschema itself, so
 * the caller never has to reason about whether a candidate is legal.
 */
function candidatesFor(subschema: JsonSchema, ajv: Ajv2020): unknown[] {
  const accepts = ajv.compile(subschema);
  const out: unknown[] = [];
  const push = (value: unknown): void => {
    if (accepts(value)) out.push(value);
  };

  // The schema's own vocabulary. A widened enum is covered because the extra
  // member is read out of the schema, not guessed.
  for (const member of (subschema.enum as unknown[] | undefined) ?? []) push(member);
  for (const value of SCALAR_CORPUS) push(value);

  const seeds = out.filter((value): value is string => typeof value === "string");
  // Declared bounds, and one step inside each, so a loosened bound is exercised
  // at its new value rather than at the value we happen to remember.
  const min = subschema.minLength as number | undefined;
  const max = subschema.maxLength as number | undefined;
  for (const length of [min, min === undefined ? undefined : min + 1, max]) {
    if (length === undefined || length < 0) continue;
    const built = stringOfLength(length, accepts, seeds);
    if (built !== undefined) out.push(built);
  }

  if (subschema.type === "array") {
    const items = (subschema.items ?? {}) as JsonSchema;
    const itemValues = candidatesFor(items, ajv);
    const minItems = (subschema.minItems as number | undefined) ?? 0;
    const maxItems = (subschema.maxItems as number | undefined) ?? minItems + 1;
    for (const size of new Set([0, minItems, maxItems])) {
      if (size < 0) continue;
      // Cycle the item values so a bounded array still varies its contents.
      const array = Array.from({ length: size }, (_, i) => itemValues[i % Math.max(itemValues.length, 1)]);
      if (size > 0 && itemValues.length === 0) continue;
      push(array);
    }
    // And one array per item value, because cycling alone cannot reach a value
    // past `maxItems`: a fourth member added to a three-item enum would
    // otherwise never be tried.
    const size = Math.max(minItems, 1);
    for (const value of itemValues) push(Array.from({ length: size }, () => value));
  }

  return out;
}

/** The smallest instance the schema calls complete: every required property, once. */
function requiredOnlyInstance(
  schema: JsonSchema,
  byProperty: Map<string, unknown[]>,
): Record<string, unknown> | undefined {
  const instance: Record<string, unknown> = {};
  for (const name of (schema.required as string[] | undefined) ?? []) {
    const values = byProperty.get(name);
    if (values === undefined || values.length === 0) return undefined;
    instance[name] = values[0];
  }
  return instance;
}

/** One generated call: what it is, and which permission produced it. */
type Instance = { label: string; args: Record<string, unknown> };

async function wireListing(): Promise<Map<string, JsonSchema>> {
  const server = createLocalReviewServer({});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-permissiveness-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(
    tools.map((tool) => [tool.name, JSON.parse(JSON.stringify(tool.inputSchema)) as JsonSchema]),
  );
}

describe("every input the advertised schema permits is one the server accepts", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  let advertised: Map<string, JsonSchema> = new Map();
  const generated = new Map<string, Instance[]>();
  const perProperty = new Map<string, Map<string, unknown[]>>();

  beforeAll(async () => {
    advertised = await wireListing();
    for (const [tool, schema] of advertised) {
      const validate = ajv.compile(schema);
      const byProperty = new Map<string, unknown[]>();
      for (const [name, subschema] of properties(schema)) {
        byProperty.set(name, candidatesFor(subschema, ajv));
      }
      perProperty.set(tool, byProperty);

      const base = requiredOnlyInstance(schema, byProperty);
      const instances: Instance[] = [];
      if (base !== undefined) instances.push({ label: "required properties only", args: base });

      // Every property at every value the contract permits, on top of the
      // minimal instance: one substitution at a time, so a failure names the
      // exact permission that is not honoured.
      for (const [name, values] of byProperty) {
        for (const value of values) {
          const args = { ...(base ?? {}), [name]: value };
          instances.push({ label: `${name} = ${JSON.stringify(value)?.slice(0, 80)}`, args });
        }
      }

      // Only inputs the published contract really does permit reach the
      // assertion; anything the generator built that the schema rejects is
      // dropped here rather than reported as a server defect.
      generated.set(
        tool,
        instances.filter((instance) => validate(JSON.parse(JSON.stringify(instance.args)))),
      );
    }
  });

  it("generates a matrix from the advertised schema, so the guard cannot go quiet", () => {
    // The guard on the guard. If a schema edit defeated the generator, this test
    // fails instead of the suite silently checking nothing.
    expect([...generated.keys()].sort()).toEqual(Object.keys(PARSERS).sort());
    for (const [tool, instances] of generated) {
      expect(instances.length, `${tool} produced no schema-valid inputs`).toBeGreaterThan(4);
      for (const [name, values] of perProperty.get(tool)!) {
        expect(values.length, `${tool}.${name} produced no candidate values`).toBeGreaterThan(0);
      }
    }
  });

  it("accepts every generated input, so the catalog never promises more than the parser honours", () => {
    const failures: string[] = [];
    for (const [tool, instances] of generated) {
      const parser = PARSERS[tool];
      expect(parser, `no parser registered for ${tool}`).toBeDefined();
      for (const instance of instances) {
        const parsed = parser!.safeParse(instance.args);
        if (!parsed.success) {
          const reasons = parsed.error.issues
            .map((issue) => `      [${issue.path.join(".") || "(root)"}] ${issue.message}`)
            .join("\n");
          failures.push(`   ${tool}: ${instance.label}\n${reasons}`);
        }
      }
    }
    expect(
      failures.join("\n"),
      `the advertised inputSchema permits calls the server rejects:\n${failures.join("\n")}`,
    ).toBe("");
  });

  it("detects a catalog laxer than the parser, which is the whole point", () => {
    // Prove the direction is really covered, using the two mutations from
    // issue #1 against a copy of the advertised schema. If either of these
    // stopped being caught, the assertion above would be decorative.
    const review = JSON.parse(JSON.stringify(advertised.get("design_review"))) as JsonSchema;
    const props = review.properties as Record<string, JsonSchema>;

    const widerEnum = JSON.parse(JSON.stringify(review)) as JsonSchema;
    ((widerEnum.properties as Record<string, JsonSchema>).depth.enum as string[]).push("exhaustive");
    expect(schemaIsHonoured(widerEnum, designReviewInputSchema, ajv)).toBe(false);

    const fewerRequired = JSON.parse(JSON.stringify(review)) as JsonSchema;
    fewerRequired.required = ["url"];
    expect(schemaIsHonoured(fewerRequired, designReviewInputSchema, ajv)).toBe(false);

    const longerStrings = JSON.parse(JSON.stringify(review)) as JsonSchema;
    (longerStrings.properties as Record<string, JsonSchema>).url.maxLength = 4096;
    expect(schemaIsHonoured(longerStrings, designReviewInputSchema, ajv)).toBe(false);

    const droppedPattern = JSON.parse(JSON.stringify(review)) as JsonSchema;
    delete (droppedPattern.properties as Record<string, JsonSchema>).url.pattern;
    expect(schemaIsHonoured(droppedPattern, designReviewInputSchema, ajv)).toBe(false);

    // Inside an array, where a widened item enum cannot be reached by filling an
    // array up to `maxItems` and a widened `maxItems` needs a longer array.
    const widerItemEnum = JSON.parse(JSON.stringify(review)) as JsonSchema;
    const viewports = (widerItemEnum.properties as Record<string, JsonSchema>).viewports;
    ((viewports.items as JsonSchema).enum as string[]).push("watch");
    expect(schemaIsHonoured(widerItemEnum, designReviewInputSchema, ajv)).toBe(false);

    const moreItems = JSON.parse(JSON.stringify(review)) as JsonSchema;
    (moreItems.properties as Record<string, JsonSchema>).routes.maxItems = 50;
    expect(schemaIsHonoured(moreItems, designReviewInputSchema, ajv)).toBe(false);

    // And the unmutated schema is honoured, so the four results above are the
    // mutations talking and not a generator that rejects everything.
    expect(props.depth.enum).toEqual(["triage", "deep"]);
    expect(schemaIsHonoured(review, designReviewInputSchema, ajv)).toBe(true);
  });
});

/**
 * The assertion above, as a function of a schema, so the mutation cases can ask
 * it about a schema that is not the published one.
 */
function schemaIsHonoured(schema: JsonSchema, parser: ZodType, ajv: Ajv2020): boolean {
  const validate = ajv.compile(schema);
  const byProperty = new Map<string, unknown[]>();
  for (const [name, subschema] of properties(schema)) byProperty.set(name, candidatesFor(subschema, ajv));
  const base = requiredOnlyInstance(schema, byProperty);
  if (base === undefined) return false;
  const instances = [base];
  for (const [name, values] of byProperty) {
    for (const value of values) instances.push({ ...base, [name]: value });
  }
  return instances
    .filter((args) => validate(JSON.parse(JSON.stringify(args))))
    .every((args) => parser.safeParse(args).success);
}
