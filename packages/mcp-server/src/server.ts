import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReviewError, ReviewErrorCode, NextAction } from "@apature/mcp-types";
import { NormalizationError } from "./normalize.js";
import {
  IdempotencyConflictError,
  JobNotFoundError,
  ReviewService,
} from "./review-service.js";
import type { ReviewServiceDeps } from "./review-service.js";
import { designReviewGetInputShape, designReviewInputShape } from "./tools.js";

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
 * Build the MCP Review server with the v1 tool surface. `design_review` and
 * `design_review_get` are wired; `design_recheck` and `design_review_cancel`
 * follow in their own issues. Pass `deps` (mock engine, fixed clock/ids) to make
 * the server deterministic under test — tests MUST never reach a real engine.
 */
export function createMcpReviewServer(deps: ReviewServiceDeps = {}): McpServer {
  const service = new ReviewService(deps);
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
        if (err instanceof NormalizationError) {
          return errorResult("INVALID_ARGUMENT", err.message, {
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
        const result = service.getReview(input.job_id);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof JobNotFoundError) {
          return errorResult("JOB_NOT_FOUND", err.message, {
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

  return server;
}
