import { describe, expect, it } from "vitest";
import { MockEngineClient, RecheckRejectedError, ReviewService } from "../src/index.js";

/** A guarded service (SSRF allowlist + stub resolver) with deterministic ids. */
function guardedService() {
  let counter = 0;
  return new ReviewService({
    engine: new MockEngineClient(),
    now: () => new Date("2026-06-22T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_${String(++counter).padStart(8, "0")}`,
    allowlist: { tenantId: "t1", targets: [{ kind: "host", host: "preview.example.com" }] },
    resolver: { resolve: async () => ["93.184.216.34"] },
  });
}

const reviewInput = {
  url: "https://preview.example.com/pricing",
  client_request_id: "req-review0001",
};

/** Submit a review and return its review_id and finding ids. */
async function seedReview(service: ReviewService) {
  const submitted = await service.submitReview(reviewInput);
  const got = service.getReview(submitted.job.job_id);
  const review = got.review;
  if (!review) throw new Error("expected a completed review");
  return { reviewId: review.review_id, findingIds: review.findings.map((f) => f.finding_id) };
}

describe("ReviewService.submitRecheck (issue #2)", () => {
  it("returns a before/after pair and a per-finding outcome for each requested finding", async () => {
    const service = guardedService();
    const { reviewId, findingIds } = await seedReview(service);

    const out = await service.submitRecheck({
      review_id: reviewId,
      finding_ids: findingIds,
      // Signal a changed target so the recheck is not TARGET_UNCHANGED.
      expected_revision: "deploy-2",
      client_request_id: "req-recheck001",
    });

    expect(out.job.kind).toBe("recheck");
    expect(out.job.status).toBe("completed");
    expect(out.recheck.review_id).toBe(reviewId);
    expect(out.recheck.before_fingerprint).not.toBe(out.recheck.after_fingerprint);
    expect(out.recheck.outcomes.length).toBe(findingIds.length);
    for (const o of out.recheck.outcomes) {
      expect(findingIds).toContain(o.finding_id);
      expect(["passed", "failed", "inconclusive"]).toContain(o.outcome);
      expect(o.confidence).toBeGreaterThan(0);
      expect(typeof o.reason).toBe("string");
    }
  });

  it("surfaces resolved (passed) and persisting (failed) findings", async () => {
    const service = guardedService();
    const { reviewId, findingIds } = await seedReview(service);
    const out = await service.submitRecheck({
      review_id: reviewId,
      finding_ids: findingIds,
      expected_revision: "deploy-2",
      client_request_id: "req-recheck002",
    });
    const outcomes = new Set(out.recheck.outcomes.map((o) => o.outcome));
    // The golden fixture's three finding ids span both verdicts deterministically.
    expect(outcomes.has("passed")).toBe(true);
    expect(outcomes.has("failed")).toBe(true);
  });

  it("charges focused units = ceil(n/3) and never double-spends on retry", async () => {
    const service = guardedService();
    const { reviewId, findingIds } = await seedReview(service); // charged 1 review unit
    const first = await service.submitRecheck({
      review_id: reviewId,
      finding_ids: findingIds, // 3 findings -> ceil(3/3) = 1 unit
      expected_revision: "deploy-2",
      client_request_id: "req-recheck003",
    });
    expect(first.budget.units_reserved).toBe(1);
    const remainingAfterFirst = first.budget.tenant_units_remaining;

    // Exact idempotent retry: same job, reused, zero new charge.
    const retry = await service.submitRecheck({
      review_id: reviewId,
      finding_ids: findingIds,
      expected_revision: "deploy-2",
      client_request_id: "req-recheck003",
    });
    expect(retry.job.job_id).toBe(first.job.job_id);
    expect(retry.job.reused).toBe(true);
    expect(retry.budget.units_reserved).toBe(0);
    expect(retry.budget.tenant_units_remaining).toBe(remainingAfterFirst);
  });

  it("rejects an unchanged target without charging (TARGET_UNCHANGED)", async () => {
    const service = guardedService();
    const { reviewId, findingIds } = await seedReview(service);

    // No URL and no new revision => same fingerprint as the review => unchanged.
    await expect(
      service.submitRecheck({
        review_id: reviewId,
        finding_ids: findingIds,
        client_request_id: "req-recheck004",
      }),
    ).rejects.toMatchObject({ reason: "target_unchanged" });
  });

  it("rejects a finding that does not belong to the review", async () => {
    const service = guardedService();
    const { reviewId } = await seedReview(service);
    await expect(
      service.submitRecheck({
        review_id: reviewId,
        finding_ids: ["f_does_not_exist"],
        expected_revision: "deploy-2",
        client_request_id: "req-recheck005",
      }),
    ).rejects.toMatchObject({ reason: "finding_not_found" });
  });

  it("rejects a recheck on an unknown review", async () => {
    const service = guardedService();
    await expect(
      service.submitRecheck({
        review_id: "rev_unknown01",
        finding_ids: ["f_001abcd"],
        expected_revision: "deploy-2",
        client_request_id: "req-recheck006",
      }),
    ).rejects.toBeInstanceOf(RecheckRejectedError);
  });

  it("rejects a host change (requires a new full review)", async () => {
    const service = guardedService();
    const { reviewId, findingIds } = await seedReview(service);
    await expect(
      service.submitRecheck({
        review_id: reviewId,
        finding_ids: findingIds,
        url: "https://preview.example.com.evil.test/", // different host
        expected_revision: "deploy-2",
        client_request_id: "req-recheck007",
      }),
    ).rejects.toMatchObject({ reason: "host_changed" });
  });

  it("enforces the per-finding recheck window (3 / 30 min) once reached", async () => {
    // A mutable clock so each recheck clears the exponential backoff but stays
    // inside the 30-minute per-finding window. (Backoff is covered separately
    // in rate-limit.test.ts.)
    let nowMs = Date.parse("2026-06-22T00:00:00.000Z");
    let counter = 0;
    const service = new ReviewService({
      engine: new MockEngineClient(),
      now: () => new Date(nowMs),
      newId: (prefix) => `${prefix}_${String(++counter).padStart(8, "0")}`,
      allowlist: { tenantId: "t1", targets: [{ kind: "host", host: "preview.example.com" }] },
      resolver: { resolve: async () => ["93.184.216.34"] },
    });
    const { reviewId } = await seedReview(service);
    const finding = "f_001"; // golden fixture finding id

    // Three rechecks succeed, each 5 minutes apart (past backoff, within 30 min).
    for (let i = 1; i <= 3; i++) {
      await service.submitRecheck({
        review_id: reviewId,
        finding_ids: [finding],
        expected_revision: `deploy-${i}`,
        client_request_id: `req-window-${i}-aaaa`,
      });
      nowMs += 5 * 60 * 1000;
    }
    // The fourth is throttled by the per-finding window, charging nothing.
    await expect(
      service.submitRecheck({
        review_id: reviewId,
        finding_ids: [finding],
        expected_revision: "deploy-4",
        client_request_id: "req-window-4-aaaa",
      }),
    ).rejects.toMatchObject({ kind: "per_finding_30min" });
  });
});
