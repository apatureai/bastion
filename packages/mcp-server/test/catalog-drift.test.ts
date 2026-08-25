/**
 * Catalog drift gate (#29 acceptance: "Listing metadata matches the live
 * tools/list, CI-checked").
 *
 * directory.test.ts checks the registry manifest against schemas/mcp-tools.json
 * (static ↔ static). This suite closes the remaining leg: a real server
 * instance, driven over an in-process transport by a real MCP client. What a
 * client actually receives from tools/list and initialize must match that
 * same catalog. tools.ts claims it is "kept in lockstep with
 * schemas/mcp-tools.json"; this is the test that makes the claim enforceable.
 * Any tool rename, description edit, annotation flip, input-schema field
 * change, or version bump now fails CI unless catalog + listing move together.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpReviewServer } from "../src/index.js";

const repoRoot = new URL("../../../", import.meta.url);
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, repoRoot)), "utf8")) as Record<string, unknown>;

interface CatalogTool {
  name: string;
  title: string;
  description: string;
  annotations: Record<string, boolean>;
  _meta: Record<string, unknown>;
  inputSchema: {
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
  };
  outputSchema: Record<string, unknown>;
}

const catalog = readJson("schemas/mcp-tools.json") as unknown as {
  catalog_version: string;
  protocol_baseline: string;
  tools: CatalogTool[];
};
const manifest = readJson("directory/server.json") as {
  version: string;
  _meta: Record<string, string>;
};

async function connect() {
  const server = createMcpReviewServer({
    allowlist: { tenantId: "tenant-test", targets: [{ kind: "host", host: "preview.example.com" }] },
    resolver: { resolve: async () => ["93.184.216.34"] },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drift-gate", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("live catalog drift gate (#29)", () => {
  it("the live tool set is exactly the catalog tool set (both directions)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(catalog.tools.map((t) => t.name).sort());
  });

  it("every live tool's listing metadata matches the catalog byte-for-byte", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const live = new Map(tools.map((t) => [t.name, t]));

    for (const spec of catalog.tools) {
      const tool = live.get(spec.name);
      expect(tool, spec.name).toBeDefined();
      if (!tool) continue;
      // The strings and hints a directory listing surfaces to users/agents.
      expect(tool.title, `${spec.name} title`).toBe(spec.title);
      expect(tool.description, `${spec.name} description`).toBe(spec.description);
      expect(tool.annotations, `${spec.name} annotations`).toMatchObject(spec.annotations);
      expect(tool._meta?.["com.apature/metered"], `${spec.name} metered flag`).toBe(
        spec._meta["com.apature/metered"],
      );
      expect(tool._meta?.["com.apature/product"], `${spec.name} product tag`).toBe(
        spec._meta["com.apature/product"],
      );
    }
  });

  it("every live input schema exposes the catalog's exact fields, required set, and closed shape", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const live = new Map(tools.map((t) => [t.name, t]));

    for (const spec of catalog.tools) {
      const schema = live.get(spec.name)?.inputSchema as unknown as CatalogTool["inputSchema"];
      expect(schema, spec.name).toBeDefined();
      expect(Object.keys(schema.properties).sort(), `${spec.name} properties`).toEqual(
        Object.keys(spec.inputSchema.properties).sort(),
      );
      expect([...(schema.required ?? [])].sort(), `${spec.name} required`).toEqual(
        [...(spec.inputSchema.required ?? [])].sort(),
      );
      // The gate forbids an explicitly OPEN schema from ever being advertised.
      expect(schema.additionalProperties, `${spec.name} additionalProperties`).not.toBe(true);

      // Closed vocabularies must not drift (a widened enum silently widens the API).
      for (const [prop, propSpec] of Object.entries(spec.inputSchema.properties)) {
        const catalogEnum = propSpec.enum ?? propSpec.items?.enum;
        if (catalogEnum === undefined) continue;
        const liveProp = schema.properties[prop] as { enum?: string[]; items?: { enum?: string[] } } | undefined;
        const liveEnum = liveProp?.enum ?? liveProp?.items?.enum;
        expect(liveEnum, `${spec.name}.${prop} enum`).toEqual(catalogEnum);
      }
    }
  });

  it("serves the catalog's schemas verbatim, on both sides of every tool", async () => {
    // The wire used to advertise a zod-derived draft-07 input schema that
    // differed from the catalog, and no output schema at all. There is one
    // published contract now, so the listing must BE the catalog rather than a
    // lookalike: an edit to either has to move both.
    const client = await connect();
    const { tools } = await client.listTools();
    const live = new Map(tools.map((t) => [t.name, t]));

    for (const spec of catalog.tools) {
      const tool = live.get(spec.name);
      expect(tool?.inputSchema, `${spec.name} inputSchema`).toEqual(spec.inputSchema);
      // Without an advertised output schema a strict MCP client cannot validate
      // structured content at all, and the contract is enforced repo-side only.
      expect(tool?.outputSchema, `${spec.name} outputSchema`).toEqual(spec.outputSchema);
    }
  });

  it("serverInfo.version and the wire catalog version move together", async () => {
    const client = await connect();
    const serverVersion = client.getServerVersion();
    // The version a client negotiates against on the wire IS the catalog
    // version: held identical in schemas/mcp-tools.json and in the registry
    // listing's `_meta.ai.apature/catalog_version`. It tracks the tool contract,
    // not the release calendar, and is deliberately NOT the npm/release version.
    expect(serverVersion?.version).toBe(catalog.catalog_version);
    expect(manifest._meta["ai.apature/catalog_version"]).toBe(catalog.catalog_version);
  });

  it("the registry listing's top-level version is the release/package version", () => {
    // directory/server.json's top-level `version` is what the MCP Registry pins
    // to the published npm artifact, so it tracks the release version and must
    // equal the package version — a separate axis from the catalog version above.
    const pkg = readJson("packages/mcp-server/package.json") as unknown as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
});
