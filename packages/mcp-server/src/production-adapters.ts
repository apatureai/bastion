import { resolve4, resolve6 } from "node:dns/promises";
import type { AllowlistResolver } from "./http-server.js";
import type { SqlConnectionFactory } from "./postgres-store.js";
import type { DnsResolver, TenantAllowlist, VerifiedTarget } from "./target-auth.js";

/**
 * Production target-allowlist adapter (#36): reads the ownership-verified
 * registry (migrations/002_review_targets.sql). Only rows whose verification
 * completed are served — an unverified registration never authorizes capture
 * (TRD §7.2). Every read binds `app.tenant_id` for RLS, matching the
 * application store's transaction discipline.
 */
export class PostgresAllowlistResolver implements AllowlistResolver {
  constructor(private readonly pool: SqlConnectionFactory) {}

  async resolve(tenantId: string): Promise<TenantAllowlist> {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await connection.query<{ kind: VerifiedTarget["kind"]; host: string }>(
        `SELECT kind, host FROM mcp_review_targets
         WHERE tenant_id = $1 AND verified_at IS NOT NULL
         ORDER BY host`,
        [tenantId],
      );
      await connection.query("COMMIT");
      return {
        tenantId,
        targets: result.rows.map((row) => ({ kind: row.kind, host: row.host })),
      };
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  /** Usable = the registry table exists and answers; empty is a valid state. */
  async ready(): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      await connection.query("SELECT 1 FROM mcp_review_targets LIMIT 0");
      return true;
    } catch {
      return false;
    } finally {
      connection.release();
    }
  }
}

/**
 * Production DNS adapter (#36): resolves A + AAAA records through the host's
 * configured resolver. Target authorization then classifies every returned
 * address against the egress denylist (target-auth.ts), so a poisoned or
 * rebinding answer is rejected there — this adapter only observes.
 */
export class SystemDnsResolver implements DnsResolver {
  async resolve(host: string): Promise<string[]> {
    const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
    const addresses = [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
    if (addresses.length === 0) {
      // Re-throw the original error so callers can distinguish "resolver
      // answered, name absent" (ENOTFOUND/ENODATA) from "resolver unusable".
      if (v4.status === "rejected") throw v4.reason;
      if (v6.status === "rejected") throw v6.reason;
      throw new Error(`DNS resolution returned no addresses for ${host}`);
    }
    return [...new Set(addresses)];
  }
}
