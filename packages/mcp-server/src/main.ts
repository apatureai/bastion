import { createRemoteJWKSet } from "jose";
import {
  createProductionHttpServer,
  type AllowlistResolver,
  type HttpResourceMetrics,
} from "./http-server.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import type { DnsResolver } from "./target-auth.js";
import type { ReviewApplicationStore } from "./application-store.js";
import type { EngineJobClient } from "./engine-client.js";
import { requiredEnv } from "./env.js";

/**
 * Deployable remote Bastion entrypoint (#28). Reads configuration from the
 * environment, wires the production Streamable HTTP composition (per-client
 * transport isolation, bearer JWT auth, RFC 9728 discovery, DNS-rebinding
 * protection), and starts listening. Fails fast on missing required config so a
 * misconfigured deployment never serves an unauthenticated or unscoped surface.
 *
 * Required env:
 *   MCP_RESOURCE_URL           this server's public resource id (aud), e.g. https://mcp.example.com
 *   MCP_AUTHORIZATION_SERVERS  comma-separated issuer URLs for PRM discovery
 *   MCP_JWKS_URL               the issuer's JWKS endpoint (token signature keys)
 *   MCP_TOKEN_ISSUER           expected token `iss`
 * Optional:
 *   PORT (8080), MCP_PATH (/mcp), MCP_ALLOWED_HOSTS (comma list; default resource host)
 *   MCP_MAX_BODY_BYTES (262144), MCP_BODY_TIMEOUT_MS (30000),
 *   MCP_MAX_IN_FLIGHT_PER_PRINCIPAL (8)
 *
 * `allowlistResolver`/`dnsResolver` are injected by the caller in production
 * (they front the tenant target store and the sandboxed DNS resolver); this
 * module owns only transport/auth composition, not those infra clients.
 */

export interface MainDeps {
  allowlistResolver: AllowlistResolver;
  dnsResolver: DnsResolver;
  applicationStore: ReviewApplicationStore;
  engine: EngineJobClient;
  engineReady: () => Promise<boolean>;
  dnsReady: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "info" | "error">;
}


function optionalPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

export async function startFromEnv(deps: MainDeps): Promise<{
  close(): Promise<void>;
  metrics(): HttpResourceMetrics;
  port: number;
}> {
  const env = deps.env ?? process.env;
  const log = deps.logger ?? console;

  const resourceUrl = requiredEnv(env, "MCP_RESOURCE_URL");
  const authorizationServers = requiredEnv(env, "MCP_AUTHORIZATION_SERVERS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const jwksUrl = requiredEnv(env, "MCP_JWKS_URL");
  const issuer = requiredEnv(env, "MCP_TOKEN_ISSUER");
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  const mcpPath = env.MCP_PATH ?? "/mcp";
  const allowedHosts = (env.MCP_ALLOWED_HOSTS ?? new URL(resourceUrl).host)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxBodyBytes = optionalPositiveInt(env, "MCP_MAX_BODY_BYTES");
  const bodyReadTimeoutMs = optionalPositiveInt(env, "MCP_BODY_TIMEOUT_MS");
  const maxInFlightPerPrincipal = optionalPositiveInt(
    env,
    "MCP_MAX_IN_FLIGHT_PER_PRINCIPAL",
  );

  const verifier = createJwtVerifier({
    keySource: createRemoteJWKSet(new URL(jwksUrl)),
    issuer,
    audience: resourceUrl,
  });

  const { server, close, metrics } = createProductionHttpServer({
    verifier,
    allowlistResolver: deps.allowlistResolver,
    dnsResolver: deps.dnsResolver,
    applicationStore: deps.applicationStore,
    engine: deps.engine,
    engineReady: deps.engineReady,
    dnsReady: deps.dnsReady,
    resourceUrl,
    authorizationServers,
    mcpPath,
    allowedHosts,
    httpLimits: {
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
      ...(bodyReadTimeoutMs !== undefined ? { bodyReadTimeoutMs } : {}),
      ...(maxInFlightPerPrincipal !== undefined ? { maxInFlightPerPrincipal } : {}),
    },
    logger: log,
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  log.info(`mcp-review listening on :${port}${mcpPath} (resource ${resourceUrl})`);

  const shutdown = async (): Promise<void> => {
    log.info("mcp-review shutting down");
    await close();
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));

  return { close, metrics, port };
}

// The process entrypoint lives in `boot.ts`, not here: `production.ts` imports
// `startFromEnv` from this module, so a boot guard in this file would form an
// ESM cycle whose top-level await never settles when `main.js` is the entry.
