import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AnnotatedImage,
  Critique,
  DesignReviewGetResult,
  HostMediaCapability,
  PanelAction,
  ReviewError,
  ReviewErrorCode,
  NextAction,
} from "@apature/mcp-types";
import { SCHEMA_VERSION } from "@apature/mcp-types";
import type { EvidenceProvider } from "./evidence.js";
import { buildDesignReviewContent } from "./multimedia-content.js";
import { renderReviewPanel } from "./panel-html.js";
import { buildPanelFindings, reviewFixItemsFromCritique } from "./panel-findings.js";
import { handlePanelAction } from "./panel-interaction.js";
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
  designReviewPanelActionInputShape,
} from "./tools.js";
import { advertiseCatalogSchemas } from "./tool-catalog.js";
import type { ToolListingMetadata } from "./tool-catalog.js";

const SERVER_NAME = "apature-mcp-review";
// Locked to directory/server.json `version` and schemas/mcp-tools.json
// `catalog_version` by the catalog-drift gate (#29): the version a client sees
// in serverInfo is the version the registry listing advertises.
const SERVER_VERSION = "1.3.0";

/**
 * What the connected host can render. The default is the MCP base protocol and
 * nothing more: `image` content blocks are core, so they are emitted; the MCP-Apps
 * HTML panel is an extension a host has to opt into, so it is withheld (and
 * reported as withheld) until a composition root says otherwise.
 */
const DEFAULT_HOST_MEDIA: HostMediaCapability = { images: true, appsPanel: false };

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

/** Everything the review service needs, plus how results are presented. */
export interface McpReviewServerDeps extends ReviewServiceDeps {
  /**
   * What the connected host can render (MCP `image` blocks, MCP-Apps HTML panel).
   * Defaults to images-only; whatever the host cannot render is reported as
   * withheld rather than dropped.
   */
  hostMedia?: HostMediaCapability;
  /**
   * Supplies annotated screenshot bytes for `design_review_get` with
   * `view: "evidence"`. With no provider the evidence view still returns the
   * findings and the panel, just with no image blocks.
   */
  evidence?: EvidenceProvider;
}

/** The `design_review_get` result views, narrowed to what this repo can produce. */
type ReviewView = "status" | "summary" | "findings" | "focus" | "evidence";

/**
 * The listing metadata for the five v1 tools: what a client is told each tool is
 * and how it behaves.
 *
 * The schemas are deliberately absent. `advertiseCatalogSchemas` serves those
 * from schemas/mcp-tools.json, so the published catalog and the wire cannot
 * drift apart. Prose and behavior hints stay here, in code, and the same object
 * feeds both `registerTool` and the listing, so one edit reaches both.
 */
const DESIGN_REVIEW_LISTING: ToolListingMetadata = {
  title: "Submit design review",
  description:
    "Submit an asynchronous, metered design review for a tenant-authorized HTTPS preview. " +
    "This tool never edits code. Reuse client_request_id on retries, then poll design_review_get " +
    "no faster than poll_after_ms.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { "com.apature/metered": true, "com.apature/product": "mcp-review" },
};

const DESIGN_REVIEW_GET_LISTING: ToolListingMetadata = {
  title: "Get design review",
  description:
    "Get status or a compact, focused, or evidence view for an existing review job. Poll no " +
    "faster than the returned poll_after_ms. Result reads do not consume review units.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { "com.apature/metered": false, "com.apature/product": "mcp-review" },
};

const DESIGN_RECHECK_LISTING: ToolListingMetadata = {
  title: "Submit design recheck",
  description:
    "Submit a metered recheck for findings from a completed review after the customer's agent " +
    "changes the UI. This tool never edits code. Unchanged targets and exhausted recheck loops " +
    "are rejected without running judgment. Check recheck.provenance before acting: when nothing " +
    "judged the target every outcome is unjudged with a null confidence. Reuse client_request_id " +
    "on retries.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { "com.apature/metered": true, "com.apature/product": "mcp-review" },
};

const DESIGN_REVIEW_CANCEL_LISTING: ToolListingMetadata = {
  title: "Cancel design review",
  description:
    "Request best-effort cancellation of a queued or running review job. Terminal jobs keep their " +
    "existing state. Cancellation does not edit customer systems and consumes no review units.",
  annotations: {
    // Mutates Apature service job state (not customer systems), and an
    // exact retry returns the same terminal state, so it is idempotent.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { "com.apature/metered": false, "com.apature/product": "mcp-review" },
};

const DESIGN_REVIEW_PANEL_ACTION_LISTING: ToolListingMetadata = {
  title: "Act on a review panel finding",
  description:
    "Route an interaction from the interactive review panel: return a grounded finding's fix for " +
    "the coding agent to apply, or the refs to re-verify. This tool never edits code. An advisory " +
    "finding returns human_only, never an automatic fix, and a review nothing judged returns " +
    "unjudged with no fix at all. Reads only; consumes no review units.",
  annotations: {
    // Routes work by reading a completed review. It creates no job, spends no
    // units, and changes nothing on either side of the boundary.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { "com.apature/metered": false, "com.apature/product": "mcp-review" },
};

/** `focus` = the actionable subset: blockers and should-fixes, nits dropped. */
function narrowToFocus(critique: Critique): Critique {
  return { ...critique, findings: critique.findings.filter((f) => f.severity !== "nit") };
}

/**
 * Shape a completed review as the multimedia `evidence` view: the MCP-Apps panel
 * (when the host renders one) followed by per-finding text and the annotated
 * evidence crops. This is the live call site for `multimedia-content.ts`. The
 * capability downgrade it implements is what a host that cannot render images or
 * panels actually receives, with `presentation` naming exactly what was withheld.
 */
async function evidenceResult(
  result: DesignReviewGetResult,
  critique: Critique,
  hostMedia: HostMediaCapability,
  evidence: EvidenceProvider | undefined,
): Promise<CallToolResult> {
  const evidenceIds = critique.findings
    .map((f) => f.evidence_id)
    .filter((id): id is string => id !== null);
  const images: readonly AnnotatedImage[] = evidence
    ? await evidence.forReview(critique.review_id, evidenceIds)
    : [];
  const panelFindings = buildPanelFindings(reviewFixItemsFromCritique(critique));
  const panelHtml = renderReviewPanel(critique, panelFindings, images);
  const built = buildDesignReviewContent(critique, images, hostMedia, panelHtml);

  const structured = {
    schema_version: SCHEMA_VERSION,
    job: result.job,
    review: critique,
    presentation: {
      panel: built.panel,
      panel_withheld: built.panel_withheld,
      multimedia: built.multimedia,
      images_withheld: built.images_withheld,
    },
  };
  return {
    content: built.content as CallToolResult["content"],
    structuredContent: structured,
  };
}

/**
 * Build the Bastion server with the v1 tool surface. All five catalog tools
 * (`design_review`, `design_review_get`, `design_recheck`,
 * `design_review_cancel`, and `design_review_panel_action`) are wired, so the
 * registered surface matches schemas/mcp-tools.json exactly (no
 * advertised-but-missing tool). Pass `deps` (mock engine, fixed clock/ids) to make
 * the server deterministic under test; tests MUST never reach a real engine.
 *
 * The P0 SSRF guard (issue #4) is enforced whenever `deps.allowlist` and
 * `deps.resolver` are supplied. If they are omitted the server FAILS CLOSED: an
 * empty allowlist rejects every target as `DOMAIN_UNVERIFIED`, so a
 * misconfigured deployment can never capture an arbitrary URL.
 */
export function createMcpReviewServer(deps: McpReviewServerDeps = {}): McpServer {
  const service = new ReviewService({
    ...deps,
    allowlist: deps.allowlist ?? { tenantId: "unconfigured", targets: [] },
    resolver: deps.resolver ?? { resolve: async () => [] },
  });
  const hostMedia = deps.hostMedia ?? DEFAULT_HOST_MEDIA;
  const evidence = deps.evidence;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "design_review",
    { ...DESIGN_REVIEW_LISTING, inputSchema: designReviewInputShape },
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
          // argument violation (bad route prefix, too many routes/viewports),
          // which design_recheck cannot produce, is INVALID_ARGUMENT.
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
    { ...DESIGN_REVIEW_GET_LISTING, inputSchema: designReviewGetInputShape },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await service.getReview(input.job_id);
        const view: ReviewView = input.view ?? "summary";
        // `status` never carries a result body, so it is answerable while the job
        // is still running and stays cheap for a polling loop.
        if (view === "status" || result.review === undefined) {
          return jsonResult({ schema_version: result.schema_version, job: result.job });
        }
        if (view === "evidence") {
          return await evidenceResult(result, result.review, hostMedia, evidence);
        }
        const review = view === "focus" ? narrowToFocus(result.review) : result.review;
        return jsonResult({ schema_version: result.schema_version, job: result.job, review });
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
    { ...DESIGN_RECHECK_LISTING, inputSchema: designRecheckInputShape },
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
          // URL_NOT_ALLOWED, not a generic INTERNAL_ERROR (issue #11).
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
    { ...DESIGN_REVIEW_CANCEL_LISTING, inputSchema: designReviewCancelInputShape },
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

  server.registerTool(
    "design_review_panel_action",
    { ...DESIGN_REVIEW_PANEL_ACTION_LISTING, inputSchema: designReviewPanelActionInputShape },
    async (input): Promise<CallToolResult> => {
      try {
        if (input.action === "apply_fix" && input.finding_id === undefined) {
          return errorResult("INVALID_ARGUMENT", "apply_fix requires a finding_id", {
            retriable: false,
            nextAction: "none",
          });
        }
        const result = await service.getReview(input.job_id);
        if (result.review === undefined) {
          return errorResult("REVIEW_NOT_READY", `job ${input.job_id} has no completed review yet`, {
            retriable: true,
            nextAction: "wait",
          });
        }
        const action: PanelAction =
          input.action === "apply_fix"
            ? { type: "apply_fix", finding_id: input.finding_id! }
            : { type: "recheck", ...(input.finding_id ? { finding_id: input.finding_id } : {}) };
        const panelFindings = buildPanelFindings(reviewFixItemsFromCritique(result.review));
        const response = handlePanelAction(action, panelFindings, result.review.provenance);
        if (response.type === "unknown_finding") {
          return errorResult(
            "FINDING_NOT_FOUND",
            `finding ${response.finding_id} does not belong to review ${result.review.review_id}`,
            { retriable: false, nextAction: "none" },
          );
        }
        return jsonResult({
          schema_version: SCHEMA_VERSION,
          job_id: input.job_id,
          review_id: result.review.review_id,
          // A routed `fix` is a string the caller is expected to act on, so this
          // payload answers "did anything judge the review it came from?" on its
          // own, without a second call back into design_review_get.
          provenance: result.review.provenance,
          response,
        });
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
        return errorResult("INTERNAL_ERROR", "the panel action could not be routed", {
          retriable: true,
          nextAction: "wait",
        });
      }
    },
  );

  // Advertise the published contract, not a second one derived from Zod: every
  // tool now carries the catalog's own inputSchema AND an outputSchema, so a
  // strict client can validate structured content for itself instead of taking
  // the repo's word for it. Throws here, at construction, if the registered set
  // and the catalog disagree in either direction.
  advertiseCatalogSchemas(server, [
    { name: "design_review", ...DESIGN_REVIEW_LISTING },
    { name: "design_review_get", ...DESIGN_REVIEW_GET_LISTING },
    { name: "design_recheck", ...DESIGN_RECHECK_LISTING },
    { name: "design_review_cancel", ...DESIGN_REVIEW_CANCEL_LISTING },
    { name: "design_review_panel_action", ...DESIGN_REVIEW_PANEL_ACTION_LISTING },
  ]);

  return server;
}
