/**
 * Typed tool-execution error contract (schemas/review-error.schema.json). MCP
 * Review returns these as structured tool errors so the customer's agent can
 * decide whether to retry, wait, re-authorize, or stop.
 */

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "INSUFFICIENT_SCOPE",
  "TENANT_FORBIDDEN",
  "DOMAIN_UNVERIFIED",
  "URL_NOT_ALLOWED",
  "DNS_TARGET_PROHIBITED",
  "REDIRECT_NOT_ALLOWED",
  "INVALID_ARGUMENT",
  "IDEMPOTENCY_CONFLICT",
  "BUDGET_EXHAUSTED",
  "RATE_LIMITED",
  "POLL_RATE_LIMITED",
  "CONCURRENCY_LIMITED",
  "JOB_NOT_FOUND",
  "JOB_EXPIRED",
  "JOB_TERMINAL",
  "REVIEW_NOT_READY",
  "FINDING_NOT_FOUND",
  "RECHECK_LIMIT_REACHED",
  "TARGET_UNCHANGED",
  "TARGET_REVISION_MISMATCH",
  "PREVIEW_NOT_READY",
  "PREVIEW_AUTH_REQUIRED",
  "CAPTURE_UNSTABLE",
  "CAPTURE_FAILED",
  "CONTEXT_UNAVAILABLE",
  "UI_DNA_UNAVAILABLE",
  "UI_GRAPH_UNAVAILABLE",
  "JUDGMENT_FAILED",
  "RESULT_SCHEMA_INVALID",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ReviewErrorCode = (typeof ERROR_CODES)[number];

export type NextAction =
  | "authenticate"
  | "request_scope"
  | "verify_domain"
  | "change_target"
  | "wait"
  | "reduce_scope"
  | "start_new_review"
  | "contact_support"
  | "none";

/** Structured error payload (schemas/review-error.schema.json). */
export type ReviewError = {
  schema_version: "1.0.0";
  code: ReviewErrorCode;
  message: string;
  retriable: boolean;
  retry_after_ms?: number;
  stage?: string;
  correlation_id: string;
  next_action: NextAction;
  details?: Record<string, unknown>;
};
