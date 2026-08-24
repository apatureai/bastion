#!/usr/bin/env node
/**
 * Standalone example: drive the offline bastion MCP server through one review
 * loop and write the resulting Critique to disk.
 *
 * It talks to the server the same way any MCP client does — spawning
 * `packages/mcp-server/dist/local-stdio.js` as a child process and exchanging
 * newline-delimited JSON-RPC over its stdio — but deliberately uses NO
 * dependencies, only Node builtins, so you can read the whole protocol in one
 * file and lift it into your own client. A production client would use the
 * official `@modelcontextprotocol/sdk` client instead (see the repo's
 * `pnpm demo`); this is the wire underneath it.
 *
 * Prerequisite: run `pnpm install && pnpm build` at the repo root first, so the
 * server's `dist/` exists.
 *
 * Run it:
 *   node examples/local-review/review.mjs
 *
 * With nothing configured the judgments come from a fixture describing a
 * fictional pricing page, not the URL below: `provenance.model_backed` is
 * `false` and the grade is `"unjudged"`. That is the point of the offline mode.
 * See the README section "Getting real judgments" to wire a real backend.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages/mcp-server/dist/local-stdio.js");
const outDir = resolve(here, "out");
const target = "https://preview.example.com/pricing";

// Spawn the offline server. BASTION_ENGINE=fixture pins it to the offline
// fixture engine regardless of the surrounding shell.
const child = spawn(process.execPath, [serverEntry], {
  stdio: ["pipe", "pipe", "inherit"], // server banner streams to our stderr
  env: { ...process.env, BASTION_ENGINE: "fixture" },
});

child.on("error", (err) => {
  console.error(`failed to spawn server (did you run 'pnpm build'?): ${err.message}`);
  process.exit(1);
});

// Minimal JSON-RPC-over-stdio client: one request id counter, a map of pending
// resolvers, and a line reader. MCP stdio framing is one JSON message per line.
let nextId = 1;
const pending = new Map();

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // ignore anything that is not a JSON-RPC message
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message ?? "JSON-RPC error"));
    else res(msg.result);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((res, reject) => {
    pending.set(id, { resolve: res, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function main() {
  // 1. Handshake.
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bastion-local-review-example", version: "1.0.0" },
  });
  console.log(`connected to ${init.serverInfo.name} v${init.serverInfo.version}`);
  notify("notifications/initialized", {});

  // 2. List the tools the server advertises.
  const { tools } = await request("tools/list", {});
  console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

  // 3. Submit a review. Against the offline server this completes synchronously.
  console.log(`\nsubmitting design_review for ${target}`);
  const submit = await request("tools/call", {
    name: "design_review",
    arguments: {
      url: target,
      routes: ["/pricing"],
      viewports: ["mobile", "desktop"],
      client_request_id: "example-review-0001",
    },
  });
  const jobId = submit.structuredContent?.job?.job_id;
  if (!jobId) {
    throw new Error("no job_id in design_review response");
  }
  console.log(`job ${jobId} -> ${submit.structuredContent.job.status}`);

  // 4. Read the result back in the default "summary" view.
  const getResult = await request("tools/call", {
    name: "design_review_get",
    arguments: { job_id: jobId, view: "summary" },
  });
  const critique = getResult.structuredContent?.review;
  if (!critique) {
    throw new Error("no review body in summary view");
  }

  console.log(`\ngrade: ${critique.grade}`);
  console.log(
    `provenance: model_backed=${critique.provenance.model_backed} source=${critique.provenance.source} engine=${critique.provenance.engine}`,
  );
  console.log(`findings: ${critique.findings.length}`);
  for (const f of critique.findings) {
    console.log(`  ${f.finding_id}  [${f.severity}] ${f.title}`);
  }

  // 5. Write the Critique to disk so you can inspect the full contract.
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "review.json");
  writeFileSync(outFile, `${JSON.stringify(critique, null, 2)}\n`);
  console.log(`\nwrote ${outFile}`);

  if (critique.provenance.model_backed === false) {
    console.log(
      "\nNOTHING JUDGED THIS PAGE. This is the offline fixture engine; the grade is \"unjudged\".",
    );
    console.log('See the README section "Getting real judgments" to configure a real backend.');
  }
}

main()
  .then(() => {
    child.stdin.end();
    child.kill();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`example failed: ${err.message}`);
    child.kill();
    process.exit(1);
  });
