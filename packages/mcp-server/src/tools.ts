import { z } from "zod";

/**
 * Zod input schemas for the v1 tools: what the server PARSES.
 *
 * What clients are TOLD is a separate artifact, `schemas/mcp-tools.json`, served
 * verbatim by `tool-catalog.ts`. The SDK used to derive the advertised schema
 * from these shapes, which meant two published contracts, only one of them
 * checked, and a catalog free to reject calls the server accepted. Now there is
 * one advertised contract and the schema-conformance test drives real calls
 * through both, so a shape here that disagrees with the catalog fails CI.
 */

/**
 * The coarse scheme gate for a preview URL. https is always allowed; plain http
 * is allowed ONLY for a loopback dev host (localhost, 127.0.0.0/8, ::1) so an
 * agent can review its own local dev server, the core in-loop case.
 *
 * This is a cheap prefix check; the precise policy (loopback classification,
 * IPv4 octet ranges, userinfo, egress) lives in `normalize.ts` and
 * `target-auth.ts`, which reject with the specific error codes. This pattern
 * MUST stay identical to the `pattern` on the `url` property in
 * `schemas/mcp-tools.json`: the advertised catalog and this parser are two
 * artifacts kept in lockstep, and `schema-permissiveness.test.ts` fails if the
 * catalog ever permits a URL this parser would reject.
 */
export const PREVIEW_URL_PATTERN = /^(https:\/\/|http:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])([:/?#]|$))/;

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .regex(PREVIEW_URL_PATTERN, "only https preview URLs are supported (http is allowed only for localhost/127.0.0.0/8/::1)")
  .describe(
    "Tenant-authorized remote https preview URL. Plain http is accepted only for a loopback dev host (localhost, 127.0.0.0/8, ::1). Userinfo and fragments are rejected.",
  );

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
    // The floor is 3, not 8: the engine's review result (mirrored byte-for-byte
    // from apatureai/gate's golden fixture) uses short ids like "f_001", and the
    // ids that exist are the ids the tool has to accept. The catalog floored
    // them at 8, so the published contract rejected the server's own fixture;
    // it now says 3 as well.
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
