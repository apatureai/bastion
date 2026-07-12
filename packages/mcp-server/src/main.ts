import { createRemoteJWKSet } from "jose";
import { createProductionHttpServer, type AllowlistResolver } from "./http-server.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import type { DnsResolver } from "./target-auth.js";
import type { ReviewApplicationStore } from "./application-store.js";
import type { EngineJobClient } from "./engine-client.js";

/**
 * Deployable remote MCP Review entrypoint (#28). Reads configuration from the
 * environment, wires the production Streamable HTTP composition (per-client
 * transport isolation, bearer JWT auth, RFC 9728 discovery, DNS-rebinding
 * protection), and starts listening. Fails fast on missing required config so a
 * misconfigured deployment never serves an unauthenticated or unscoped surface.
 *
 * Required env:
 *   MCP_RESOURCE_URL           this server's public resource id (aud), e.g. https://mcp.apature.ai
 *   MCP_AUTHORIZATION_SERVERS  comma-separated issuer URLs for PRM discovery
 *   MCP_JWKS_URL               the issuer's JWKS endpoint (token signature keys)
 *   MCP_TOKEN_ISSUER           expected token `iss`
 * Optional:
 *   PORT (8080), MCP_PATH (/mcp), MCP_ALLOWED_HOSTS (comma list; default resource host)
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

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required environment variable ${key}`);
  return value;
}

export async function startFromEnv(deps: MainDeps): Promise<{ close(): Promise<void>; port: number }> {
  const env = deps.env ?? process.env;
  const log = deps.logger ?? console;

  const resourceUrl = required(env, "MCP_RESOURCE_URL");
  const authorizationServers = required(env, "MCP_AUTHORIZATION_SERVERS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const jwksUrl = required(env, "MCP_JWKS_URL");
  const issuer = required(env, "MCP_TOKEN_ISSUER");
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  const mcpPath = env.MCP_PATH ?? "/mcp";
  const allowedHosts = (env.MCP_ALLOWED_HOSTS ?? new URL(resourceUrl).host)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const verifier = createJwtVerifier({
    keySource: createRemoteJWKSet(new URL(jwksUrl)),
    issuer,
    audience: resourceUrl,
  });

  const { server, close } = createProductionHttpServer({
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

  return { close, port };
}

// Boot when run as the container entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    "mcp-review requires an injected durable application store, Judgment Engine client, " +
      "ownership-verified target store, and sandboxed DNS resolver; refusing placeholder startup",
  );
  process.exit(1);
}
