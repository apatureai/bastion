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
  /** Health of the real Verdict dependency. */
  engineReady: () => Promise<boolean>;
  /** Optional DNS adapter probe; absence is not assumed healthy. */
  dnsReady: () => Promise<boolean>;
  /** This server's canonical resource identifier (RFC 8707/9728), e.g. https://mcp.example.com. */
  resourceUrl: string;
  /** Issuer URLs a client obtains a token from (PRM `authorization_servers`). */
  authorizationServers: readonly string[];
  /** MCP endpoint path. Default `/mcp`. */
  mcpPath?: string;
  /**
   * Hostnames permitted in the Host header, the SDK's DNS-rebinding defense
   * (MCP security guidance). Default: derived from `resourceUrl`'s host.
   */
  allowedHosts?: readonly string[];
  now?: () => Date;
  newId?: (prefix: string) => string;
  logger?: Pick<Console, "info" | "error">;
  /** Resource limits enforced before the MCP SDK sees an authenticated request. */
  httpLimits?: Partial<HttpResourceLimits>;
}

export interface HttpResourceLimits {
  maxBodyBytes: number;
  bodyReadTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxRequestsPerSocket: number;
  maxInFlightPerPrincipal: number;
}

export interface HttpResourceMetrics {
  inFlight: number;
  rejectedBytes: number;
  rejectedRequests: Readonly<Record<HttpRejectionReason, number>>;
}

export type HttpRejectionReason =
  | "body_too_large_declared"
  | "body_too_large_streamed"
  | "body_timeout"
  | "invalid_json"
  | "unsupported_media_type"
  | "in_flight_saturated";

export const MAX_MCP_BODY_BYTES = 1024 * 1024;
export const MAX_IN_FLIGHT_PER_PRINCIPAL = 64;
export const DEFAULT_HTTP_RESOURCE_LIMITS: HttpResourceLimits = {
  maxBodyBytes: 256 * 1024,
  bodyReadTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100,
  maxInFlightPerPrincipal: 8,
};

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
 *  - **Per-client transport isolation.** Every session gets its OWN
 *    `McpServer` + `StreamableHTTPServerTransport`, keyed by the session id and
 *    torn down on close. Instances are NEVER shared across clients, which is
 *    the direct mitigation for CVE-2026-25536 (cross-client response leakage
 *    from shared server/transport instances).
 *  - **Bearer auth as a protected resource.** No token, or an invalid one, is
 *    401 with a `WWW-Authenticate` challenge pointing at the RFC 9728
 *    protected-resource metadata; the verified tenant scopes the session's
 *    review service.
 *  - **No product state in sessions.** Durable reviews live in the per-tenant
 *    `ReviewService` (application store), keyed by product job ids; the MCP
 *    session is only transport routing, so a dropped/reconnected session never
 *    loses or crosses a review.
 *  - **DNS-rebinding protection.** The SDK validates the Host header against
 *    `allowedHosts`.
 *
 * Every infra dependency (token verifier, allowlist resolver, DNS resolver) is
 * injected, so this is testable end to end over real HTTP with fakes and never
 * touches a real IdP or network.
 */
export function createProductionHttpServer(config: ProductionHttpConfig): {
  server: Server;
  close(): Promise<void>;
  metrics(): HttpResourceMetrics;
} {
  const mcpPath = config.mcpPath ?? "/mcp";
  const allowedHosts = config.allowedHosts ?? [new URL(config.resourceUrl).host];
  const resourceMetadataUrl = new URL(PRM_PATH, config.resourceUrl).toString();
  const log = config.logger ?? console;
  const sessions = new Map<string, Session>();
  const limits = resolveHttpLimits(config.httpLimits);
  const inFlightByPrincipal = new Map<string, number>();
  const rejectedRequests: Record<HttpRejectionReason, number> = {
    body_too_large_declared: 0,
    body_too_large_streamed: 0,
    body_timeout: 0,
    invalid_json: 0,
    unsupported_media_type: 0,
    in_flight_saturated: 0,
  };
  let inFlight = 0;
  let rejectedBytes = 0;

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const declared = contentLength(req);
    if (declared !== undefined && declared > limits.maxBodyBytes) {
      throw new BodyReadError("body_too_large_declared", 413, declared);
    }

    const raw = await readBoundedBody(req, limits.maxBodyBytes, limits.bodyReadTimeoutMs);
    if (raw.length === 0) return undefined;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      return JSON.parse(text);
    } catch {
      throw new BodyReadError("invalid_json", 400, raw.length);
    }
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
      // Never forward exception messages/stacks: SDK/application errors may
      // contain tool arguments or page text. The error class is sufficient for
      // DLP-safe aggregation; request correlation belongs in trace context.
      log.error("mcp http handler error", {
        errorType: err instanceof Error ? err.name : "unknown",
      });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;

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

    const release = acquirePrincipalSlot(principal);
    if (!release) {
      recordRejection("in_flight_saturated", 0);
      sendJson(
        res,
        429,
        { error: "too_many_requests", error_description: "too many in-flight requests" },
        { "retry-after": "1" },
      );
      return;
    }

    try {
      await handleAuthenticated(req, res, principal);
    } finally {
      release();
    }
  }

  async function handleAuthenticated(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
  ): Promise<void> {
    if (req.method === "POST" && !isJsonMediaType(req.headers["content-type"])) {
      recordRejection("unsupported_media_type", contentLength(req) ?? 0);
      drainRejectedRequest(req);
      sendJson(
        res,
        415,
        { error: "unsupported_media_type", error_description: "POST requires application/json" },
        { connection: "close" },
      );
      return;
    }

    const sessionId = headerValue(req.headers[SESSION_HEADER]);

    // Existing session: route to its OWN transport, but only if the token's
    // tenant matches the session's tenant, so a token can never drive another
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
      const body = req.method === "POST" ? await readBodyOrRespond(req, res) : undefined;
      if (req.method === "POST" && body === BODY_REJECTED) return;
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No session id: only a POST initialize may open one.
    if (req.method !== "POST") {
      sendJson(res, 400, { error: "missing_session", error_description: "mcp-session-id header required" });
      return;
    }
    const body = await readBodyOrRespond(req, res);
    if (body === BODY_REJECTED) return;
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { error: "not_initialized", error_description: "first request must be initialize" });
      return;
    }
    const transport = await openSession(principal);
    await transport.handleRequest(req, res, body);
  }

  const BODY_REJECTED = Symbol("body-rejected");

  async function readBodyOrRespond(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<unknown | typeof BODY_REJECTED> {
    try {
      return await readJsonBody(req);
    } catch (error) {
      if (!(error instanceof BodyReadError)) throw error;
      recordRejection(error.reason, error.rejectedBytes);
      drainRejectedRequest(req);
      if (error.reason === "invalid_json") {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
      } else {
        sendJson(
          res,
          error.status,
          {
            error: error.status === 413 ? "payload_too_large" : "request_timeout",
          },
          { connection: "close" },
        );
      }
      return BODY_REJECTED;
    }
  }

  function acquirePrincipalSlot(principal: Principal): (() => void) | undefined {
    const key = `${principal.tenantId}\0${principal.clientId}`;
    const current = inFlightByPrincipal.get(key) ?? 0;
    if (current >= limits.maxInFlightPerPrincipal) return undefined;
    inFlightByPrincipal.set(key, current + 1);
    inFlight += 1;
    return () => {
      const remaining = (inFlightByPrincipal.get(key) ?? 1) - 1;
      if (remaining === 0) inFlightByPrincipal.delete(key);
      else inFlightByPrincipal.set(key, remaining);
      inFlight -= 1;
    };
  }

  function recordRejection(reason: HttpRejectionReason, bytes: number): void {
    rejectedRequests[reason] += 1;
    rejectedBytes = Math.min(Number.MAX_SAFE_INTEGER, rejectedBytes + Math.max(0, bytes));
  }

  function metrics(): HttpResourceMetrics {
    return {
      inFlight,
      rejectedBytes,
      rejectedRequests: { ...rejectedRequests },
    };
  }

  return {
    server,
    metrics,
    async close(): Promise<void> {
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => {});
      }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class BodyReadError extends Error {
  constructor(
    readonly reason: Extract<
      HttpRejectionReason,
      "body_too_large_declared" | "body_too_large_streamed" | "body_timeout" | "invalid_json"
    >,
    readonly status: 400 | 408 | 413,
    readonly rejectedBytes: number,
  ) {
    super(reason);
  }
}

function resolveHttpLimits(overrides: Partial<HttpResourceLimits> | undefined): HttpResourceLimits {
  const limits = { ...DEFAULT_HTTP_RESOURCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`http limit ${name} must be a positive safe integer`);
    }
  }
  if (limits.maxBodyBytes > MAX_MCP_BODY_BYTES) {
    throw new Error(`maxBodyBytes exceeds hard limit ${MAX_MCP_BODY_BYTES}`);
  }
  if (limits.maxInFlightPerPrincipal > MAX_IN_FLIGHT_PER_PRINCIPAL) {
    throw new Error(
      `maxInFlightPerPrincipal exceeds hard limit ${MAX_IN_FLIGHT_PER_PRINCIPAL}`,
    );
  }
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
    throw new Error("headersTimeoutMs must not exceed requestTimeoutMs");
  }
  return limits;
}

function contentLength(req: IncomingMessage): number | undefined {
  const value = headerValue(req.headers["content-length"]);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isJsonMediaType(value: string | string[] | undefined): boolean {
  const raw = headerValue(value);
  if (!raw) return false;
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.match(/^application\/[a-z0-9!#$&^_.+-]+\+json$/));
}

function drainRejectedRequest(req: IncomingMessage): void {
  if (!req.complete && !req.destroyed) req.resume();
}

function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const fail = (error: BodyReadError | Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        fail(new BodyReadError("body_too_large_streamed", 413, total));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onAborted = (): void => fail(new Error("request aborted"));
    const onError = (error: Error): void => fail(error);
    const timer = setTimeout(
      () => fail(new BodyReadError("body_timeout", 408, total)),
      timeoutMs,
    );
    timer.unref();
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
