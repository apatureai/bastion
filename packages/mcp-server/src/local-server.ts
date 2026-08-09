import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryReviewApplicationStore } from "./application-store.js";
import { MockEngineClient } from "./engine-client.js";
import { REVIEWS_CANCEL_SCOPE } from "./auth.js";
import { createMcpReviewServer } from "./server.js";
import { SyntheticEvidenceProvider } from "./synthetic-evidence.js";
import type { EvidenceProvider } from "./evidence.js";

/**
 * The offline composition root: a complete MCP Review server with no credentials,
 * no database, no network, and no judgment engine.
 *
 * It exists because the production root (`production.ts`) deliberately has no mock
 * fallback — it must never boot a server that answers with fixture judgments. This
 * one is explicit about being the opposite: every dependency is a local stand-in,
 * so the PROTOCOL surface (tools, views, errors, the panel round trip, the SSRF
 * boundary, idempotency, rechecks) can be exercised exactly as a real client would,
 * while the JUDGMENT is a fixture.
 *
 * What is real here:
 *   - the MCP server, its tool catalog, input validation, and error taxonomy;
 *   - target authorization — canonicalization, verified-host lookup, and the full
 *     egress classification, all running on the synthetic host below;
 *   - job lifecycle, idempotency, budgets, recheck rejection and throttling;
 *   - result shaping: views, multimedia content blocks, and the panel reducer.
 *
 * What is synthetic here:
 *   - the review itself. `MockEngineClient` replays the golden engine fixture, so
 *     the findings describe a fictional pricing page, NOT the URL you passed.
 *   - DNS. The resolver returns one fixed public address without a lookup, so the
 *     process makes no network calls; the classification code still runs on it.
 *   - evidence crops. `SyntheticEvidenceProvider` encodes deterministic placeholder
 *     PNGs where the engine's annotated screenshots would be.
 */

/** The only host the local server will authorize. Nothing is ever fetched from it. */
export const LOCAL_ALLOWED_HOST = "preview.example.com";

/**
 * The address the stub resolver returns for the allowed host — the same one the
 * test suite uses. It is an ordinary public unicast address, which is the point:
 * `egress.ts` classifies it for real on every submit, and swapping it for a
 * loopback, RFC 1918, or IANA-reserved address makes the local server reject its
 * own target with `DNS_TARGET_PROHIBITED`. Nothing is ever fetched from it.
 */
export const LOCAL_RESOLVED_ADDRESS = "93.184.216.34";

export interface LocalReviewServerOptions {
  /** Extra hosts to treat as ownership-verified, e.g. for your own experiments. */
  allowedHosts?: readonly string[];
  /** Fixed clock, for a deterministic transcript. */
  now?: () => Date;
  /** Deterministic id generator, for a deterministic transcript. */
  newId?: (prefix: string) => string;
  /** Override the placeholder evidence; pass `null` for a no-evidence host. */
  evidence?: EvidenceProvider | null;
}

/**
 * Build the offline server. Every request is treated as one authenticated
 * principal in a single local tenant that holds the `reviews:cancel` scope, so all
 * five tools are reachable without an OAuth issuer.
 */
export function createLocalReviewServer(options: LocalReviewServerOptions = {}): McpServer {
  const hosts = [LOCAL_ALLOWED_HOST, ...(options.allowedHosts ?? [])];
  return createMcpReviewServer({
    engine: new MockEngineClient(),
    store: new InMemoryReviewApplicationStore(),
    tenantId: "local",
    principalId: "local-agent",
    scopes: [REVIEWS_CANCEL_SCOPE],
    allowlist: { tenantId: "local", targets: hosts.map((host) => ({ kind: "host", host })) },
    resolver: { resolve: async () => [LOCAL_RESOLVED_ADDRESS] },
    // The local host is assumed to render both surfaces, so the evidence view
    // exercises the image blocks AND the MCP-Apps panel rather than degrading.
    hostMedia: { images: true, appsPanel: true },
    ...(options.evidence === null ? {} : { evidence: options.evidence ?? new SyntheticEvidenceProvider() }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  });
}
