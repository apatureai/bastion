import { loadGoldenEngineResult } from "@apature/mcp-types";
import { describe, expect, it } from "vitest";
import type { EngineJobClient, EngineJobPoll } from "../src/engine-client.js";
import { EngineDependencyError } from "../src/engine-http-client.js";
import { EngineResultError } from "../src/engine-result.js";
import { VerdictJobEngineClient } from "../src/verdict-job-engine.js";
import type { NormalizedReviewRequest } from "../src/normalize.js";

/**
 * The bridge that lets the local server drive a running verdict deployment
 * through the same signed submit/poll/cancel client production uses.
 *
 * Load-bearing: the caller's idempotency key reaches the engine unchanged (a
 * retried tool call must not pay for a second capture); a non-terminal poll is
 * waited out rather than reported as a result; a failed job surfaces the
 * engine's reason; and a job that overruns its deadline is cancelled instead of
 * being left running with nobody reading it.
 */

const request: NormalizedReviewRequest = {
  url: "https://preview.example.com/pricing",
  routes: ["/pricing"],
  viewports: ["desktop"],
  depth: "deep",
  expected_revision: null,
  response_mode: "compact",
  client_request_id: "job-0001",
};

class ScriptedJobs implements EngineJobClient {
  readonly submits: Array<{ installationId: string; idempotencyKey: string }> = [];
  readonly cancels: string[] = [];
  private index = 0;

  constructor(private readonly polls: EngineJobPoll[]) {}

  async submit(installationId: string, idempotencyKey: string): Promise<string> {
    this.submits.push({ installationId, idempotencyKey });
    return "eng_1";
  }

  async get(): Promise<EngineJobPoll> {
    const poll = this.polls[Math.min(this.index, this.polls.length - 1)] as EngineJobPoll;
    this.index += 1;
    return poll;
  }

  async cancel(_installationId: string, jobId: string): Promise<boolean> {
    this.cancels.push(jobId);
    return true;
  }
}

const completed = (): EngineJobPoll => ({
  jobId: "eng_1",
  state: "completed",
  result: loadGoldenEngineResult(),
  schemaVersion: "1",
});

describe("VerdictJobEngineClient", () => {
  it("submits under the caller's idempotency key and polls to completion", async () => {
    const jobs = new ScriptedJobs([
      { jobId: "eng_1", state: "pending" },
      { jobId: "eng_1", state: "running" },
      completed(),
    ]);
    const sleeps: number[] = [];
    const client = new VerdictJobEngineClient({
      jobs,
      installationId: "local",
      pollIntervalMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.review(request)).resolves.toEqual(loadGoldenEngineResult());
    expect(jobs.submits).toEqual([{ installationId: "local", idempotencyKey: "job-0001" }]);
    expect(sleeps).toEqual([250, 250]);
  });

  it("surfaces the engine's own failure reason", async () => {
    const jobs = new ScriptedJobs([
      { jobId: "eng_1", state: "failed", error: "capture_timeout", schemaVersion: "1" },
    ]);
    const client = new VerdictJobEngineClient({ jobs, installationId: "local" });
    await expect(client.review(request)).rejects.toThrow(/eng_1 failed: capture_timeout/);
    await expect(client.review(request)).rejects.toThrow(EngineDependencyError);
  });

  it("validates the payload a completed job returns", async () => {
    const jobs = new ScriptedJobs([
      {
        jobId: "eng_1",
        state: "completed",
        result: { grade: "ship" } as never,
        schemaVersion: "1",
      },
    ]);
    const client = new VerdictJobEngineClient({ jobs, installationId: "local" });
    await expect(client.review(request)).rejects.toThrow(EngineResultError);
  });

  it("cancels a job that overruns the deadline instead of leaving it running", async () => {
    const jobs = new ScriptedJobs([{ jobId: "eng_1", state: "running" }]);
    let clock = 0;
    const client = new VerdictJobEngineClient({
      jobs,
      installationId: "local",
      timeoutMs: 1_000,
      pollIntervalMs: 400,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    await expect(client.review(request)).rejects.toThrow(/did not finish within 1000ms/);
    expect(jobs.cancels).toEqual(["eng_1"]);
  });

  it("refuses to recheck rather than inventing per-finding outcomes", async () => {
    const client = new VerdictJobEngineClient({
      jobs: new ScriptedJobs([completed()]),
      installationId: "local",
    });
    await expect(
      client.recheck({
        reviewId: "rev_1",
        url: request.url,
        beforeFingerprint: "a",
        afterFingerprint: "b",
        findings: [],
      }),
    ).rejects.toThrow(/exposes no recheck route/);
  });
});
