import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionHttpServer,
  type AllowlistResolver,
  type TokenVerifier,
} from "../src/index.js";

/** A verifier that accepts `token::<tenant>::<client>` and rejects everything else. */
const fakeVerifier: TokenVerifier = {
  async verify(token: string): Promise<AuthInfo | null> {
    const m = /^tok::([^:]+)::([^:]+)$/.exec(token);
    if (!m) return null;
    return {
      token,
      clientId: m[2]!,
      scopes: ["reviews:cancel"],
      extra: { tenantId: m[1]! },
    };
  },
};

const allowlistResolver: AllowlistResolver = {
  async resolve(tenantId) {
    return { tenantId, targets: [{ kind: "host", host: "preview.example.com" }] };
  },
};

const RESOURCE = "http://127.0.0.1";

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

async function start() {
  // The SDK validates the Host header (incl. port) against allowedHosts — the
  // DNS-rebinding defense. The bound port is only known after listen, so pass a
  // mutable array and register 127.0.0.1:<port> once it is known (in production
  // this is the fixed public origin, e.g. mcp.apature.ai).
  const allowedHosts: string[] = [];
  const built = createProductionHttpServer({
    verifier: fakeVerifier,
    allowlistResolver,
    dnsResolver: { resolve: async () => ["93.184.216.34"] },
    resourceUrl: RESOURCE,
    authorizationServers: ["https://auth.apature.ai"],
    allowedHosts,
  });
  running.push(built);
  await new Promise<void>((resolve) => built.server.listen(0, "127.0.0.1", resolve));
  const port = (built.server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  return { built, base: `http://127.0.0.1:${port}` };
}

async function connect(base: string, token: string | null) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

describe("production HTTP MCP server (#28)", () => {
  it("serves RFC 9728 protected-resource metadata unauthenticated", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.resource).toBe(RESOURCE);
    expect(meta.authorization_servers).toEqual(["https://auth.apature.ai"]);
    expect(meta.scopes_supported).toContain("reviews:cancel");
  });

  it("answers 401 with a WWW-Authenticate PRM pointer when the token is absent or invalid", async () => {
    const { base } = await start();
    for (const auth of [{}, { authorization: "Bearer garbage" }]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    }
  });

  it("authenticated client initializes, lists tools, and runs a review end to end", async () => {
    const { base } = await start();
    const { client } = await connect(base, "tok::acme::agent-1");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "design_recheck",
      "design_review",
      "design_review_cancel",
      "design_review_get",
    ]);
    const result = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "http-e2e-0001" },
    })) as { structuredContent?: { job?: { status?: string } } };
    expect(result.structuredContent?.job?.status).toBe("completed");
  });

  it("gives each client its OWN session; a second client cannot see the first's job (CVE-2026-25536)", async () => {
    const { base } = await start();
    const a = await connect(base, "tok::acme::agent-a");
    const b = await connect(base, "tok::beta::agent-b");
    const submitted = (await a.client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "iso-a-0001" },
    })) as { structuredContent?: { job?: { job_id?: string } } };
    const jobId = submitted.structuredContent?.job?.job_id;
    expect(jobId).toBeTruthy();

    // Tenant B's own session has no record of tenant A's job.
    const got = (await b.client.callTool({
      name: "design_review_get",
      arguments: { job_id: jobId },
    })) as { isError?: boolean };
    expect(got.isError).toBe(true);
  });

  it("readyz reports the live session count and livez is always ok", async () => {
    const { base } = await start();
    expect((await (await fetch(`${base}/livez`)).json())).toEqual({ status: "ok" });
    await connect(base, "tok::acme::agent-z");
    const ready = (await (await fetch(`${base}/readyz`)).json()) as { sessions: number };
    expect(ready.sessions).toBeGreaterThanOrEqual(1);
  });
});
