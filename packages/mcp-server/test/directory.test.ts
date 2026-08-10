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

  it("advertises no remote endpoint, because none is operated", () => {
    // No public host runs this server. A `remotes` entry in a registry listing
    // is machine-read: publishing one we do not operate points every client
    // that installs the listing at a host that never answers. The deployment
    // shape lives in _meta as documentation instead, and a self-hoster moves it
    // into `remotes` with their own host. If this repo ever operates an
    // endpoint, assert the live URL here rather than deleting the test.
    expect(manifest.remotes).toBeUndefined();
  });

  it("documents the self-hosted remote as a template with a placeholder host", () => {
    const meta = manifest._meta as Record<string, unknown>;
    const template = meta["ai.apature/self_hosted_remote_template"] as {
      type: string;
      url: string;
      headers: Array<Record<string, unknown>>;
    };
    expect(template).toBeDefined();
    expect(template.type).toBe("streamable-http");
    expect(template.url.startsWith("https://")).toBe(true);
    // A placeholder, never a hostname a client could actually dial.
    expect(template.url).toContain("<your-mcp-host>");
    const auth = template.headers.find((h) => h.name === "Authorization");
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
