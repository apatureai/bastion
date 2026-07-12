import { describe, expect, it } from "vitest";
import type { EngineReviewResult } from "@apature/mcp-types";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import {
  InMemoryReviewApplicationStore,
  JobExpiredError,
  JobNotFoundError,
  ReviewService,
  type EngineClient,
  type EngineRecheckRequest,
} from "../src/index.js";

class CountingEngine implements EngineClient {
  submissions = 0;

  async review(): Promise<EngineReviewResult> {
    this.submissions++;
    await Promise.resolve();
    return loadGoldenEngineResult();
  }

  async recheck(request: EngineRecheckRequest) {
    return {
      beforeFingerprint: request.beforeFingerprint,
      afterFingerprint: request.afterFingerprint,
      captureScope: "focused" as const,
      outcomes: request.findings.map((finding) => ({
        findingId: finding.findingId,
        outcome: "passed" as const,
        confidence: 1,
        reason: "fixture",
      })),
    };
  }
}

class DeferredEngine extends CountingEngine {
  private release!: (result: EngineReviewResult) => void;
  private readonly pending = new Promise<EngineReviewResult>((resolve) => { this.release = resolve; });

  override async review(): Promise<EngineReviewResult> {
    this.submissions++;
    return this.pending;
  }

  override async cancel() {
    return { accepted: true, poll: { state: "failed" as const, error: "canceled" } };
  }

  completeLate(): void { this.release(loadGoldenEngineResult()); }
}

function service(store: InMemoryReviewApplicationStore, engine: EngineClient, tenantId: string, principalId: string) {
  let sequence = 0;
  return new ReviewService({
    store,
    engine,
    tenantId,
    principalId,
    now: () => new Date("2026-07-11T20:00:00.000Z"),
    newId: (prefix) => `${prefix}_${principalId}_${++sequence}`,
  });
}

describe("durable ReviewApplication store (#36)", () => {
  it("survives session/service replacement for the same tenant", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new CountingEngine();
    const first = service(store, engine, "tenant-a", "agent-a");
    const submitted = await first.submitReview({ url: "https://preview.example.com", client_request_id: "restart-0001" });

    const replacement = service(store, engine, "tenant-a", "agent-a");
    const recovered = await replacement.getReview(submitted.job.job_id);
    expect(recovered.review?.review_id).toBeTruthy();
    expect(engine.submissions).toBe(1);
  });

  it("does not disclose a job to another tenant", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new CountingEngine();
    const owner = service(store, engine, "tenant-a", "agent-a");
    const submitted = await owner.submitReview({ url: "https://preview.example.com", client_request_id: "tenant-0001" });
    const other = service(store, engine, "tenant-b", "agent-b");
    await expect(other.getReview(submitted.job.job_id)).rejects.toBeInstanceOf(JobNotFoundError);
    await expect(other.cancelReview(submitted.job.job_id)).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it("does not disclose or cancel another principal's job within the tenant", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new CountingEngine();
    const owner = service(store, engine, "tenant-a", "agent-a");
    const submitted = await owner.submitReview({ url: "https://preview.example.com", client_request_id: "principal-0001" });
    const other = service(store, engine, "tenant-a", "agent-b");
    await expect(other.getReview(submitted.job.job_id)).rejects.toBeInstanceOf(JobNotFoundError);
    await expect(other.cancelReview(submitted.job.job_id)).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it("returns an explicit expiry error instead of serving retained stale state", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new CountingEngine();
    let now = new Date("2026-07-11T20:00:00.000Z");
    const app = new ReviewService({ store, engine, tenantId: "tenant-a", principalId: "agent-a", now: () => now });
    const submitted = await app.submitReview({ url: "https://preview.example.com", client_request_id: "expiry-0001" });
    now = new Date("2026-07-12T20:00:00.001Z");
    await expect(app.getReview(submitted.job.job_id)).rejects.toBeInstanceOf(JobExpiredError);
  });

  it("linearizes 10,000 replica races to one engine submission", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new CountingEngine();
    const replicas = Array.from({ length: 8 }, () => service(store, engine, "tenant-a", "agent-a"));
    const results = await Promise.all(
      Array.from({ length: 10_000 }, (_, i) =>
        replicas[i % replicas.length]!.submitReview({
          url: "https://preview.example.com/path",
          client_request_id: "race-10000",
        }),
      ),
    );
    expect(engine.submissions).toBe(1);
    expect(new Set(results.map((result) => result.job.job_id))).toHaveLength(1);
  });

  it("uses one store transition to suppress a result that arrives after cancellation", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new DeferredEngine();
    const app = service(store, engine, "tenant-a", "agent-a");
    const submitting = app.submitReview({ url: "https://preview.example.com", client_request_id: "cancel-race-1" });
    await Promise.resolve();
    await Promise.resolve();
    const record = await store.findByRequest("tenant-a", "cancel-race-1");
    expect(record?.job.status).toBe("running");
    const cancelled = await app.cancelReview(record!.job.job_id);
    expect(cancelled.status).toBe("cancelled");
    engine.completeLate();
    const submitted = await submitting;
    expect(submitted.job.status).toBe("cancelled");
    expect((await app.getReview(record!.job.job_id)).review).toBeUndefined();
  });
});
