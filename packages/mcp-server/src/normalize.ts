import type { Viewport } from "@apature/mcp-types";

/**
 * Preview-target and request normalization for `design_review` (TRD §4.1).
 *
 * This is *policy* normalization only: it canonicalizes the request so that
 * idempotency keys are stable and obviously-invalid targets are rejected before
 * any billable work. It is NOT the network-layer SSRF guard (ownership-verified
 * domain allowlist, DNS-rebinding defense, redirect pinning) — that is issue #4
 * (P0) and lives behind this check, just before egress in the engine boundary.
 */

export type ReviewDepth = "triage" | "deep";
export type ResponseMode = "compact" | "full";

export type DesignReviewInput = {
  url: string;
  routes?: string[];
  viewports?: Viewport[];
  depth?: ReviewDepth;
  expected_revision?: string;
  response_mode?: ResponseMode;
  client_request_id: string;
};

/** A request reduced to its canonical, billable form. */
export type NormalizedReviewRequest = {
  url: string;
  routes: string[];
  viewports: Viewport[];
  depth: ReviewDepth;
  expected_revision: string | null;
  response_mode: ResponseMode;
  client_request_id: string;
};

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

const DEFAULT_ROUTES = ["/"];
const DEFAULT_VIEWPORTS: Viewport[] = ["mobile", "desktop"];

/**
 * Normalize a preview URL: https-only, no userinfo, fragment stripped, query
 * preserved (a preview may legitimately depend on it). Throws
 * `NormalizationError` on a policy violation.
 */
export function normalizePreviewUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NormalizationError(`url is not a valid absolute URL: ${raw}`);
  }

  if (parsed.protocol !== "https:") {
    throw new NormalizationError("only https preview URLs are supported in v1");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new NormalizationError("credentials in the URL are not allowed");
  }

  // Fragments are never sent to the server, but strip them so the idempotency
  // key cannot be perturbed by a client-only anchor.
  parsed.hash = "";
  return parsed.toString();
}

/** Normalize the full request into its canonical billable form (TRD §4.1). */
export function normalizeReviewRequest(input: DesignReviewInput): NormalizedReviewRequest {
  const url = normalizePreviewUrl(input.url);

  const routes = input.routes && input.routes.length > 0 ? dedupePreserveOrder(input.routes) : [...DEFAULT_ROUTES];
  for (const route of routes) {
    if (!route.startsWith("/")) {
      throw new NormalizationError(`route must be a root-relative path starting with "/": ${route}`);
    }
  }
  if (routes.length > 5) {
    throw new NormalizationError("at most 5 routes may be reviewed in one request");
  }

  const viewports =
    input.viewports && input.viewports.length > 0
      ? (dedupePreserveOrder(input.viewports) as Viewport[])
      : [...DEFAULT_VIEWPORTS];
  if (viewports.length > 3) {
    throw new NormalizationError("at most 3 viewports may be reviewed in one request");
  }

  return {
    url,
    routes,
    viewports,
    depth: input.depth ?? "deep",
    expected_revision: input.expected_revision ?? null,
    response_mode: input.response_mode ?? "compact",
    client_request_id: input.client_request_id,
  };
}

/**
 * Stable string fingerprint of a normalized request, excluding the idempotency
 * key itself. Two requests with the same fingerprint are the "same normalized
 * request"; the same `client_request_id` with a different fingerprint is an
 * `IDEMPOTENCY_CONFLICT` (TRD §4.1).
 */
export function requestFingerprint(req: NormalizedReviewRequest): string {
  return JSON.stringify({
    url: req.url,
    routes: req.routes,
    viewports: req.viewports,
    depth: req.depth,
    expected_revision: req.expected_revision,
    response_mode: req.response_mode,
  });
}

function dedupePreserveOrder<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
