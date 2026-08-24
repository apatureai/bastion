import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { bootDevHttp } from "../src/dev-http.js";

/**
 * The local remote-edge walkthrough (`pnpm dev:http`): the same Streamable HTTP
 * + OAuth 2.1 transport, verifier, and SSRF boundary the production root serves,
 * composed against a fixture engine and an in-memory store so it runs with no
 * database, no real IdP, and no model.
 *
 * It exists because the production root has no fixture fallback and refuses to
 * boot without real infrastructure, which left the remote surface un-runnable
 * offline. This proves the walkthrough boots, rejects an unauthenticated
 * request, verifies a real minted token, serves the tools authenticated, and
 * still enforces the SSRF boundary — the wiring the README sells.
 */

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of running.splice(0)) await h.close();
});

async function boot() {
  const port = await freePort();
  const handle = await bootDevHttp({ env: { PORT: String(port) }, logger: { info() {}, error() {} } });
  running.push(handle);
  return handle;
}

async function connectAuthed(mcpUrl: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "dev-http-test", version: "0" });
  running.push({ close: () => client.close() });
  await client.connect(transport);
  return client;
}

describe("bootDevHttp (pnpm dev:http)", () => {
  it("rejects an unauthenticated client", async () => {
    const handle = await boot();
    const transport = new StreamableHTTPClientTransport(new URL(handle.mcpUrl), { requestInit: {} });
    const client = new Client({ name: "dev-http-test", version: "0" });
    running.push({ close: () => client.close() });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("verifies a real minted token and serves the tools authenticated", async () => {
    const handle = await boot();
    const client = await connectAuthed(handle.mcpUrl, handle.token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "design_recheck",
      "design_review",
      "design_review_cancel",
      "design_review_get",
      "design_review_panel_action",
    ]);
  });

  it("still enforces the SSRF boundary on an unverified host", async () => {
    const handle = await boot();
    const client = await connectAuthed(handle.mcpUrl, handle.token);
    const denied = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://evil.example.org/", client_request_id: "dev-http-ssrf" },
    })) as { isError?: boolean; structuredContent?: { error?: { code?: string; next_action?: string } } };
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error?.code).toBe("DOMAIN_UNVERIFIED");
  });

  it("authorizes the seeded target host end to end", async () => {
    const handle = await boot();
    expect(handle.allowedTargetHosts).toContain("preview.example.com");
    const client = await connectAuthed(handle.mcpUrl, handle.token);
    const submitted = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/pricing", client_request_id: "dev-http-ok" },
    })) as { isError?: boolean; structuredContent?: { job?: { job_id?: string } } };
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent?.job?.job_id).toMatch(/^job_/);
  });
});
