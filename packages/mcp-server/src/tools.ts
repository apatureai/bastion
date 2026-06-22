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

export const designReviewInputSchema = z.object(designReviewInputShape);
export const designReviewGetInputSchema = z.object(designReviewGetInputShape);

export type DesignReviewToolInput = z.infer<typeof designReviewInputSchema>;
export type DesignReviewGetToolInput = z.infer<typeof designReviewGetInputSchema>;
