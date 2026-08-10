import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ListToolsResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * `schemas/mcp-tools.json` as the one published contract, served verbatim on the
 * wire.
 *
 * The SDK derives a tool's advertised `inputSchema` from its Zod shape and
 * advertises no `outputSchema` at all unless one is registered as Zod. That left
 * two problems. The wire served a laxer, draft-07-shaped input schema that
 * differed from the catalog, so there were two published contracts and only one
 * of them was checked. And with no `outputSchema` on the wire, a strict MCP
 * client could not validate structured content itself: the output contract was
 * enforced repo-side, by our own tests, and nowhere a client could reach.
 *
 * So the listing is served from the catalog file that the schema-conformance
 * test validates every payload against. There is exactly one source of truth for
 * what a client is told, the file, and one for what the server parses, the Zod
 * shapes in `tools.ts`; the conformance test drives real calls through both and
 * fails if they disagree. Prose and behavior hints still come from the
 * registration in `server.ts`, so an edit there is what a client sees.
 *
 * Sibling of both `src` and `dist`, like `MCP_MIGRATIONS_DIR`, so this resolves
 * whether the server runs from TypeScript under vitest or from built JavaScript.
 */
export const TOOL_CATALOG_PATH = fileURLToPath(
  new URL("../../../schemas/mcp-tools.json", import.meta.url),
);

/** A JSON Schema document, carried verbatim from the catalog to the wire. */
export type JsonSchemaDocument = Record<string, unknown>;

interface CatalogEntry {
  name: string;
  inputSchema: JsonSchemaDocument;
  outputSchema: JsonSchemaDocument;
}

interface CatalogFile {
  catalog_version: string;
  protocol_baseline: string;
  tools: CatalogEntry[];
}

const catalog = JSON.parse(readFileSync(TOOL_CATALOG_PATH, "utf8")) as CatalogFile;
const entries = new Map(catalog.tools.map((tool) => [tool.name, tool]));

/** The catalog version, which the drift gate pins to the server version. */
export const TOOL_CATALOG_VERSION = catalog.catalog_version;

function entry(name: string): CatalogEntry {
  const found = entries.get(name);
  if (found === undefined) {
    throw new Error(`no entry for tool ${name} in ${TOOL_CATALOG_PATH}`);
  }
  return found;
}

/** The published input schema for a tool, exactly as the wire advertises it. */
export function catalogInputSchema(name: string): JsonSchemaDocument {
  return entry(name).inputSchema;
}

/** The published output schema for a tool, exactly as the wire advertises it. */
export function catalogOutputSchema(name: string): JsonSchemaDocument {
  return entry(name).outputSchema;
}

/**
 * The listing metadata a tool is registered with. Prose and behavior hints stay
 * in code; only the schemas come from the catalog.
 */
export interface ToolListing {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  _meta: Record<string, unknown>;
}

/** A tool's listing metadata before it is bound to a name. */
export type ToolListingMetadata = Omit<ToolListing, "name">;

/**
 * Replace `tools/list` so every advertised tool carries the catalog's own
 * `inputSchema` and `outputSchema`.
 *
 * Both directions are checked at construction time: a registered tool with no
 * catalog entry, or a catalog entry no tool registers, throws before the server
 * can serve a listing. That is the property the wire could not have before, and
 * it fails at boot rather than at some client's first strict validation.
 *
 * The SDK documents `setRequestHandler` as replacing any previous handler for
 * the same method, and the tools capability is already registered by the time
 * the first tool is registered, so this is a supported override rather than a
 * reach into SDK internals.
 */
export function advertiseCatalogSchemas(server: McpServer, registered: readonly ToolListing[]): void {
  const registeredNames = new Set(registered.map((tool) => tool.name));
  for (const name of entries.keys()) {
    if (!registeredNames.has(name)) {
      throw new Error(`${TOOL_CATALOG_PATH} advertises ${name}, which no tool registers`);
    }
  }

  const tools: Tool[] = registered.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: catalogInputSchema(tool.name) as Tool["inputSchema"],
    outputSchema: catalogOutputSchema(tool.name) as Tool["outputSchema"],
    annotations: tool.annotations,
    // What the SDK emits for a tool registered with a plain callback. Kept so
    // the listing stays byte-identical to the one it produced.
    execution: { taskSupport: "forbidden" },
    _meta: tool._meta,
  }));

  server.server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({ tools }));
}
