import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The worked example: a real MCP client, over a real stdio transport, driving the
 * offline server (`local-stdio.ts`) through one complete review loop and writing
 * the two artifacts a person can actually look at.
 *
 * It spawns the server as a child process rather than importing it, so what runs
 * here is exactly what a coding agent would run when it launches this repo as a
 * local MCP server: same binary, same transport, same handshake.
 *
 * The demo pins the child to the offline fixture engine (`BASTION_ENGINE=fixture`)
 * no matter what the surrounding shell is configured with. Its target,
 * `preview.example.com`, is a host nothing is ever fetched from, so pointing a
 * real critique backend at it could only produce a capture failure; and the
 * transcript below is asserted in the README, which requires it to be
 * deterministic. To review a page for real, use `pnpm review <url>`.
 */

const OUT_DIR = resolve(process.cwd(), "out");
const SERVER_ENTRY = fileURLToPath(new URL("./local-stdio.js", import.meta.url));
const TARGET = "https://preview.example.com/pricing";

type ToolOutput = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; resource?: { text?: string } }>;
  structuredContent?: Record<string, unknown>;
};

const step = (n: number, title: string): void => {
  process.stdout.write(`\n[${n}] ${title}\n`);
};

/** The parent environment, minus unset keys, with the engine choice pinned. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.BASTION_ENGINE = "fixture";
  delete env.BASTION_ALLOWED_HOSTS;
  return env;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: childEnv(),
  });
  const client = new Client({ name: "mcp-review-demo", version: "1.0.0" });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolOutput> =>
    (await client.callTool({ name, arguments: args })) as ToolOutput;

  const info = client.getServerVersion();
  process.stdout.write(`connected to ${info?.name ?? "?"} v${info?.version ?? "?"} over stdio\n`);

  step(1, "tools/list");
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const metered = tool._meta?.["com.apature/metered"] === true ? "metered" : "free";
    process.stdout.write(`    ${tool.name.padEnd(28)} ${metered}\n`);
  }

  step(2, `design_review  ${TARGET}`);
  const submit = await call("design_review", {
    url: TARGET,
    routes: ["/pricing"],
    viewports: ["mobile", "desktop"],
    client_request_id: "demo-review-0001",
  });
  const job = submit.structuredContent?.job as { job_id: string; status: string };
  const budget = submit.structuredContent?.budget as { units_reserved: number };
  process.stdout.write(`    job ${job.job_id} -> ${job.status}, ${budget.units_reserved} unit(s)\n`);

  step(3, "design_review_get  view=status");
  const status = await call("design_review_get", { job_id: job.job_id, view: "status" });
  const statusJob = status.structuredContent?.job as { status: string };
  process.stdout.write(
    `    status=${statusJob.status}, review body present: ${String("review" in (status.structuredContent ?? {}))}\n`,
  );

  step(4, "design_review_get  view=summary");
  const summary = await call("design_review_get", { job_id: job.job_id, view: "summary" });
  const review = summary.structuredContent?.review as {
    review_id: string;
    grade: string;
    overall: string;
    findings: Array<{
      finding_id: string;
      severity: string;
      title: string;
      route: string;
      viewport: string;
      element_ref: string | null;
      suggestion: string | null;
    }>;
    not_reviewed: string[];
    provenance: { model_backed: boolean | null; source: string; engine: string };
  };
  process.stdout.write(`    review ${review.review_id} -> grade ${review.grade}\n`);
  // The point of printing this is that it is not the demo's commentary: it is a
  // field of the tool result, which is what an agent that never sees this
  // terminal would read.
  process.stdout.write(
    `    provenance: model_backed=${String(review.provenance.model_backed)}` +
      ` source=${review.provenance.source} engine=${review.provenance.engine}\n`,
  );
  process.stdout.write(`    ${review.overall}\n`);
  for (const f of review.findings) {
    process.stdout.write(
      `    ${f.finding_id}  ${f.severity.padEnd(10)} ${f.title}\n` +
        `             ${f.route} (${f.viewport}) ${f.element_ref ?? "-"}\n` +
        `             fix: ${f.suggestion ?? "advisory, no mechanical fix"}\n`,
    );
  }
  for (const n of review.not_reviewed) process.stdout.write(`    not reviewed: ${n}\n`);

  step(5, "design_review_get  view=focus  (nits dropped)");
  const focus = await call("design_review_get", { job_id: job.job_id, view: "focus" });
  const focused = (focus.structuredContent?.review as { findings: unknown[] }).findings;
  process.stdout.write(`    ${focused.length} actionable of ${review.findings.length} findings\n`);

  step(6, "design_review_get  view=evidence  (multimedia + MCP-Apps panel)");
  const evidence = await call("design_review_get", { job_id: job.job_id, view: "evidence" });
  const presentation = evidence.structuredContent?.presentation as {
    panel: boolean;
    panel_withheld: boolean;
    multimedia: boolean;
    images_withheld: string[];
  };
  const kinds = (evidence.content ?? []).map((b) => b.type);
  process.stdout.write(`    content blocks: ${kinds.join(", ")}\n`);
  process.stdout.write(
    `    panel=${presentation.panel} multimedia=${presentation.multimedia} withheld=[${presentation.images_withheld.join(", ")}]\n`,
  );

  const panelHtml = (evidence.content ?? []).find((b) => b.type === "resource")?.resource?.text;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
  if (panelHtml) writeFileSync(resolve(OUT_DIR, "panel.html"), panelHtml);
  process.stdout.write(`    wrote out/review.json and out/panel.html\n`);

  step(7, "design_review_panel_action  apply_fix  (eyes, not hands)");
  const first = review.findings[0]!;
  const applied = await call("design_review_panel_action", {
    job_id: job.job_id,
    action: "apply_fix",
    finding_id: first.finding_id,
  });
  const response = applied.structuredContent?.response as { type: string; fix?: string };
  process.stdout.write(`    ${first.finding_id} -> ${response.type}\n`);
  process.stdout.write(`    hand to the coding agent: ${response.fix ?? "(human review required)"}\n`);

  step(8, "design_recheck  after the agent claims a fix");
  const recheck = await call("design_recheck", {
    review_id: review.review_id,
    finding_ids: review.findings.map((f) => f.finding_id),
    expected_revision: "deploy-2",
    client_request_id: "demo-recheck-0001",
  });
  const outcomes = (
    recheck.structuredContent?.recheck as {
      capture_scope: string;
      outcomes: Array<{ finding_id: string; outcome: string; reason: string }>;
    }
  ).outcomes;
  for (const o of outcomes) {
    process.stdout.write(`    ${o.finding_id}  ${o.outcome.padEnd(12)} ${o.reason}\n`);
  }

  step(9, "design_review  https://evil.example.org/  (SSRF boundary)");
  const denied = await call("design_review", {
    url: "https://evil.example.org/",
    client_request_id: "demo-ssrf-0001",
  });
  const error = (denied.structuredContent as { error: { code: string; next_action: string } }).error;
  process.stdout.write(`    rejected: ${error.code} (next_action: ${error.next_action})\n`);

  process.stdout.write(
    `\nDone. ${review.findings.length} findings, ${outcomes.length} recheck outcomes.\n` +
      `Open out/panel.html in a browser to see the review panel.\n`,
  );
  await client.close();
}

await main();
