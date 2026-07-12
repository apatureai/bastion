import { describe, expect, it } from "vitest";
import { JobNotFoundError, ReviewService } from "../src/review-service.js";

const NOW = "2026-07-11T00:00:00.000Z";

/** A submit input that passes normalization; no allowlist ⇒ SSRF guard is skipped. */
function reviewInput(id: string) {
  return { url: "https://preview.example.com/", client_request_id: id };
}

function service() {
  let n = 0;
  return new ReviewService({
    now: () => new Date(NOW),
    newId: (p) => `${p}_${String(++n).padStart(8, "0")}`,
  });
}

/**
 * cancelReview against the current synchronous engine. Every submitted job
 * completes on submit, so the reachable states here are `unknown` and
 * terminal-idempotent; the queued/running state transitions are proven by the
 * pure engine-cancel mapping test (`engine-cancel.test.ts`) and become
 * reachable end to end with the durable async store in #28.
 */
describe("ReviewService.cancelReview (#32)", () => {
  it("raises JobNotFoundError for an unknown id (non-enumerating at the server)", async () => {
    await expect(service().cancelReview("job_does_not_exist")).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it("cancelling a completed review is an idempotent no-op that keeps its state", async () => {
    const svc = service();
    const submitted = await svc.submitReview(reviewInput("req-completed-0001"));
    expect(submitted.job.status).toBe("completed"); // synchronous mock

    const first = await svc.cancelReview(submitted.job.job_id, "changed my mind");
    expect(first).toMatchObject({
      schema_version: "1.0.0",
      job_id: submitted.job.job_id,
      status: "completed",
      upstream_cancellation: "already_terminal",
    });
    expect(typeof first.cancellation_requested_at).toBe("string");

    // A duplicate cancel returns the identical result — same status AND the same
    // cancellation_requested_at (set once on first cancel, not a moving clock).
    const second = await svc.cancelReview(submitted.job.job_id);
    expect(second).toEqual(first);

    // The job itself is untouched: get still serves the completed critique.
    expect((await svc.getReview(submitted.job.job_id)).job.status).toBe("completed");
  });

  it("consumes no review units: a cancel does not move the tenant balance", async () => {
    const svc = service();
    const submitted = await svc.submitReview(reviewInput("req-units-0001"));
    const before = submitted.budget.tenant_units_remaining;
    await svc.cancelReview(submitted.job.job_id);
    // A second review drops the balance by exactly one review's unit — the
    // cancel in between spent nothing (§ ledger truth preserved).
    const next = await svc.submitReview(reviewInput("req-units-0002"));
    expect(next.budget.tenant_units_remaining).toBe(before - 1);
  });
});
