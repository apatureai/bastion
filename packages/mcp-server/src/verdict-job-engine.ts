import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import type { EngineClient, EngineJobClient, EngineRecheckRequest } from "./engine-client.js";
import { EngineDependencyError } from "./engine-http-client.js";
import { parseEngineReviewResult } from "./engine-result.js";
import type { NormalizedReviewRequest } from "./normalize.js";

/**
 * Critique backend #2: a running `verdict` deployment, over its HMAC-signed
 * async job API.
 *
 * Bastion already had the wire client for that API (`JudgmentEngineHttpClient`,
 * an `EngineJobClient`: submit, poll, cancel), but only the production HTTP
 * composition root could use it, and that root additionally requires Postgres,
 * an OAuth issuer and a verified-target registry. This bridge exposes the same
 * client through the synchronous `EngineClient` interface, so the local stdio
 * server, which is what a person actually runs, can be pointed at a verdict
 * deployment with two environment variables.
 *
 * It submits once and polls to a terminal state. That is a deliberate
 * narrowing: the durable path in `review-service.ts` keeps the engine job id
 * across transport sessions and is the right shape for a hosted deployment;
 * this one holds the review open for the length of one tool call, which is what
 * a local, single-user server can do without a database.
 *
 * Honest status: this speaks verdict's documented contract (same routes, same
 * `x-gate-*` signing, same `x-schema-version` gate) and is tested against a
 * stub server, but the two programs have not been run against each other end to
 * end, because verdict's long-running service requires a `CAPTURE_ENDPOINT`
 * capture fleet that repository does not implement. Until that exists, the CLI
 * backend in `verdict-cli-engine.ts` is the one that produces real judgments.
 */

export interface VerdictJobEngineOptions {
  /** The signed submit/poll/cancel client, usually `JudgmentEngineHttpClient`. */
  jobs: EngineJobClient;
  /** Tenant the engine scopes every job to; it is bound into the request signature. */
  installationId: string;
  /** Gap between polls. Default 2s. */
  pollIntervalMs?: number;
  /** Ceiling on one review before the job is cancelled and the call fails. Default 15m. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class VerdictJobEngineClient implements EngineClient {
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly options: VerdictJobEngineOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.log = options.log ?? ((): void => undefined);
  }

  async review(request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    const { jobs, installationId } = this.options;
    // The caller's idempotency key is reused verbatim: a retried tool call must
    // land on the same engine job rather than paying for a second capture.
    const jobId = await jobs.submit(installationId, request.client_request_id, request);
    this.log(`verdict: engine job ${jobId} submitted for ${request.url}`);
    const deadline = this.now() + this.timeoutMs;

    for (;;) {
      const poll = await jobs.get(installationId, jobId);
      if (poll.state === "completed") {
        return parseEngineReviewResult(poll.result, `verdict job ${jobId}`);
      }
      if (poll.state === "failed") {
        throw new EngineDependencyError(`verdict job ${jobId} failed: ${poll.error}`);
      }
      if (this.now() >= deadline) {
        // Best effort: stop paying for work nobody will read. A cancel that
        // cannot be delivered must not mask the timeout that caused it.
        await jobs.cancel(installationId, jobId).catch(() => false);
        throw new EngineDependencyError(
          `verdict job ${jobId} did not finish within ${this.timeoutMs}ms (last state ${poll.state})`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Not available from this backend, for the same reason as the CLI one:
   * verdict's job API has no recheck route, and synthesizing per-finding
   * pass/fail from a second full review would be a guess presented as a
   * verdict.
   */
  async recheck(_request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    throw new EngineDependencyError(
      "the verdict job API backend cannot recheck individual findings: verdict exposes no recheck " +
        "route. Submit a new design_review against the changed target instead.",
    );
  }
}
