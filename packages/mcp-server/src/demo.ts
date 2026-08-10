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

/**
 * What the host does with a routed panel response. There are three answers and
 * only one of them is a string a coding agent may act on, which is the whole
 * point of the tool: a grounded fix goes to the agent, an advisory finding goes
 * to a person, and a review nothing judged goes nowhere at all.
 */
function handoff(response: { type: string; fix?: string }): string {
  if (response.type === "fix") return `hand to the coding agent: ${response.fix}`;
  if (response.type === "human_only") return "human review required: advisory judgment, no auto-fix";
  return "nothing to hand over: no model judged this review, so its fix text is fixture text";
}

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
      unjudged?: true;
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
    // The `[unjudged]` marker is the finding's own field, not the demo's gloss:
    // an agent looping this array and applying `suggestion` never reads the
    // envelope above, so each item has to say what it is by itself.
    process.stdout.write(
      `    ${f.finding_id}  ${f.severity.padEnd(10)} ${f.unjudged ? "[unjudged] " : ""}${f.title}\n` +
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
  process.stdout.write(`    ${handoff(response)}\n`);

  step(8, "design_recheck  after the agent claims a fix");
  const recheck = await call("design_recheck", {
    review_id: review.review_id,
    finding_ids: review.findings.map((f) => f.finding_id),
    expected_revision: "deploy-2",
    client_request_id: "demo-recheck-0001",
  });
  const rechecked = recheck.structuredContent?.recheck as {
    capture_scope: string;
    outcomes: Array<{ finding_id: string; outcome: string; confidence: number | null; reason: string }>;
    provenance: { model_backed: boolean | null; source: string; engine: string };
  };
  const outcomes = rechecked.outcomes;
  // This is the payload an agent reads to decide its fix landed and it can
  // stop, so it is stamped like the review and for a sharper reason.
  process.stdout.write(
    `    provenance: model_backed=${String(rechecked.provenance.model_backed)}` +
      ` source=${rechecked.provenance.source} engine=${rechecked.provenance.engine}\n`,
  );
  // Every outcome carries its own reason, because an agent looping this array
  // reads one element at a time. They are printed once when they are identical,
  // which on the fixture path they always are.
  const reasons = new Set(outcomes.map((o) => o.reason));
  for (const o of outcomes) {
    process.stdout.write(
      `    ${o.finding_id}  ${o.outcome.padEnd(12)} confidence=${String(o.confidence)}` +
        `${reasons.size === 1 ? "" : `  ${o.reason}`}\n`,
    );
  }
  if (reasons.size === 1) {
    process.stdout.write(`    reason on every outcome: ${[...reasons][0]}\n`);
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
