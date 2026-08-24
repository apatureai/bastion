import type { AddressInfo } from "node:net";
import { createRemoteJWKSet } from "jose";
import { InMemoryReviewApplicationStore } from "./application-store.js";
import { MockEngineJobClient } from "./engine-client.js";
import { createProductionHttpServer, type AllowlistResolver } from "./http-server.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import { startDevIssuer, type DevIssuer } from "./dev-issuer.js";
import { LOCAL_RESOLVED_ADDRESS } from "./local-server.js";
import type { DnsResolver, TenantAllowlist } from "./target-auth.js";

/**
 * The remote (Streamable HTTP + OAuth 2.1) edge, wired for local development.
 *
 * `production.ts` deliberately refuses to boot without a real issuer JWKS, a
 * Postgres application plane, and a real judgment engine, and it deliberately
 * has no fixture fallback — a server that answers with fixture judgments must be
 * an explicit local one, never a misconfigured production one. That safety
 * property is exactly what left the remote surface un-runnable offline: the
 * OAuth/session/job wiring the README sells could not be exercised without
 * standing up an issuer and a database first.
 *
 * This is the explicit local one. It composes the SAME transport, the SAME
 * `createJwtVerifier` (verifying real ES256 tokens against a real JWKS the dev
 * issuer serves over HTTP), the SAME SSRF boundary, and the SAME submit-and-poll
 * job path used by the HTTP edge, against a fixture engine and an in-memory
 * store. Every judgment is a fixture, and it says so in `provenance`, exactly
 * like `pnpm demo`. It is never imported by `production.ts`.
 *
 * Configuration (all optional, all with dev defaults):
 *   PORT                   listener port (default 8080)
 *   MCP_PATH               MCP endpoint path (default /mcp)
 *   MCP_RESOURCE_URL       this server's resource id / token aud (default http://127.0.0.1:<port>)
 *   BASTION_ALLOWED_HOSTS  comma-separated verified hosts (default preview.example.com)
 *   DEV_TENANT_ID          the tenant the printed token is for (default dev-tenant)
 *   DEV_CLIENT_ID          the client id the printed token carries (default dev-agent)
 */

export interface DevHttpOverrides {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "info" | "error">;
}

export interface DevHttpHandle {
  /** The MCP endpoint an HTTP client connects to. */
  mcpUrl: string;
  /** A freshly minted bearer token for the configured dev tenant. */
  token: string;
  /** The dev issuer (JWKS + on-demand token minting). */
  issuer: DevIssuer;
  /** The hosts this server will authorize as review targets. */
  allowedTargetHosts: string[];
  port: number;
  close(): Promise<void>;
}

/** Every allowed target host resolves to one public address; the rest go unanswered. */
function devDnsResolver(hosts: readonly string[]): DnsResolver {
  const known = new Set(hosts);
  return {
    resolve: async (host: string): Promise<string[]> => {
      if (known.has(host)) return [LOCAL_RESOLVED_ADDRESS];
      throw Object.assign(new Error(`no dev DNS record for ${host}`), { code: "ENOTFOUND" });
    },
  };
}

/** A single-tenant-agnostic allowlist: every tenant sees the same seeded hosts. */
function devAllowlistResolver(hosts: readonly string[]): AllowlistResolver {
  return {
    resolve: async (tenantId: string): Promise<TenantAllowlist> => ({
      tenantId,
      targets: hosts.map((host) => ({ kind: "host", host })),
    }),
    ready: async () => true,
  };
}

export async function bootDevHttp(overrides: DevHttpOverrides = {}): Promise<DevHttpHandle> {
  const env = overrides.env ?? process.env;
  const logger = overrides.logger ?? console;

  const port = Number.parseInt(env.PORT ?? "8080", 10);
  const mcpPath = env.MCP_PATH ?? "/mcp";
  const host = "127.0.0.1";
  const resourceUrl = env.MCP_RESOURCE_URL ?? `http://${host}:${port}`;
  const allowedTargetHosts = (env.BASTION_ALLOWED_HOSTS ?? "preview.example.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tenantId = env.DEV_TENANT_ID ?? "dev-tenant";
  const clientId = env.DEV_CLIENT_ID ?? "dev-agent";

  const issuer = await startDevIssuer({ audience: resourceUrl, host });

  const verifier = createJwtVerifier({
    keySource: createRemoteJWKSet(new URL(issuer.jwksUrl)),
    issuer: issuer.issuer,
    audience: resourceUrl,
  });

  // Known before listen, so no post-listen mutation is needed: the Host-header
  // rebind defense permits exactly the resource origin.
  const allowedHosts = [new URL(resourceUrl).host];

  const built = createProductionHttpServer({
    verifier,
    allowlistResolver: devAllowlistResolver(allowedTargetHosts),
    dnsResolver: devDnsResolver(allowedTargetHosts),
    applicationStore: new InMemoryReviewApplicationStore(),
    engine: new MockEngineJobClient(),
    engineReady: async () => true,
    dnsReady: async () => true,
    resourceUrl,
    authorizationServers: [issuer.issuer],
    mcpPath,
    allowedHosts,
    logger,
  });

  await new Promise<void>((resolve) => built.server.listen(port, host, resolve));
  const boundPort = (built.server.address() as AddressInfo).port;
  const token = await issuer.mint({ tenantId, clientId });
  const mcpUrl = `${resourceUrl}${mcpPath}`;

  return {
    mcpUrl,
    token,
    issuer,
    allowedTargetHosts,
    port: boundPort,
    close: async () => {
      await built.close();
      await issuer.close();
    },
  };
}
