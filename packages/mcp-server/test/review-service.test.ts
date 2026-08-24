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
    const got = await service.getReview(submitted.job.job_id);

    const review = got.review;
    expect(review).toBeDefined();
    if (!review) throw new Error("expected a review");

    // The service's default engine is the fixture engine, so the grade is the
    // value that means "nothing judged this page", never the fixture's own
    // `needs_work`, and the payload says why.
    expect(review.grade).toBe("unjudged");
    expect(review.provenance.model_backed).toBe(false);
    expect(review.provenance.source).toBe("fixture");
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

    await service.getReview(submitted.job.job_id);
    // Re-submit identical request: still reused, remaining unchanged -> get was free.
    const resubmit = await service.submitReview(base);
    expect(resubmit.budget.tenant_units_remaining).toBe(remainingAfterSubmit);
  });

  it("throws JobNotFoundError for an unknown job", async () => {
    const service = makeService();
    await expect(service.getReview("job_99999999")).rejects.toThrow(JobNotFoundError);
  });
});

describe("ReviewService SSRF guard (issue #4)", () => {
  /** A service with the target-authorization guard wired in. */
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

  it("allows a verified, publicly-resolving target", async () => {
    const out = await guardedService().submitReview(base);
    expect(out.job.status).toBe("completed");
    expect(out.budget.units_reserved).toBe(1);
  });

  it("rejects an unverified host and charges nothing", async () => {
    const service = guardedService();
    await expect(
      service.submitReview({ url: "https://attacker.com/", client_request_id: "req-attacker1" }),
    ).rejects.toMatchObject({ reason: "domain_unverified" });

    // No job was created, so the next verified submit is still the first charge.
    const ok = await service.submitReview(base);
    expect(ok.budget.tenant_units_remaining).toBe(999);
  });

  it("accepts a plain-http loopback dev target end to end, without allowlisting it", async () => {
    // The whole point of the local-dev exception: an agent's own dev server on
    // http://localhost is reviewable through the full submit pipeline even though
    // "localhost" is not on the allowlist and the resolver would reject it.
    const service = new ReviewService({
      engine: new MockEngineClient(),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      newId: (prefix) => `${prefix}_loop0001`,
      allowlist: { tenantId: "t1", targets: [{ kind: "host", host: "preview.example.com" }] },
      resolver: { resolve: async () => ["127.0.0.1"] },
    });
    const out = await service.submitReview({
      url: "http://localhost:5173/",
      client_request_id: "req-loopback-1",
    });
    expect(out.job.status).toBe("completed");
    expect(out.budget.units_reserved).toBe(1);
  });

  it("still rejects a verified host that resolves only to loopback (rebind, not the exception)", async () => {
    const service = new ReviewService({
      engine: new MockEngineClient(),
      allowlist: { tenantId: "t1", targets: [{ kind: "host", host: "preview.example.com" }] },
      resolver: { resolve: async () => ["127.0.0.1"] },
    });
    await expect(service.submitReview(base)).rejects.toMatchObject({
      reason: { egress: "loopback" },
    });
  });

  it("fails closed when only the allowlist is configured (no resolver)", async () => {
    const service = new ReviewService({
      engine: new MockEngineClient(),
      allowlist: { tenantId: "t1", targets: [{ kind: "host", host: "preview.example.com" }] },
      // resolver deliberately omitted; a partial config must not skip the guard.
    });
    await expect(service.submitReview(base)).rejects.toMatchObject({ reason: "domain_unverified" });
  });

  it("fails closed when only the resolver is configured (no allowlist)", async () => {
    const service = new ReviewService({
      engine: new MockEngineClient(),
      resolver: { resolve: async () => ["93.184.216.34"] },
      // allowlist deliberately omitted.
    });
    await expect(service.submitReview(base)).rejects.toMatchObject({ reason: "domain_unverified" });
  });
});
