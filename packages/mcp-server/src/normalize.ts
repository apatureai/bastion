import type { Viewport } from "@apatureai/bastion-types";
import { isLoopbackHost } from "./egress.js";

/**
 * Preview-target and request normalization for `design_review` (TRD §4.1).
 *
 * This is *policy* normalization only: it canonicalizes the request so that
 * idempotency keys are stable and obviously-invalid targets are rejected before
 * any billable work. It is NOT the network-layer SSRF guard (ownership-verified
 * domain allowlist, DNS-rebinding defense, redirect pinning). That is issue #4
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

/** Input to `design_recheck` (schemas/mcp-tools.json). */
export type DesignRecheckInput = {
  review_id: string;
  finding_ids: string[];
  /** Optional URL on the same previously authorized host; a host change is rejected. */
  url?: string;
  expected_revision?: string;
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

/**
 * What class of policy violation a `NormalizationError` represents, so callers
 * can map it to a precise MCP error code consistently across tools (issue #14):
 *  - "url":       the preview/recheck URL itself is disallowed (not absolute,
 *                 non-https, or carries credentials) -> URL_NOT_ALLOWED.
 *  - "argument":  a non-URL request field is invalid (bad route prefix, too many
 *                 routes/viewports) -> INVALID_ARGUMENT.
 * `design_recheck` only normalizes a URL, so it can only ever produce "url";
 * `design_review` normalizes both, so it must branch on this to avoid reporting
 * a bad URL as INVALID_ARGUMENT on one path but URL_NOT_ALLOWED on the other.
 */
export type NormalizationErrorKind = "url" | "argument";

export class NormalizationError extends Error {
  readonly kind: NormalizationErrorKind;

  constructor(message: string, kind: NormalizationErrorKind) {
    super(message);
    this.name = "NormalizationError";
    this.kind = kind;
  }
}

const DEFAULT_ROUTES = ["/"];
const DEFAULT_VIEWPORTS: Viewport[] = ["mobile", "desktop"];

/**
 * Normalize a preview URL: https-only, no userinfo, fragment stripped, query
 * preserved (a preview may legitimately depend on it). Throws
 * `NormalizationError` on a policy violation.
 *
 * The one exception to https-only is a loopback dev target the caller named
 * explicitly (`localhost`, 127.0.0.0/8, or `::1`): an agent's local dev server
 * is the core in-loop case, and it is served over plain http far more often than
 * https. The exception is gated on the LITERAL host (see `isLoopbackHost`), so a
 * public hostname that merely resolves to loopback gets no relief here and is
 * still stopped by the network-layer SSRF guard in `target-auth.ts`.
 */
export function normalizePreviewUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NormalizationError(`url is not a valid absolute URL: ${raw}`, "url");
  }

  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new NormalizationError(
      "only https preview URLs are supported (plain http is allowed only for a loopback dev host: localhost, 127.0.0.0/8, ::1)",
      "url",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new NormalizationError("credentials in the URL are not allowed", "url");
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
      throw new NormalizationError(
        `route must be a root-relative path starting with "/": ${route}`,
        "argument",
      );
    }
  }
  if (routes.length > 5) {
    throw new NormalizationError("at most 5 routes may be reviewed in one request", "argument");
  }

  const viewports =
    input.viewports && input.viewports.length > 0
      ? (dedupePreserveOrder(input.viewports) as Viewport[])
      : [...DEFAULT_VIEWPORTS];
  if (viewports.length > 3) {
    throw new NormalizationError("at most 3 viewports may be reviewed in one request", "argument");
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
