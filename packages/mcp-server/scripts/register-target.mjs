#!/usr/bin/env node
import { Client } from "pg";

/**
 * Register (and mark verified) a review target host for a tenant, in HTTP /
 * production mode.
 *
 * The HTTP edge authorizes a target only if a row for its host exists in
 * `mcp_review_targets` (migrations/002_review_targets.sql) whose ownership
 * verification has completed. Bastion reads that table; it does not yet issue or
 * check the DNS / well-known / deployment proofs that put a row there (roadmap
 * item 5, "Domain-ownership verification"). Until a proof issuer exists, this is
 * the documented, supported way to make a host reviewable: the operator, who
 * controls the database, asserts ownership out of band and records it here. That
 * is what a `DOMAIN_UNVERIFIED` rejection with `next_action: "verify_domain"`
 * points at.
 *
 * It mirrors the production adapter's RLS discipline: it binds `app.tenant_id`
 * for the transaction so the row is written under the same row-level-security
 * policy the server reads it under.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     node packages/mcp-server/scripts/register-target.mjs \
 *       --tenant <tenant_id> --host <hostname> [--kind host] [--method operator-asserted]
 *
 * The host must be a bare hostname (no scheme, no path, no port), the same form
 * the target authorizer canonicalizes an incoming URL's host to.
 */

function parseArgs(argv) {
  const args = { kind: "host", method: "operator-asserted" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`malformed argument near "${key ?? ""}"`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

const VALID_KINDS = new Set(["host", "github_deployment", "provider_project"]);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const args = parseArgs(process.argv.slice(2));
  const tenant = args.tenant;
  const host = args.host;
  if (!tenant || !host) {
    throw new Error("both --tenant and --host are required");
  }
  if (/[:/]/.test(host) || host !== host.toLowerCase()) {
    throw new Error(`--host must be a bare, lowercased hostname (got "${host}")`);
  }
  if (!VALID_KINDS.has(args.kind)) {
    throw new Error(`--kind must be one of ${[...VALID_KINDS].join(", ")}`);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Same RLS binding the server uses on every read of this table, so the
    // INSERT satisfies the tenant-isolation policy's WITH CHECK.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await client.query(
      `INSERT INTO mcp_review_targets (tenant_id, host, kind, verified_at, verification_method)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (tenant_id, host)
       DO UPDATE SET verified_at = now(), verification_method = EXCLUDED.verification_method, kind = EXCLUDED.kind`,
      [tenant, host, args.kind, args.method],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  process.stdout.write(
    `verified target registered: tenant=${tenant} host=${host} kind=${args.kind} method=${args.method}\n` +
      `${host} is now reviewable for ${tenant}; a design_review of an https://${host}/... URL will pass the DOMAIN_UNVERIFIED gate.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`register-target failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
