import { describe, expect, it } from "vitest";
import type { EngineReviewResult } from "@apatureai/bastion-types";
import { loadGoldenEngineResult } from "@apatureai/bastion-types";
import {
  InMemoryReviewApplicationStore,
  InsufficientScopeError,
  JobExpiredError,
  JobNotFoundError,
  ReviewService,
  type EngineClient,
  type EngineJobClient,
  type EngineJobPoll,
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

class ControlledJobEngine implements EngineJobClient {
  readonly cancelledIds: string[] = [];
  poll: EngineJobPoll = { jobId: "eng_1", state: "running" };
  private releaseSubmit: ((jobId: string) => void) | null = null;
  private markSubmitStarted: (() => void) | null = null;
  readonly submitStarted = new Promise<void>((resolve) => { this.markSubmitStarted = resolve; });

  constructor(private readonly deferSubmit = false) {}

  async submit(): Promise<string> {
    this.markSubmitStarted?.();
    if (!this.deferSubmit) return "eng_1";
    return new Promise<string>((resolve) => { this.releaseSubmit = resolve; });
  }

  release(jobId = "eng_1"): void { this.releaseSubmit?.(jobId); }

  async get(): Promise<EngineJobPoll> { return this.poll; }

  async cancel(_installationId: string, engineJobId: string): Promise<boolean> {
    this.cancelledIds.push(engineJobId);
    return true;
  }
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

  it("cancels the persisted engine job id and records a durable audit decision", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new ControlledJobEngine();
    const app = new ReviewService({
      store,
      engineJobs: engine,
      tenantId: "tenant-a",
      principalId: "agent-a",
      scopes: ["reviews:cancel"],
      now: () => new Date("2026-07-11T20:00:00.000Z"),
      newId: (prefix) => `${prefix}_product_1`,
    });

    const submitted = await app.submitReview({
      url: "https://preview.example.com",
      client_request_id: "durable-cancel-1",
    });
    expect(submitted.job.status).toBe("running");
    expect(submitted.budget.units_consumed).toBe(0);
    expect((await store.get("tenant-a", submitted.job.job_id))?.engineJobId).toBe("eng_1");

    engine.poll = { jobId: "eng_1", state: "cancelling" };
    const requested = await app.cancelReview(submitted.job.job_id, "superseded by a newer request");
    expect(requested).toMatchObject({ status: "running", upstream_cancellation: "requested" });
    expect(engine.cancelledIds).toEqual(["eng_1"]);
    expect(engine.cancelledIds).not.toContain(submitted.job.job_id);
    expect(await store.get("tenant-a", submitted.job.job_id)).toMatchObject({
      cancellationReason: "superseded by a newer request",
      cancellationDecision: "cancel_requested",
    });

    const duplicateInFlight = await app.cancelReview(submitted.job.job_id, "different reason");
    expect(duplicateInFlight.status).toBe("running");
    expect(engine.cancelledIds).toEqual(["eng_1"]);

    engine.poll = { jobId: "eng_1", state: "failed", error: "canceled", schemaVersion: "1.0.0" };
    const terminal = await app.getReview(submitted.job.job_id);
    expect(terminal.job.status).toBe("cancelled");
    expect((await store.get("tenant-a", submitted.job.job_id))?.budget.units_consumed).toBe(0);

    const repeated = await app.cancelReview(submitted.job.job_id, "different reason");
    expect(repeated.status).toBe("cancelled");
    expect(repeated.cancellation_requested_at).toBe(requested.cancellation_requested_at);
    expect((await store.get("tenant-a", submitted.job.job_id))?.cancellationReason).toBe(
      "superseded by a newer request",
    );
  });

  it("forwards a cancel that races engine submission as soon as the engine id is known", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new ControlledJobEngine(true);
    engine.poll = { jobId: "eng_race", state: "failed", error: "canceled", schemaVersion: "1.0.0" };
    const app = new ReviewService({
      store,
      engineJobs: engine,
      tenantId: "tenant-a",
      principalId: "agent-a",
      scopes: ["reviews:cancel"],
      now: () => new Date("2026-07-11T20:00:00.000Z"),
      newId: (prefix) => `${prefix}_race_1`,
    });

    const submitting = app.submitReview({
      url: "https://preview.example.com",
      client_request_id: "submit-cancel-race-1",
    });
    await engine.submitStarted;
    const record = await store.findByRequest("tenant-a", "submit-cancel-race-1");
    expect(record?.job.stage).toBe("submitting_to_engine");
    expect(record?.engineJobId).toBeNull();

    const requested = await app.cancelReview(record!.job.job_id, "no longer needed");
    expect(requested.status).toBe("running");
    engine.release("eng_race");
    const submitted = await submitting;

    expect(submitted.job.status).toBe("cancelled");
    expect(engine.cancelledIds).toEqual(["eng_race"]);
    expect((await app.getReview(record!.job.job_id)).review).toBeUndefined();
  });

  it("requires reviews:cancel before reading or mutating cancellation state", async () => {
    const store = new InMemoryReviewApplicationStore();
    const engine = new ControlledJobEngine();
    const app = new ReviewService({
      store,
      engineJobs: engine,
      tenantId: "tenant-a",
      principalId: "agent-a",
      scopes: [],
    });
    const submitted = await app.submitReview({
      url: "https://preview.example.com",
      client_request_id: "scope-cancel-1",
    });
    await expect(app.cancelReview(submitted.job.job_id)).rejects.toBeInstanceOf(
      InsufficientScopeError,
    );
    expect(engine.cancelledIds).toEqual([]);
    expect((await store.get("tenant-a", submitted.job.job_id))?.cancellationRequestedAt).toBeNull();
  });
});
