import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryReviewApplicationStore } from "./application-store.js";
import type { EngineClient } from "./engine-client.js";
import { MockEngineClient } from "./engine-client.js";
import { REVIEWS_CANCEL_SCOPE } from "./auth.js";
import { createMcpReviewServer } from "./server.js";
import { SyntheticEvidenceProvider } from "./synthetic-evidence.js";
import { SystemDnsResolver } from "./production-adapters.js";
import type { DnsResolver } from "./target-auth.js";
import type { EvidenceProvider } from "./evidence.js";

/**
 * The local composition root: a complete Bastion server with no credentials and
 * no database, which by default also needs no network and no judgment engine.
 *
 * It exists because the production root (`production.ts`) deliberately has no mock
 * fallback; it must never boot a server that answers with fixture judgments. This
 * one is explicit about being the opposite: with nothing configured, every
 * dependency is a local stand-in, so the PROTOCOL surface (tools, views, errors,
 * the panel round trip, the SSRF boundary, idempotency, rechecks) can be exercised
 * exactly as a real client would, while the JUDGMENT is a fixture.
 *
 * What is real here, always:
 *   - the MCP server, its tool catalog, input validation, and error taxonomy;
 *   - target authorization: canonicalization, verified-host lookup, and the full
 *     egress classification;
 *   - job lifecycle, idempotency, budgets, recheck rejection and throttling;
 *   - result shaping: views, multimedia content blocks, and the panel reducer.
 *
 * What is synthetic with nothing configured:
 *   - the review itself. `MockEngineClient` replays the golden engine fixture, so
 *     the findings describe a fictional pricing page, NOT the URL you passed.
 *     Pass `engine` (see `engine-runtime.ts`) to review the target for real.
 *   - DNS for the bundled demo host only. Every other host is resolved for real,
 *     because authorizing a host that was never looked up would make the egress
 *     classification theatre.
 *   - evidence crops. `SyntheticEvidenceProvider` encodes deterministic placeholder
 *     PNGs where the engine's annotated screenshots would be.
 */

/** The only host the local server will authorize. Nothing is ever fetched from it. */
export const LOCAL_ALLOWED_HOST = "preview.example.com";

/**
 * The address the stub resolver returns for the allowed host, the same one the
 * test suite uses. It is an ordinary public unicast address, which is the point:
 * `egress.ts` classifies it for real on every submit, and swapping it for a
 * loopback, RFC 1918, or IANA-reserved address makes the local server reject its
 * own target with `DNS_TARGET_PROHIBITED`. Nothing is ever fetched from it.
 */
export const LOCAL_RESOLVED_ADDRESS = "93.184.216.34";

export interface LocalReviewServerOptions {
  /** Extra hosts to treat as ownership-verified, e.g. for your own experiments. */
  allowedHosts?: readonly string[];
  /**
   * The critique backend. Defaults to the fixture engine, which is why this
   * server runs with no setup. `resolveEngineRuntime(process.env).create()`
   * returns a verdict-backed one when the environment configures it.
   */
  engine?: EngineClient;
  /**
   * DNS seam. Defaults to `createLocalDnsResolver()`: the bundled demo host is
   * answered from a constant, everything else goes to the system resolver.
   */
  resolver?: DnsResolver;
  /** Fixed clock, for a deterministic transcript. */
  now?: () => Date;
  /** Deterministic id generator, for a deterministic transcript. */
  newId?: (prefix: string) => string;
  /** Override the placeholder evidence; pass `null` for a no-evidence host. */
  evidence?: EvidenceProvider | null;
}

/**
 * The local server's DNS seam.
 *
 * `LOCAL_ALLOWED_HOST` is answered from `LOCAL_RESOLVED_ADDRESS` without a
 * lookup, so the bundled demo stays hermetic and makes no network call. Any
 * other host, including one you add through `allowedHosts`, is resolved by the
 * system resolver and then classified by `egress.ts` exactly as in production.
 * The alternative, returning the same fixed public address for every host,
 * would authorize a target nobody ever looked up and turn the SSRF boundary
 * into decoration the moment anyone configured a real one.
 */
export function createLocalDnsResolver(system: DnsResolver = new SystemDnsResolver()): DnsResolver {
  return {
    resolve: async (host: string): Promise<string[]> =>
      host === LOCAL_ALLOWED_HOST ? [LOCAL_RESOLVED_ADDRESS] : system.resolve(host),
  };
}

/**
 * Build the local server. Every request is treated as one authenticated
 * principal in a single local tenant that holds the `reviews:cancel` scope, so all
 * five tools are reachable without an OAuth issuer. With no `engine` it is fully
 * offline; pass one and the same server reviews the target for real.
 */
export function createLocalReviewServer(options: LocalReviewServerOptions = {}): McpServer {
  const hosts = [LOCAL_ALLOWED_HOST, ...(options.allowedHosts ?? [])];
  return createMcpReviewServer({
    engine: options.engine ?? new MockEngineClient(),
    store: new InMemoryReviewApplicationStore(),
    tenantId: "local",
    principalId: "local-agent",
    scopes: [REVIEWS_CANCEL_SCOPE],
    allowlist: { tenantId: "local", targets: hosts.map((host) => ({ kind: "host", host })) },
    resolver: options.resolver ?? createLocalDnsResolver(),
    // This server runs on the agent's own machine, so a loopback target is the
    // agent's own dev server: grant the plain-http loopback exception here. The
    // production hosted edge (production.ts) never sets this, so it keeps the
    // full SSRF guard and refuses a loopback target like any unverified host.
    allowLoopbackTargets: true,
    // The local host is assumed to render both surfaces, so the evidence view
    // exercises the image blocks AND the MCP-Apps panel rather than degrading.
    hostMedia: { images: true, appsPanel: true },
    ...(options.evidence === null ? {} : { evidence: options.evidence ?? new SyntheticEvidenceProvider() }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  });
}
