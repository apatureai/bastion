import { describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  JobNotFoundError,
  MockEngineClient,
  ReviewService,
} from "../src/index.js";

/** A service wired to deterministic ids and clock for stable assertions. */
function makeService(): ReviewService {
  let counter = 0;
  return new ReviewService({
    engine: new MockEngineClient(),
    now: () => new Date("2026-06-22T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_${String(++counter).padStart(8, "0")}`,
  });
}

const base = { url: "https://preview.example.com/pricing", client_request_id: "req-abcdef01" };

describe("ReviewService.submitReview", () => {
  it("returns a completed review job with the budget envelope", async () => {
    const service = makeService();
    const out = await service.submitReview(base);

    expect(out.schema_version).toBe("1.0.0");
    expect(out.job.kind).toBe("review");
    expect(out.job.status).toBe("completed");
    expect(out.job.reused).toBe(false);
    expect(out.job.job_id.length).toBeGreaterThanOrEqual(8);
    expect(out.budget.units_reserved).toBe(1);
    expect(out.budget.tenant_units_remaining).toBe(999);
  });

  it("is idempotent: an exact retry returns the original job, reused=true, no new charge", async () => {
    const service = makeService();
    const first = await service.submitReview(base);
    const second = await service.submitReview(base);

    expect(second.job.job_id).toBe(first.job.job_id);
    expect(second.job.reused).toBe(true);
    expect(second.budget.units_reserved).toBe(0);
    // Only the first submission consumed a unit.
    expect(second.budget.tenant_units_remaining).toBe(999);
  });

  it("rejects a reused key with different normalized arguments as a conflict", async () => {
    const service = makeService();
    await service.submitReview(base);
    await expect(
      service.submitReview({ ...base, depth: "triage" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe("ReviewService.getReview (§6.4 Critique)", () => {
  it("returns the Critique with element_ref and suggestions on findings", async () => {
    const service = makeService();
    const submitted = await service.submitReview(base);
    const got = service.getReview(submitted.job.job_id);

    const review = got.review;
    expect(review).toBeDefined();
    if (!review) throw new Error("expected a review");

    expect(review.grade).toBe("needs_work");
    expect(review.overall.length).toBeGreaterThan(0);
    expect(review.findings.length).toBe(3);

    // Issue #1 acceptance: findings carry element_ref + concrete suggestions.
    const cta = review.findings.find((f) => f.finding_id === "f_001");
    expect(cta).toBeDefined();
    expect(cta?.severity).toBe("should_fix");
    expect(cta?.element_ref).toBe("button[data-testid='cta-primary']");
    expect(cta?.suggestion).toContain("--color-accent");

    // Engine "major"/"minor" collapse to should_fix; "nit" stays nit.
    const severities = review.findings.map((f) => f.severity);
    expect(severities).toContain("should_fix");
    expect(severities).toContain("nit");

    expect(review.not_reviewed.length).toBeGreaterThan(0);
  });

  it("does not consume units on read", async () => {
    const service = makeService();
    const submitted = await service.submitReview(base);
    const remainingAfterSubmit = submitted.budget.tenant_units_remaining;

    service.getReview(submitted.job.job_id);
    // Re-submit identical request: still reused, remaining unchanged -> get was free.
    const resubmit = await service.submitReview(base);
    expect(resubmit.budget.tenant_units_remaining).toBe(remainingAfterSubmit);
  });

  it("throws JobNotFoundError for an unknown job", () => {
    const service = makeService();
    expect(() => service.getReview("job_99999999")).toThrow(JobNotFoundError);
  });
});
