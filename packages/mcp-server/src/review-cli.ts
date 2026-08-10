#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EngineConfigError, resolveEngineRuntime, type EngineRuntime } from "./engine-runtime.js";

/**
 * Review one URL from the command line.
 *
 * `pnpm demo` is the worked example of the protocol against fixture judgments;
 * this is the same MCP client pointed at a target you choose, so the shortest
 * path from "cloned the repo" to "a real critique of my page" does not require
 * wiring an MCP host first. It spawns the local stdio server exactly as an
 * agent would, so nothing here is a private side door: whatever this prints,
 * the same server prints to Claude Code, Cursor or Codex.
 *
 * The target host is authorized for this run because you named it on the
 * command line, and the CLI says so before it runs. Everything else in the
 * boundary still applies: https only, no IP literals, real DNS resolution, and
 * the egress classification, so a private or loopback target is still rejected.
 */

const SERVER_ENTRY = fileURLToPath(new URL("./local-stdio.js", import.meta.url));

const USAGE = `bastion review: run one design review through the local MCP server.

Usage:
  node packages/mcp-server/dist/review-cli.js <https url> [options]

Options:
  --routes <a,b>       Root-relative routes to review (default: the URL's own path)
  --viewports <a,b>    mobile, tablet, desktop (default: mobile,desktop)
  --out <dir>          Where review.json and panel.html are written (default: out)
  -h, --help           Show this message

Environment (see README):
  VERDICT_CLI          path to a built apatureai/verdict checkout; without it the
                       findings come from a fixture and describe nothing real
  MODEL_BASE_URL       OpenAI-compatible endpoint verdict calls
  MODEL_API_KEY        bearer token for that endpoint
`;

interface Options {
  url: string;
  routes: string[];
  viewports: string[];
  outDir: string;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Options | null {
  let url: string | undefined;
  let routes: string[] | undefined;
  let viewports = ["mobile", "desktop"];
  let outDir = "out";

  const list = (flag: string, value: string | undefined): string[] => {
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) throw new UsageError(`${flag} needs at least one value`);
    return parts;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") return null;
    if (arg === "--routes") { routes = list("--routes", next); i += 1; continue; }
    if (arg === "--viewports") { viewports = list("--viewports", next); i += 1; continue; }
    if (arg === "--out") {
      if (next === undefined) throw new UsageError("--out requires a value");
      outDir = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown argument "${arg}"`);
    if (url !== undefined) throw new UsageError("only one url may be reviewed at a time");
    url = arg;
  }

  if (url === undefined) throw new UsageError("a url is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`"${url}" is not an absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new UsageError("only https targets are supported; the server rejects everything else");
  }
  return {
    url,
    routes: routes ?? [parsed.pathname === "" ? "/" : parsed.pathname],
    viewports,
    outDir,
  };
}

type ToolOutput = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; resource?: { text?: string } }>;
  structuredContent?: Record<string, unknown>;
};

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** The parent's environment, minus unset keys, with the target host authorized. */
function childEnv(host: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const configured = (process.env.BASTION_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  env.BASTION_ALLOWED_HOSTS = [...new Set([...configured, host])].join(",");
  return env;
}

async function run(options: Options, runtime: EngineRuntime): Promise<number> {
  const host = new URL(options.url).hostname;
  out(`bastion: reviewing ${options.url}`);
  out(`  engine: ${runtime.description}`);
  out(`  authorizing ${host} for this run because you named it on the command line`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: childEnv(host),
  });
  const client = new Client({ name: "bastion-review-cli", version: "1.0.0" });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolOutput> =>
    (await client.callTool({ name, arguments: args })) as ToolOutput;

  try {
    const submit = await call("design_review", {
      url: options.url,
      routes: options.routes,
      viewports: options.viewports,
      client_request_id: `cli-${Date.now()}`,
    });
    if (submit.isError) {
      const error = (submit.structuredContent as { error: { code: string; message: string } }).error;
      out(`\nrejected: ${error.code}\n  ${error.message}`);
      return 1;
    }

    const job = submit.structuredContent?.job as { job_id: string; status: string };
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

    // The grade printed here is the grade in the payload, not a decision this
    // CLI makes about what to show: the server already reports "unjudged"
    // whenever provenance says nothing looked at the page, so a person reading
    // this terminal and an agent reading out/review.json see the same verdict.
    out(`\nReview ${review.review_id}  grade ${review.grade}`);
    out(
      `  judged by: ${review.provenance.engine} (source ${review.provenance.source}, ` +
        `model_backed ${String(review.provenance.model_backed)})`,
    );
    out(`  ${review.overall}`);
    for (const finding of review.findings) {
      out(
        `\n  ${finding.finding_id}  ${finding.severity.padEnd(10)} ${finding.title}\n` +
          `           ${finding.route} (${finding.viewport}) ${finding.element_ref ?? "-"}\n` +
          `           fix: ${finding.suggestion ?? "advisory, no mechanical fix"}`,
      );
    }
    if (review.findings.length === 0) out("\n  no findings");
    if (review.not_reviewed.length > 0) {
      out("");
      for (const entry of review.not_reviewed) out(`  not reviewed: ${entry}`);
    }

    const evidence = await call("design_review_get", { job_id: job.job_id, view: "evidence" });
    const panelHtml = (evidence.content ?? []).find((b) => b.type === "resource")?.resource?.text;
    const outDir = resolve(process.cwd(), options.outDir);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
    if (panelHtml) writeFileSync(resolve(outDir, "panel.html"), panelHtml);
    out(`\nWrote ${resolve(outDir, "review.json")}`);
    if (panelHtml) out(`Wrote ${resolve(outDir, "panel.html")}`);

    if (review.provenance.model_backed === false) {
      // The one sentence that must survive every future edit of this file. It
      // is driven by the payload, so it cannot drift from what the file on disk
      // says about itself.
      out(
        `\nNOTHING ABOVE JUDGED YOUR PAGE. ${runtime.description}\n` +
          `The same fact is in the JSON: provenance.model_backed is false and grade is "unjudged".\n` +
          `See the README section "Getting real judgments" to configure a critique backend.`,
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}

let options: Options | null;
let runtime: EngineRuntime;
try {
  options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  runtime = resolveEngineRuntime(process.env);
} catch (error) {
  if (error instanceof UsageError || error instanceof EngineConfigError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  throw error;
}

process.exit(await run(options, runtime));
