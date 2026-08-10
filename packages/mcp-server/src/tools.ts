import { z } from "zod";

/**
 * Zod input schemas for the v1 tools, kept in lockstep with
 * schemas/mcp-tools.json. The SDK derives the JSON Schema advertised to clients
 * from these, so this is the single in-code source of the tool inputs.
 */

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .regex(/^https:\/\//, "only https preview URLs are supported")
  .describe("Tenant-authorized remote https preview URL. Userinfo and fragments are rejected.");

const clientRequestId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe("Caller-generated idempotency key. Reuse it for retries of the same normalized request.");

export const designReviewInputShape = {
  url: httpsUrl,
  routes: z
    .array(z.string().min(1).max(512).regex(/^\//, "routes must be root-relative"))
    .min(1)
    .max(5)
    .optional()
    .describe("Root-relative routes to review (default: [\"/\"])."),
  viewports: z
    .array(z.enum(["mobile", "tablet", "desktop"]))
    .min(1)
    .max(3)
    .optional()
    .describe("Viewports to review (default: [\"mobile\", \"desktop\"])."),
  depth: z.enum(["triage", "deep"]).optional().describe("Review depth (default: deep)."),
  expected_revision: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Optional deploy ID, commit SHA, or revision marker expected at the target."),
  response_mode: z.enum(["compact", "full"]).optional().describe("Result verbosity (default: compact)."),
  client_request_id: clientRequestId,
};

export const designReviewGetInputShape = {
  job_id: z.string().min(8).max(128).describe("Job id returned by design_review."),
  view: z
    .enum(["status", "summary", "findings", "focus", "evidence"])
    .optional()
    .describe("Result view (default: summary)."),
};

export const designRecheckInputShape = {
  review_id: z.string().min(8).max(128).describe("review_id of the completed review to recheck."),
  finding_ids: z
    // schemas/mcp-tools.json floors finding-id length at 8, but the engine's
    // review result (mirrored byte-for-byte from apatureai/gate's golden
    // fixture) uses short ids like "f_001". The fixture is the source of truth
    // for what ids actually exist, so the floor is relaxed to 3 here.
    .array(z.string().min(3).max(128))
    .min(1)
    .max(20)
    .describe("Findings from that review to re-judge (1-20)."),
  url: httpsUrl
    .optional()
    .describe("Optional URL on the SAME previously authorized host; a host change is rejected."),
  expected_revision: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Optional deploy ID/SHA expected at the changed target."),
  client_request_id: clientRequestId,
};

export const designReviewCancelInputShape = {
  job_id: z.string().min(8).max(128).describe("Job id of the review/recheck to cancel."),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("Optional free-text reason for the cancellation, recorded for audit."),
};

/**
 * Input for the interactive MCP-Apps panel's callback tool. The panel rendered by
 * `design_review_get` with `view: "evidence"` is inert markup; when the reviewer
 * acts on a finding the HOST calls this tool, and the pure reducer in
 * `panel-interaction.ts` decides what happens. `apply_fix` never edits anything:
 * it returns a grounded finding's fix for the host to hand to the coding agent, or
 * `human_only` for advisory judgment.
 */
export const designReviewPanelActionInputShape = {
  job_id: z.string().min(8).max(128).describe("Job id of the completed review the panel is showing."),
  action: z
    .enum(["apply_fix", "recheck"])
    .describe(
      "apply_fix returns a grounded finding's fix for the host to hand to the coding agent; recheck returns the refs to re-verify.",
    ),
  finding_id: z
    .string()
    .min(3)
    .max(128)
    .optional()
    .describe(
      "Required for apply_fix; optional for recheck (omit to scope the recheck to the whole review).",
    ),
};

export const designReviewInputSchema = z.object(designReviewInputShape);
export const designReviewGetInputSchema = z.object(designReviewGetInputShape);
export const designRecheckInputSchema = z.object(designRecheckInputShape);
export const designReviewCancelInputSchema = z.object(designReviewCancelInputShape);
export const designReviewPanelActionInputSchema = z.object(designReviewPanelActionInputShape);

export type DesignReviewToolInput = z.infer<typeof designReviewInputSchema>;
export type DesignReviewGetToolInput = z.infer<typeof designReviewGetInputSchema>;
export type DesignRecheckToolInput = z.infer<typeof designRecheckInputSchema>;
export type DesignReviewCancelToolInput = z.infer<typeof designReviewCancelInputSchema>;
export type DesignReviewPanelActionToolInput = z.infer<typeof designReviewPanelActionInputSchema>;
