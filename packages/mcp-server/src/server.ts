import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReviewError, ReviewErrorCode, NextAction } from "@apature/mcp-types";
import { NormalizationError } from "./normalize.js";
import {
  IdempotencyConflictError,
  JobNotFoundError,
  JobExpiredError,
  RecheckRejectedError,
  RecheckThrottledError,
  InsufficientScopeError,
  ReviewService,
} from "./review-service.js";
import type { ReviewServiceDeps, RecheckRejectionReason } from "./review-service.js";
import { TargetAuthError } from "./target-auth.js";
import type { TargetAuthFailureReason } from "./target-auth.js";
import {
  designRecheckInputShape,
  designReviewCancelInputShape,
  designReviewGetInputShape,
  designReviewInputShape,
} from "./tools.js";

const SERVER_NAME = "apature-mcp-review";
const SERVER_VERSION = "0.0.0";

/** Render a value as the tool's JSON text content plus structured content. */
function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Render a typed `ReviewError` as a structured tool error (isError: true). */
function errorResult(
  code: ReviewErrorCode,
  message: string,
  opts: { retriable: boolean; nextAction: NextAction; retryAfterMs?: number },
): CallToolResult {
  const error: ReviewError = {
    schema_version: "1.0.0",
    code,
    message,
    retriable: opts.retriable,
    correlation_id: `cor_${randomUUID()}`,
    next_action: opts.nextAction,
    ...(opts.retryAfterMs !== undefined ? { retry_after_ms: opts.retryAfterMs } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
    structuredContent: { error },
    isError: true,
  };
}

/**
 * Map a target-authorization failure (issue #4) to a typed tool error. All of
 * these are non-retriable: the caller must change or verify the target, never
 * retry the same URL. Egress/rebind failures collapse to `DNS_TARGET_PROHIBITED`
 * so the response never reveals which internal address was resolved.
 */
function targetAuthErrorResult(reason: TargetAuthFailureReason, message: string): CallToolResult {
  if (typeof reason === "object") {
    return errorResult("DNS_TARGET_PROHIBITED", message, {
      retriable: false,
      nextAction: "change_target",
    });
  }
  switch (reason) {
    case "domain_unverified":
      return errorResult("DOMAIN_UNVERIFIED", message, {
        retriable: false,
        nextAction: "verify_domain",
      });
    case "dns_rebind":
    case "no_dns_records":
      return errorResult("DNS_TARGET_PROHIBITED", message, {
        retriable: false,
        nextAction: "change_target",
      });
    case "ip_literal":
    case "not_https":
    case "userinfo_present":
    case "unparseable":
      return errorResult("URL_NOT_ALLOWED", message, {
        retriable: false,
        nextAction: "change_target",
      });
  }
}

/**
 * Map a recheck rejection (issue #2) to a typed tool error. None of these run
 * judgment or consume units; the caller is told whether to wait, change the
 * target, or start a new review.
 */
function recheckRejectionResult(reason: RecheckRejectionReason, message: string): CallToolResult {
  switch (reason) {
    case "review_not_found":
      return errorResult("JOB_NOT_FOUND", message, {
        retriable: false,
        nextAction: "start_new_review",
      });
    case "review_not_completed":
      return errorResult("REVIEW_NOT_READY", message, { retriable: true, nextAction: "wait" });
    case "finding_not_found":
      return errorResult("FINDING_NOT_FOUND", message, {
        retriable: false,
        nextAction: "start_new_review",
      });
    case "host_changed":
      return errorResult("URL_NOT_ALLOWED", message, {
        retriable: false,
        nextAction: "start_new_review",
      });
    case "target_unchanged":
      return errorResult("TARGET_UNCHANGED", message, {
        retriable: false,
        nextAction: "change_target",
      });
    case "recheck_limit_reached":
      return errorResult("RECHECK_LIMIT_REACHED", message, {
        retriable: false,
        nextAction: "start_new_review",
      });
  }
}

/**
 * Build the MCP Review server with the v1 tool surface. All four catalog tools
 * — `design_review`, `design_review_get`, `design_recheck`, and
 * `design_review_cancel` — are wired, so the registered surface matches
 * schemas/mcp-tools.json exactly (no advertised-but-missing tool). Pass `deps`
 * (mock engine, fixed clock/ids) to make
 * the server deterministic under test — tests MUST never reach a real engine.
 *
 * The P0 SSRF guard (issue #4) is enforced whenever `deps.allowlist` and
 * `deps.resolver` are supplied. If they are omitted the server FAILS CLOSED: an
 * empty allowlist rejects every target as `DOMAIN_UNVERIFIED`, so a
 * misconfigured deployment can never capture an arbitrary URL.
 */
export function createMcpReviewServer(deps: ReviewServiceDeps = {}): McpServer {
  const service = new ReviewService({
    ...deps,
    allowlist: deps.allowlist ?? { tenantId: "unconfigured", targets: [] },
    resolver: deps.resolver ?? { resolve: async () => [] },
  });
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "design_review",
    {
      title: "Submit design review",
      description:
        "Submit an asynchronous, metered design review for a tenant-authorized HTTPS preview. " +
        "This tool never edits code. Reuse client_request_id on retries, then poll design_review_get " +
        "no faster than poll_after_ms.",
      inputSchema: designReviewInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { "com.apature/metered": true, "com.apature/product": "mcp-review" },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await service.submitReview(input);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof TargetAuthError) {
          return targetAuthErrorResult(err.reason, err.message);
        }
        if (err instanceof NormalizationError) {
          // Align the URL-violation taxonomy with design_recheck (issue #14): a
          // disallowed URL is URL_NOT_ALLOWED on BOTH tools; only a non-URL
          // argument violation (bad route prefix, too many routes/viewports) —
          // which design_recheck cannot produce — is INVALID_ARGUMENT.
          const code = err.kind === "url" ? "URL_NOT_ALLOWED" : "INVALID_ARGUMENT";
          return errorResult(code, err.message, {
            retriable: false,
            nextAction: "change_target",
          });
        }
        if (err instanceof IdempotencyConflictError) {
          return errorResult("IDEMPOTENCY_CONFLICT", err.message, {
            retriable: false,
            nextAction: "start_new_review",
          });
        }
        return errorResult("INTERNAL_ERROR", "the review could not be submitted", {
          retriable: true,
          nextAction: "wait",
        });
      }
    },
  );

  server.registerTool(
    "design_review_get",
    {
      title: "Get design review",
      description:
        "Get status or the compact Critique for an existing review job. Poll no faster than the " +
        "returned poll_after_ms. Result reads do not consume review units.",
      inputSchema: designReviewGetInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "com.apature/metered": false, "com.apature/product": "mcp-review" },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await service.getReview(input.job_id);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof JobNotFoundError) {
          return errorResult("JOB_NOT_FOUND", err.message, {
            retriable: false,
            nextAction: "start_new_review",
          });
        }
        if (err instanceof JobExpiredError) {
          return errorResult("JOB_EXPIRED", err.message, {
            retriable: false,
            nextAction: "start_new_review",
          });
        }
        return errorResult("INTERNAL_ERROR", "the review could not be retrieved", {
          retriable: true,
          nextAction: "wait",
        });
      }
    },
  );

  server.registerTool(
    "design_recheck",
    {
      title: "Submit design recheck",
      description:
        "Submit a metered recheck for findings from a completed review after the customer's agent " +
        "changes the UI. This tool never edits code. Unchanged targets and exhausted recheck loops " +
        "are rejected without running judgment. Reuse client_request_id on retries.",
      inputSchema: designRecheckInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { "com.apature/metered": true, "com.apature/product": "mcp-review" },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await service.submitRecheck(input);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof TargetAuthError) {
          return targetAuthErrorResult(err.reason, err.message);
        }
        if (err instanceof NormalizationError) {
          // A userinfo/non-https recheck url is a precise, non-retriable
          // URL_NOT_ALLOWED — not a generic INTERNAL_ERROR (issue #11).
          // design_recheck only normalizes a URL, so every NormalizationError
          // here is necessarily err.kind === "url" (see issue #14); this stays
          // URL_NOT_ALLOWED and now matches the design_review URL path exactly.
          return errorResult("URL_NOT_ALLOWED", err.message, {
            retriable: false,
            nextAction: "change_target",
          });
        }
        if (err instanceof RecheckRejectedError) {
          return recheckRejectionResult(err.reason, err.message);
        }
        if (err instanceof RecheckThrottledError) {
          // The review-chain unit window is a budget; everything else (per-
          // finding windows, principal burst, backoff) is a rate limit. Both
          // clear on their own, so the client should wait and retry.
          const code = err.kind === "chain_units_30min" ? "BUDGET_EXHAUSTED" : "RATE_LIMITED";
          return errorResult(code, err.message, {
            retriable: true,
            nextAction: "wait",
            retryAfterMs: err.retryAfterMs,
          });
        }
        if (err instanceof IdempotencyConflictError) {
          return errorResult("IDEMPOTENCY_CONFLICT", err.message, {
            retriable: false,
            nextAction: "start_new_review",
          });
        }
        return errorResult("INTERNAL_ERROR", "the recheck could not be submitted", {
          retriable: true,
          nextAction: "wait",
        });
      }
    },
  );

  server.registerTool(
    "design_review_cancel",
    {
      title: "Cancel design review",
      description:
        "Request best-effort cancellation of a queued or running review job. Terminal jobs keep their " +
        "existing state. Cancellation does not edit customer systems and consumes no review units.",
      inputSchema: designReviewCancelInputShape,
      annotations: {
        // Mutates Apature service job state (not customer systems), and an
        // exact retry returns the same terminal state — idempotent.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "com.apature/metered": false, "com.apature/product": "mcp-review" },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await service.cancelReview(input.job_id, input.reason);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof JobNotFoundError) {
          // Non-enumerating: unknown and wrong-tenant ids look identical.
          return errorResult("JOB_NOT_FOUND", "no such cancellable job", {
            retriable: false,
            nextAction: "start_new_review",
          });
        }
        if (err instanceof JobExpiredError) {
          return errorResult("JOB_EXPIRED", err.message, {
            retriable: false,
            nextAction: "start_new_review",
          });
        }
        if (err instanceof InsufficientScopeError) {
          return errorResult("INSUFFICIENT_SCOPE", err.message, {
            retriable: false,
            nextAction: "request_scope",
          });
        }
        return errorResult("INTERNAL_ERROR", "the review could not be cancelled", {
          retriable: true,
          nextAction: "wait",
        });
      }
    },
  );

  return server;
}
