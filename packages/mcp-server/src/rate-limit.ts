/**
 * Recheck budgets, backoff, and rate limiting (issue #5, TRD §9.2-§9.4).
 *
 * A coding agent in a fix loop can storm the capture engine with rechecks, so
 * the recheck path enforces several rolling-window limits plus exponential
 * backoff. Everything here is pure and clock-injected (no timers, no wall
 * clock), so windows are deterministic under test. The limiter only RECORDS
 * usage after a caller has committed to spending (see `RecheckLimiter.commit`),
 * so a rejected or zero-unit recheck never consumes a window slot.
 */

/** Beta defaults (TRD §9.2). Defaults are configuration, not schema constants. */
export type RecheckLimitConfig = {
  /** Rechecks per finding per 30 minutes. */
  perFindingPer30Min: number;
  /** Rechecks per finding per day. */
  perFindingPerDay: number;
  /** Review-chain units per 30 minutes. */
  chainUnitsPer30Min: number;
  /** Principal recheck submissions allowed per minute (MCP-surface burst). */
  principalPerMinute: number;
  /** Base backoff applied between consecutive rechecks on one review. */
  backoffBaseMs: number;
  /** Cap on the exponential backoff. */
  backoffMaxMs: number;
};

export const DEFAULT_RECHECK_LIMITS: RecheckLimitConfig = {
  perFindingPer30Min: 3,
  perFindingPerDay: 5,
  chainUnitsPer30Min: 18,
  principalPerMinute: 60,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
};

const THIRTY_MIN_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;

/** Why a recheck was throttled. Maps to RATE_LIMITED / BUDGET_EXHAUSTED. */
export type ThrottleKind =
  | "per_finding_30min"
  | "per_finding_day"
  | "chain_units_30min"
  | "principal_burst"
  | "backoff";

/** A throttle decision: when allowed, `retryAfterMs` is absent. */
export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; kind: ThrottleKind; retryAfterMs: number };

/** Drop timestamps older than `windowMs` before `now` (mutates in place). */
function evict(times: number[], now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < times.length && times[i]! <= cutoff) i++;
  if (i > 0) times.splice(0, i);
}

/** ms until the oldest timestamp in the window ages out (>= 1). */
function retryAfter(times: number[], now: number, windowMs: number): number {
  const oldest = times[0];
  if (oldest === undefined) return 1;
  return Math.max(1, oldest + windowMs - now);
}

/**
 * Rolling-window recheck limiter. `check` is a pure read that decides whether a
 * recheck of `findingIds` costing `units` may proceed; `commit` records the
 * usage once the caller actually spends. Keeping the two separate guarantees a
 * rejected recheck never burns a slot (TRD §9.3: zero-unit on pre-enqueue
 * rejection).
 */
export class RecheckLimiter {
  private readonly cfg: RecheckLimitConfig;

  // review_id -> finding_id -> recheck timestamps.
  private readonly findingTimes = new Map<string, Map<string, number[]>>();
  // review_id -> { unit-cost, at } records for the chain-unit window.
  private readonly chainUnits = new Map<string, Array<{ at: number; units: number }>>();
  // review_id -> last recheck time, for exponential backoff.
  private readonly lastRecheckAt = new Map<string, number>();
  // review_id -> consecutive recheck count, for the backoff exponent.
  private readonly consecutive = new Map<string, number>();
  // principal_id -> submission timestamps (MCP-surface burst).
  private readonly principalTimes = new Map<string, number[]>();

  constructor(cfg: RecheckLimitConfig = DEFAULT_RECHECK_LIMITS) {
    this.cfg = cfg;
  }

  /**
   * Decide whether a recheck may proceed. Pure: records nothing. Checks, in a
   * stable order, the principal burst, per-finding windows, the review-chain
   * unit window, and the exponential backoff between consecutive rechecks.
   */
  check(args: {
    principalId: string;
    reviewId: string;
    findingIds: string[];
    units: number;
    now: number;
  }): ThrottleDecision {
    const { principalId, reviewId, findingIds, units, now } = args;

    // Principal burst (MCP surface).
    const pt = this.principalTimes.get(principalId) ?? [];
    evict(pt, now, ONE_MIN_MS);
    if (pt.length >= this.cfg.principalPerMinute) {
      return { allowed: false, kind: "principal_burst", retryAfterMs: retryAfter(pt, now, ONE_MIN_MS) };
    }

    // Per-finding windows (30 minutes and per day).
    const perReview = this.findingTimes.get(reviewId);
    for (const fid of findingIds) {
      const times = perReview?.get(fid) ?? [];
      const recent = times.slice();
      evict(recent, now, THIRTY_MIN_MS);
      if (recent.length >= this.cfg.perFindingPer30Min) {
        return {
          allowed: false,
          kind: "per_finding_30min",
          retryAfterMs: retryAfter(recent, now, THIRTY_MIN_MS),
        };
      }
      const daily = times.slice();
      evict(daily, now, ONE_DAY_MS);
      if (daily.length >= this.cfg.perFindingPerDay) {
        return {
          allowed: false,
          kind: "per_finding_day",
          retryAfterMs: retryAfter(daily, now, ONE_DAY_MS),
        };
      }
    }

    // Review-chain unit window.
    const chain = this.chainUnits.get(reviewId) ?? [];
    const chainRecent = chain.filter((r) => r.at > now - THIRTY_MIN_MS);
    const usedUnits = chainRecent.reduce((sum, r) => sum + r.units, 0);
    if (usedUnits + units > this.cfg.chainUnitsPer30Min) {
      const oldest = chainRecent[0];
      return {
        allowed: false,
        kind: "chain_units_30min",
        retryAfterMs: oldest ? Math.max(1, oldest.at + THIRTY_MIN_MS - now) : 1,
      };
    }

    // Exponential backoff between consecutive rechecks on the same review.
    const last = this.lastRecheckAt.get(reviewId);
    if (last !== undefined) {
      const n = this.consecutive.get(reviewId) ?? 0;
      const wait = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** Math.max(0, n - 1));
      const elapsed = now - last;
      if (elapsed < wait) {
        return { allowed: false, kind: "backoff", retryAfterMs: wait - elapsed };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a committed recheck against every window. Call this only after the
   * recheck is actually being spent (post-`check`, after the engine runs).
   */
  commit(args: {
    principalId: string;
    reviewId: string;
    findingIds: string[];
    units: number;
    now: number;
  }): void {
    const { principalId, reviewId, findingIds, units, now } = args;

    const pt = this.principalTimes.get(principalId) ?? [];
    pt.push(now);
    evict(pt, now, ONE_MIN_MS);
    this.principalTimes.set(principalId, pt);

    let perReview = this.findingTimes.get(reviewId);
    if (!perReview) {
      perReview = new Map();
      this.findingTimes.set(reviewId, perReview);
    }
    for (const fid of findingIds) {
      const times = perReview.get(fid) ?? [];
      times.push(now);
      evict(times, now, ONE_DAY_MS);
      perReview.set(fid, times);
    }

    const chain = this.chainUnits.get(reviewId) ?? [];
    chain.push({ at: now, units });
    this.chainUnits.set(
      reviewId,
      chain.filter((r) => r.at > now - THIRTY_MIN_MS),
    );

    this.consecutive.set(reviewId, (this.consecutive.get(reviewId) ?? 0) + 1);
    this.lastRecheckAt.set(reviewId, now);
  }
}
