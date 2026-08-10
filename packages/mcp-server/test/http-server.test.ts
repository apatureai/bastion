import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionHttpServer,
  InMemoryReviewApplicationStore,
  MockEngineJobClient,
  type AllowlistResolver,
  type HttpResourceLimits,
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
      scopes: m[2] === "no-cancel" ? [] : ["reviews:cancel"],
      extra: { tenantId: m[1]! },
    };
  },
};

const allowlistResolver: AllowlistResolver = {
  async resolve(tenantId) {
    return { tenantId, targets: [{ kind: "host", host: "preview.example.com" }] };
  },
  async ready() { return true; },
};

const RESOURCE = "http://127.0.0.1";

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

async function start(options: {
  engineReady?: boolean;
  dnsReady?: boolean;
  httpLimits?: Partial<HttpResourceLimits>;
} = {}) {
  // The SDK validates the Host header (incl. port) against allowedHosts: the
  // DNS-rebinding defense. The bound port is only known after listen, so pass a
  // mutable array and register 127.0.0.1:<port> once it is known (in production
  // this is the fixed public origin, e.g. mcp.example.com).
  const allowedHosts: string[] = [];
  const built = createProductionHttpServer({
    verifier: fakeVerifier,
    allowlistResolver,
    dnsResolver: { resolve: async () => ["93.184.216.34"] },
    applicationStore: new InMemoryReviewApplicationStore(),
    engine: new MockEngineJobClient(),
    engineReady: async () => options.engineReady ?? true,
    dnsReady: async () => options.dnsReady ?? true,
    resourceUrl: RESOURCE,
    authorizationServers: ["https://auth.example.com"],
    allowedHosts,
    httpLimits: options.httpLimits,
  });
  running.push(built);
  await new Promise<void>((resolve) => built.server.listen(0, "127.0.0.1", resolve));
  const port = (built.server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  return { built, base: `http://127.0.0.1:${port}` };
}

async function postBytes(
  base: string,
  body: Buffer | string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(`${base}/mcp`);
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          authorization: "Bearer tok::acme::agent-1",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function openPartialRequest(base: string, token = "tok::acme::agent-1") {
  const url = new URL(base);
  const socket = createConnection(Number(url.port), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\n` +
      "Content-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return socket;
}

async function slowRequestStatus(base: string): Promise<number> {
  const socket = await openPartialRequest(base);
  return await new Promise((resolve, reject) => {
    let response = "";
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1])));
    socket.on("error", reject);
  });
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
    expect(meta.authorization_servers).toEqual(["https://auth.example.com"]);
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
      "design_review_panel_action",
    ]);
    const result = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "http-e2e-0001" },
    })) as { structuredContent?: { job?: { job_id?: string; status?: string } } };
    expect(result.structuredContent?.job?.status).toBe("running");
    const jobId = result.structuredContent?.job?.job_id;
    const completed = (await client.callTool({
      name: "design_review_get",
      arguments: { job_id: jobId },
    })) as { structuredContent?: { job?: { status?: string } } };
    expect(completed.structuredContent?.job?.status).toBe("completed");
  });

  it("enforces reviews:cancel from the authenticated principal", async () => {
    const { base } = await start();
    const { client } = await connect(base, "tok::acme::no-cancel");
    const submitted = (await client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "scope-e2e-0001" },
    })) as { structuredContent?: { job?: { job_id?: string } } };
    const denied = (await client.callTool({
      name: "design_review_cancel",
      arguments: { job_id: submitted.structuredContent?.job?.job_id },
    })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error?.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("isolates transports while a same-tenant reconnect recovers the durable product job", async () => {
    const { base } = await start();
    const a = await connect(base, "tok::acme::agent-a");
    const submitted = (await a.client.callTool({
      name: "design_review",
      arguments: { url: "https://preview.example.com/", client_request_id: "iso-a-0001" },
    })) as { structuredContent?: { job?: { job_id?: string } } };
    const jobId = submitted.structuredContent?.job?.job_id;
    expect(jobId).toBeTruthy();

    await a.transport.close();
    const replacement = await connect(base, "tok::acme::agent-a");
    const recovered = (await replacement.client.callTool({
      name: "design_review_get",
      arguments: { job_id: jobId },
    })) as { isError?: boolean; structuredContent?: { job?: { job_id?: string } } };
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent?.job?.job_id).toBe(jobId);

    // A different tenant still sees the same non-enumerating not-found result.
    const b = await connect(base, "tok::beta::agent-b");
    const got = (await b.client.callTool({
      name: "design_review_get",
      arguments: { job_id: jobId },
    })) as { isError?: boolean };
    expect(got.isError).toBe(true);
  });

  it("does not let another principal in the tenant drive an existing MCP session", async () => {
    const { base } = await start();
    const owner = await connect(base, "tok::acme::agent-owner");
    const sessionId = owner.transport.sessionId;
    expect(sessionId).toBeTruthy();

    const hijack = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer tok::acme::agent-other",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    expect(hijack.status).toBe(404);
    await expect(hijack.json()).resolves.toEqual({ error: "unknown_session" });
  });

  it("readyz reports the live session count and livez is always ok", async () => {
    const { base } = await start();
    expect((await (await fetch(`${base}/livez`)).json())).toEqual({ status: "ok" });
    await connect(base, "tok::acme::agent-z");
    const ready = (await (await fetch(`${base}/readyz`)).json()) as { sessions: number };
    expect(ready.sessions).toBeGreaterThanOrEqual(1);
  });

  it("fails readiness while a required production dependency is unavailable", async () => {
    const { base } = await start({ engineReady: false });
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: { store: true, engine: false, targets: true, dns: true },
    });
    expect((await fetch(`${base}/livez`)).status).toBe(200);
  });
});

describe("HTTP resource boundary (#42)", () => {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "limit-test", version: "1" },
    },
  });

  it("rejects an oversized declared length before opening a session", async () => {
    const { base, built } = await start({ httpLimits: { maxBodyBytes: 128 } });
    const response = await postBytes(base, "{}", { "content-length": "129" });
    expect(response.status).toBe(413);
    expect(built.metrics().rejectedRequests.body_too_large_declared).toBe(1);
    expect((await (await fetch(`${base}/readyz`)).json()) as { sessions: number })
      .toMatchObject({ sessions: 0 });
  });

  it("aborts an oversized chunked body while preserving the exact boundary", async () => {
    const { base, built } = await start({ httpLimits: { maxBodyBytes: 256 } });
    const tooLarge = await postBytes(base, Buffer.alloc(257, 0x20), {
      "transfer-encoding": "chunked",
    });
    expect(tooLarge.status).toBe(413);
    expect(built.metrics().rejectedRequests.body_too_large_streamed).toBe(1);

    const exact = initialize.padEnd(256, " ");
    expect(Buffer.byteLength(exact)).toBe(256);
    const accepted = await postBytes(base, exact);
    expect(accepted.status).toBe(200);
  });

  it("returns protocol parse errors for malformed UTF-8/JSON without echoing input", async () => {
    const { base, built } = await start();
    const response = await postBytes(base, Buffer.from([0xff, 0xfe, 0x7b]));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(response.body).not.toContain("Bearer");
    expect(built.metrics().rejectedRequests.invalid_json).toBe(1);
  });

  it("requires a JSON media type and never opens a session for a rejected body", async () => {
    const { base, built } = await start();
    const response = await postBytes(base, initialize, { "content-type": "text/plain" });
    expect(response.status).toBe(415);
    expect(built.metrics().rejectedRequests.unsupported_media_type).toBe(1);
    const ready = (await (await fetch(`${base}/readyz`)).json()) as { sessions: number };
    expect(ready.sessions).toBe(0);
  });

  it("times out an incomplete body and closes the rejected connection", async () => {
    const { base, built } = await start({
      httpLimits: { bodyReadTimeoutMs: 50, requestTimeoutMs: 100, headersTimeoutMs: 50 },
    });
    await expect(slowRequestStatus(base)).resolves.toBe(408);
    expect(built.metrics().rejectedRequests.body_timeout).toBe(1);
  });

  it("isolates in-flight saturation by verified tenant/principal", async () => {
    const { base, built } = await start({
      httpLimits: {
        maxInFlightPerPrincipal: 1,
        bodyReadTimeoutMs: 500,
        requestTimeoutMs: 1_000,
        headersTimeoutMs: 500,
      },
    });
    const held = await openPartialRequest(base);
    const saturated = await postBytes(base, initialize);
    expect(saturated.status).toBe(429);

    const independent = await postBytes(base, initialize, {
      authorization: "Bearer tok::beta::agent-1",
    });
    expect(independent.status).toBe(200);
    expect(built.metrics().rejectedRequests.in_flight_saturated).toBe(1);
    held.destroy();
  });

  it("stays available to another tenant during 100 concurrent over-limit uploads", async () => {
    const { base, built } = await start({
      httpLimits: { maxBodyBytes: 1_024, maxInFlightPerPrincipal: 64 },
    });
    const rssBefore = process.memoryUsage().rss;
    const body = Buffer.alloc(64 * 1_024, 0x78);
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => postBytes(base, body)),
    );
    expect(responses.every((response) => response.status === 413 || response.status === 429))
      .toBe(true);
    expect(built.metrics().rejectedRequests.body_too_large_declared).toBeGreaterThan(0);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(96 * 1_024 * 1_024);

    const independent = await postBytes(base, initialize, {
      authorization: "Bearer tok::beta::agent-2",
    });
    expect(independent.status).toBe(200);
  });

  it("applies documented Node HTTP timeout and keep-alive settings", async () => {
    const { built } = await start({
      httpLimits: {
        requestTimeoutMs: 2_000,
        headersTimeoutMs: 1_000,
        keepAliveTimeoutMs: 750,
        maxRequestsPerSocket: 25,
      },
    });
    expect(built.server.requestTimeout).toBe(2_000);
    expect(built.server.headersTimeout).toBe(1_000);
    expect(built.server.keepAliveTimeout).toBe(750);
    expect(built.server.maxRequestsPerSocket).toBe(25);
  });

  it("enforces hard configuration ceilings", () => {
    expect(() => createProductionHttpServer({
      verifier: fakeVerifier,
      allowlistResolver,
      dnsResolver: { resolve: async () => ["93.184.216.34"] },
      applicationStore: new InMemoryReviewApplicationStore(),
      engine: new MockEngineJobClient(),
      engineReady: async () => true,
      dnsReady: async () => true,
      resourceUrl: RESOURCE,
      authorizationServers: ["https://auth.example.com"],
      httpLimits: { maxBodyBytes: 1024 * 1024 + 1 },
    })).toThrow(/hard limit/);
  });
});
