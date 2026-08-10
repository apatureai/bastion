import type { HttpResourceMetrics } from "./http-server.js";
import { JudgmentEngineHttpClient } from "./engine-http-client.js";
import { startFromEnv } from "./main.js";
import { PgPoolConnectionFactory, runMcpMigrations } from "./pg.js";
import { PostgresReviewApplicationStore, type SqlConnectionFactory } from "./postgres-store.js";
import { PostgresAllowlistResolver, SystemDnsResolver } from "./production-adapters.js";
import type { DnsResolver } from "./target-auth.js";
import { requiredEnv } from "./env.js";

/**
 * Production composition root (#36): constructs the durable application plane
 * (Postgres store + migrations), the signed Judgment Engine async client, the
 * ownership-verified target registry, and the system DNS resolver, then starts
 * the Streamable HTTP transport via `startFromEnv`. Missing configuration or an
 * unusable database fails startup, never a green-but-unusable listener;
 * engine/target/DNS health degrade through /readyz instead (they can recover
 * without a restart).
 *
 * Required env (on top of main.ts's MCP_* transport/auth set):
 *   DATABASE_URL         Postgres for the durable review application plane
 *   ENGINE_BASE_URL      Judgment Engine async job API origin
 *   ENGINE_HMAC_SECRET   shared secret for signed service-to-service calls
 *
 * `overrides` exist for black-box tests (PGlite-backed factory, stubbed engine
 * fetch, stubbed DNS). Production callers pass nothing.
 */
export interface ProductionOverrides {
  connectionFactory?: SqlConnectionFactory & { end?(): Promise<void> };
  fetchImpl?: typeof fetch;
  dnsResolver?: DnsResolver;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "info" | "error">;
}

export interface ProductionHandle {
  close(): Promise<void>;
  metrics(): HttpResourceMetrics;
  port: number;
}


export async function bootProduction(overrides: ProductionOverrides = {}): Promise<ProductionHandle> {
  const env = overrides.env ?? process.env;
  const logger = overrides.logger ?? console;

  const engineBaseUrl = requiredEnv(env, "ENGINE_BASE_URL");
  const engineHmacSecret = requiredEnv(env, "ENGINE_HMAC_SECRET");
  const factory =
    overrides.connectionFactory ?? new PgPoolConnectionFactory(requiredEnv(env, "DATABASE_URL"));

  // An unusable database is a startup failure, not a degraded-ready state: the
  // durable plane is the point of this composition.
  const applied = await runMcpMigrations(factory);
  if (applied.length > 0) logger.info(`mcp-review migrations applied: ${applied.join(", ")}`);

  const applicationStore = new PostgresReviewApplicationStore(factory);
  const allowlistResolver = new PostgresAllowlistResolver(factory);
  const dnsResolver = overrides.dnsResolver ?? new SystemDnsResolver();
  const engine = new JudgmentEngineHttpClient({
    baseUrl: engineBaseUrl,
    hmacSecret: engineHmacSecret,
    ...(overrides.fetchImpl ? { fetch: overrides.fetchImpl } : {}),
  });

  // The probe asks: is the resolver itself usable? A definitive "name absent"
  // answer (ENOTFOUND/ENODATA, e.g. an internal engine hostname not in public
  // DNS) still proves the resolver works; only resolver failure reads not-ready.
  const engineHost = new URL(engineBaseUrl).hostname;
  const dnsReady = async (): Promise<boolean> => {
    try {
      return (await dnsResolver.resolve(engineHost)).length > 0;
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === "ENOTFOUND" || code === "ENODATA";
    }
  };

  const handle = await startFromEnv({
    allowlistResolver,
    dnsResolver,
    applicationStore,
    engine,
    engineReady: () => engine.ready(),
    dnsReady,
    env,
    logger,
  });

  return {
    port: handle.port,
    metrics: handle.metrics,
    close: async () => {
      await handle.close();
      await factory.end?.();
    },
  };
}
