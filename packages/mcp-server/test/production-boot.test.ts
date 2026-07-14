import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { bootProduction, type ProductionHandle } from "../src/production.js";
import type { SqlConnection, SqlConnectionFactory } from "../src/postgres-store.js";

function pgliteFactory(db: PGlite): SqlConnectionFactory & { end(): Promise<void> } {
  const connection: SqlConnection = {
    query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      if (params && params.length > 0) {
        const result = await db.query(sql, [...params]);
        return { rows: result.rows as Row[] };
      }
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
    release: () => undefined,
  };
  return { connect: async () => connection, end: async () => db.close() };
}

const port = () => 30_000 + Math.floor(Math.random() * 20_000);

function productionEnv(p: number): NodeJS.ProcessEnv {
  return {
    MCP_RESOURCE_URL: "https://mcp.apature.test",
    MCP_AUTHORIZATION_SERVERS: "https://auth.apature.test",
    MCP_JWKS_URL: "https://auth.apature.test/jwks",
    MCP_TOKEN_ISSUER: "https://auth.apature.test",
    PORT: String(p),
    ENGINE_BASE_URL: "https://engine.internal.apature.test",
    ENGINE_HMAC_SECRET: "test-secret",
  };
}

const silent = { info: () => undefined, error: () => undefined };

let handle: ProductionHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("bootProduction (#36)", () => {
  it("fails fast on missing application-plane configuration", async () => {
    const env = productionEnv(port());
    delete env.ENGINE_HMAC_SECRET;
    await expect(bootProduction({ env, logger: silent })).rejects.toThrow(/ENGINE_HMAC_SECRET/);
    await expect(
      bootProduction({ env: { ...productionEnv(port()), DATABASE_URL: undefined }, logger: silent }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it("boots the durable plane, migrates, and reports honest readiness end to end", async () => {
    const p = port();
    let engineUp = true;
    const engineFetch: typeof fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/readyz")) {
        return new Response(engineUp ? "ok" : "down", { status: engineUp ? 200 : 503 });
      }
      return new Response("not found", { status: 404 });
    };

    handle = await bootProduction({
      connectionFactory: pgliteFactory(new PGlite()),
      fetchImpl: engineFetch,
      dnsResolver: { resolve: async () => ["93.184.216.34"] },
      env: productionEnv(p),
      logger: silent,
    });
    expect(handle.port).toBe(p);

    // Liveness is process-only; readiness proves store + engine + targets + DNS.
    const livez = await fetch(`http://127.0.0.1:${p}/livez`);
    expect(livez.status).toBe(200);
    const readyz = await fetch(`http://127.0.0.1:${p}/readyz`);
    expect(readyz.status).toBe(200);
    const body = (await readyz.json()) as { checks: Record<string, boolean> };
    expect(body.checks).toEqual({ store: true, engine: true, targets: true, dns: true });

    // Engine outage degrades readiness without killing the process.
    engineUp = false;
    const degraded = await fetch(`http://127.0.0.1:${p}/readyz`);
    expect(degraded.status).toBe(503);
    const degradedBody = (await degraded.json()) as { checks: Record<string, boolean> };
    expect(degradedBody.checks.engine).toBe(false);
    expect(degradedBody.checks.store).toBe(true);

    engineUp = true;
    expect((await fetch(`http://127.0.0.1:${p}/readyz`)).status).toBe(200);
  });

  it("treats a definitive name-absent DNS answer as a usable resolver", async () => {
    const p = port();
    const enotfound = Object.assign(new Error("queryA ENOTFOUND engine.internal"), { code: "ENOTFOUND" });
    handle = await bootProduction({
      connectionFactory: pgliteFactory(new PGlite()),
      fetchImpl: async () => new Response("ok", { status: 200 }),
      dnsResolver: { resolve: async () => { throw enotfound; } },
      env: productionEnv(p),
      logger: silent,
    });
    const readyz = await fetch(`http://127.0.0.1:${p}/readyz`);
    expect(readyz.status).toBe(200);

    await handle.close();
    // A resolver *failure* (timeout) reads not-ready.
    const p2 = port();
    const timeout = Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" });
    handle = await bootProduction({
      connectionFactory: pgliteFactory(new PGlite()),
      fetchImpl: async () => new Response("ok", { status: 200 }),
      dnsResolver: { resolve: async () => { throw timeout; } },
      env: productionEnv(p2),
      logger: silent,
    });
    const degraded = await fetch(`http://127.0.0.1:${p2}/readyz`);
    expect(degraded.status).toBe(503);
    expect(((await degraded.json()) as { checks: Record<string, boolean> }).checks.dns).toBe(false);
  });
});
