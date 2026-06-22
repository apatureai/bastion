import { describe, expect, it } from "vitest";
import { DEFAULT_RECHECK_LIMITS, RecheckLimiter } from "../src/index.js";

const t0 = Date.parse("2026-06-22T00:00:00.000Z");

/** A limiter with the beta defaults plus any overrides. */
function limiter(overrides: Partial<typeof DEFAULT_RECHECK_LIMITS> = {}) {
  return new RecheckLimiter({ ...DEFAULT_RECHECK_LIMITS, ...overrides });
}

const args = (now: number, extra: Partial<Parameters<RecheckLimiter["check"]>[0]> = {}) => ({
  principalId: "p1",
  reviewId: "rev_1",
  findingIds: ["f_001"],
  units: 1,
  now,
  ...extra,
});

describe("RecheckLimiter — check vs commit (zero-charge invariant)", () => {
  it("does not record usage on check; only commit advances the windows", () => {
    const lim = limiter();
    // Many checks without commits never exhaust anything.
    for (let i = 0; i < 100; i++) {
      expect(lim.check(args(t0)).allowed).toBe(true);
    }
  });
});

describe("RecheckLimiter — exponential backoff", () => {
  it("blocks an immediate second recheck of the same review, then allows after wait", () => {
    const lim = limiter();
    expect(lim.check(args(t0)).allowed).toBe(true);
    lim.commit(args(t0));

    // Immediately after: backoff blocks with the base wait (2s).
    const blocked = lim.check(args(t0, { findingIds: ["f_002"] }));
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.kind).toBe("backoff");
      expect(blocked.retryAfterMs).toBe(DEFAULT_RECHECK_LIMITS.backoffBaseMs);
    }

    // After the base backoff elapses, it is allowed.
    expect(lim.check(args(t0 + 2_000, { findingIds: ["f_002"] })).allowed).toBe(true);
  });

  it("doubles the backoff with each consecutive recheck", () => {
    const lim = limiter();
    let now = t0;
    lim.commit(args(now)); // consecutive = 1 -> next wait = base * 2^0 = 2s
    now += 2_000;
    lim.commit(args(now, { findingIds: ["f_002"] })); // consecutive = 2 -> next wait = 4s
    const d = lim.check(args(now + 1, { findingIds: ["f_003"] }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.kind).toBe("backoff");
    // 4s after the last commit it clears.
    expect(lim.check(args(now + 4_000, { findingIds: ["f_003"] })).allowed).toBe(true);
  });
});

describe("RecheckLimiter — review-chain unit budget (18 / 30 min)", () => {
  it("blocks once the chain would exceed the 30-minute unit budget", () => {
    // Raise the per-finding / principal limits out of the way so this test
    // isolates the chain-unit budget; disable backoff for the same reason.
    const lim = limiter({
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      perFindingPer30Min: 1000,
      perFindingPerDay: 1000,
      principalPerMinute: 1000,
    });
    let now = t0;
    // Commit 18 units on the same review, spaced out within the 30-minute window.
    for (let i = 0; i < 18; i++) {
      expect(lim.check(args(now, { units: 1 })).allowed).toBe(true);
      lim.commit(args(now, { units: 1 }));
      now += 1_000;
    }
    const over = lim.check(args(now, { units: 1 }));
    expect(over.allowed).toBe(false);
    if (!over.allowed) expect(over.kind).toBe("chain_units_30min");

    // After the oldest unit ages out of the 30-minute window, room frees up.
    expect(lim.check(args(t0 + 30 * 60 * 1000 + 1, { units: 1 })).allowed).toBe(true);
  });
});

describe("RecheckLimiter — principal burst (per minute)", () => {
  it("blocks once the principal exceeds its per-minute submission rate", () => {
    const lim = limiter({ principalPerMinute: 2, backoffBaseMs: 0, backoffMaxMs: 0 });
    // Two different reviews so per-finding/backoff do not interfere.
    lim.commit(args(t0, { reviewId: "rev_a" }));
    lim.commit(args(t0 + 1, { reviewId: "rev_b" }));
    const third = lim.check(args(t0 + 2, { reviewId: "rev_c" }));
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.kind).toBe("principal_burst");

    // A minute later the window has rolled over.
    expect(lim.check(args(t0 + 60_001, { reviewId: "rev_c" })).allowed).toBe(true);
  });
});
