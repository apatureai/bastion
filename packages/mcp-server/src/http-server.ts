import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  authenticate,
  protectedResourceMetadata,
  wwwAuthenticate,
  type Principal,
  type TokenVerifier,
} from "./auth.js";
import { createMcpReviewServer } from "./server.js";
import type { DnsResolver, TenantAllowlist } from "./target-auth.js";
import type { ReviewApplicationStore } from "./application-store.js";
import type { EngineJobClient } from "./engine-client.js";

/** Resolve a tenant's ownership-verified target allowlist (issue #4). Injected. */
export interface AllowlistResolver {
  resolve(tenantId: string): Promise<TenantAllowlist>;
  ready?(): Promise<boolean>;
}

export interface ProductionHttpConfig {
  verifier: TokenVerifier;
  allowlistResolver: AllowlistResolver;
  dnsResolver: DnsResolver;
  applicationStore: ReviewApplicationStore;
  /** Production engine adapter. Required so the protocol root can never default to MockEngineClient. */
  engine: EngineJobClient;
  /** Health of the real Judgment Engine dependency. */
  engineReady: () => Promise<boolean>;
  /** Optional DNS adapter probe; absence is not assumed healthy. */
  dnsReady: () => Promise<boolean>;
  /** This server's canonical resource identifier (RFC 8707/9728), e.g. https://mcp.apature.ai. */
  resourceUrl: string;
  /** Issuer URLs a client obtains a token from (PRM `authorization_servers`). */
  authorizationServers: readonly string[];
  /** MCP endpoint path. Default `/mcp`. */
  mcpPath?: string;
  /**
   * Hostnames permitted in the Host header — the SDK's DNS-rebinding defense
   * (MCP security guidance). Default: derived from `resourceUrl`'s host.
   */
  allowedHosts?: readonly string[];
  now?: () => Date;
  newId?: (prefix: string) => string;
  logger?: Pick<Console, "info" | "error">;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  tenantId: string;
  principalId: string;
}

const SESSION_HEADER = "mcp-session-id";
const PRM_PATH = "/.well-known/oauth-protected-resource";

/**
 * Production remote MCP composition root (#28). Serves Streamable HTTP with:
 *
 *  - **Per-client transport isolation** — every session gets its OWN
 *    `McpServer` + `StreamableHTTPServerTransport`, keyed by the session id and
 *    torn down on close. Instances are NEVER shared across clients, which is
 *    the direct mitigation for CVE-2026-25536 (cross-client response leakage
 *    from shared server/transport instances).
 *  - **Bearer auth as a protected resource** — no token, or an invalid one, is
 *    401 with a `WWW-Authenticate` challenge pointing at the RFC 9728
 *    protected-resource metadata; the verified tenant scopes the session's
 *    review service.
 *  - **No product state in sessions** — durable reviews live in the per-tenant
 *    `ReviewService` (application store), keyed by product job ids; the MCP
 *    session is only transport routing, so a dropped/reconnected session never
 *    loses or crosses a review.
 *  - **DNS-rebinding protection** — the SDK validates the Host header against
 *    `allowedHosts`.
 *
 * Every infra dependency (token verifier, allowlist resolver, DNS resolver) is
 * injected, so this is testable end to end over real HTTP with fakes and never
 * touches a real IdP or network.
 */
export function createProductionHttpServer(config: ProductionHttpConfig): {
  server: Server;
  close(): Promise<void>;
} {
  const mcpPath = config.mcpPath ?? "/mcp";
  const allowedHosts = config.allowedHosts ?? [new URL(config.resourceUrl).host];
  const resourceMetadataUrl = new URL(PRM_PATH, config.resourceUrl).toString();
  const log = config.logger ?? console;
  const sessions = new Map<string, Session>();

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length === 0) return undefined;
    return JSON.parse(raw);
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(payload);
  }

  function unauthorized(res: ServerResponse): void {
    // Non-enumerating: absent and invalid tokens get the identical challenge.
    sendJson(
      res,
      401,
      { error: "unauthorized", error_description: "a valid bearer access token is required" },
      { "www-authenticate": wwwAuthenticate(resourceMetadataUrl) },
    );
  }

  /** Build a fresh, isolated server+transport for a newly initialized session. */
  async function openSession(principal: Principal): Promise<StreamableHTTPServerTransport> {
    const allowlist = await config.allowlistResolver.resolve(principal.tenantId);
    const server = createMcpReviewServer({
      allowlist,
      resolver: config.dnsResolver,
      principalId: principal.clientId,
      tenantId: principal.tenantId,
      store: config.applicationStore,
      engineJobs: config.engine,
      scopes: principal.scopes,
      ...(config.now ? { now: config.now } : {}),
      ...(config.newId ? { newId: config.newId } : {}),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [...allowedHosts],
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          server,
          transport,
          tenantId: principal.tenantId,
          principalId: principal.clientId,
        });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    await server.connect(transport);
    return transport;
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log.error("mcp http handler error", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Discovery + health are unauthenticated.
    if (req.method === "GET" && url.pathname === PRM_PATH) {
      sendJson(res, 200, protectedResourceMetadata(config.resourceUrl, config.authorizationServers));
      return;
    }
    if (req.method === "GET" && url.pathname === "/livez") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/readyz") {
      const checks = {
        store: await config.applicationStore.ready().catch(() => false),
        engine: await config.engineReady().catch(() => false),
        targets: config.allowlistResolver.ready
          ? await config.allowlistResolver.ready().catch(() => false)
          : false,
        dns: await config.dnsReady().catch(() => false),
      };
      const ready = Object.values(checks).every(Boolean);
      sendJson(res, ready ? 200 : 503, { status: ready ? "ok" : "not_ready", checks, sessions: sessions.size });
      return;
    }
    if (url.pathname !== mcpPath) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    // Every MCP request is authenticated.
    const principal = await authenticate(config.verifier, req.headers.authorization);
    if (!principal) {
      unauthorized(res);
      return;
    }

    const sessionId = headerValue(req.headers[SESSION_HEADER]);

    // Existing session: route to its OWN transport, but only if the token's
    // tenant matches the session's tenant — a token can never drive another
    // tenant's session.
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: "unknown_session" });
        return;
      }
      if (session.tenantId !== principal.tenantId || session.principalId !== principal.clientId) {
        // Non-enumerating: same shape as an unknown session.
        sendJson(res, 404, { error: "unknown_session" });
        return;
      }
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No session id: only a POST initialize may open one.
    if (req.method !== "POST") {
      sendJson(res, 400, { error: "missing_session", error_description: "mcp-session-id header required" });
      return;
    }
    const body = await readJsonBody(req);
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { error: "not_initialized", error_description: "first request must be initialize" });
      return;
    }
    const transport = await openSession(principal);
    await transport.handleRequest(req, res, body);
  }

  return {
    server,
    async close(): Promise<void> {
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => {});
      }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
