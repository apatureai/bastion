import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The directory listing (issue #6) is what gets submitted to the Claude Code,
 * Cursor, and VS Code tool directories. It must stay consistent with the tool
 * catalog so the published listing never advertises tools the server does not
 * expose (or omits ones it does). Resolved from the repo root.
 */
const repoRoot = new URL("../../../", import.meta.url);
const readJson = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, repoRoot)), "utf8")) as Record<string, unknown>;

describe("directory/server.json listing", () => {
  const manifest = readJson("directory/server.json");
  const catalog = readJson("schemas/mcp-tools.json") as {
    catalog_version: string;
    protocol_baseline: string;
    tools: Array<{ name: string }>;
  };

  it("declares the namespaced server name and a semver version", () => {
    expect(manifest.name).toBe("ai.apature/mcp-review");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("advertises a single Streamable HTTP remote with an https URL", () => {
    const remotes = manifest.remotes as Array<{ type: string; url: string }>;
    expect(Array.isArray(remotes)).toBe(true);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.type).toBe("streamable-http");
    expect(remotes[0]?.url.startsWith("https://")).toBe(true);
  });

  it("requires a secret Authorization header", () => {
    const remote = (manifest.remotes as Array<{ headers: Array<Record<string, unknown>> }>)[0]!;
    const auth = remote.headers.find((h) => h.name === "Authorization");
    expect(auth).toBeDefined();
    expect(auth?.isRequired).toBe(true);
    expect(auth?.isSecret).toBe(true);
  });

  it("advertises exactly the tools in the catalog", () => {
    const meta = manifest._meta as Record<string, unknown>;
    const listed = meta["ai.apature/tools"] as string[];
    const catalogNames = catalog.tools.map((t) => t.name).sort();
    expect([...listed].sort()).toEqual(catalogNames);
  });

  it("pins the same protocol baseline and catalog version as the catalog", () => {
    const meta = manifest._meta as Record<string, unknown>;
    expect(meta["ai.apature/protocol_baseline"]).toBe(catalog.protocol_baseline);
    expect(meta["ai.apature/catalog_version"]).toBe(catalog.catalog_version);
  });

  it("states the read-only customer boundary", () => {
    const meta = manifest._meta as Record<string, unknown>;
    const boundary = String(meta["ai.apature/read_only_boundary"]).toLowerCase();
    expect(boundary).toContain("never edits code");
  });
});
