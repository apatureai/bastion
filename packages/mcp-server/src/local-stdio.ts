#!/usr/bin/env node
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EngineConfigError, resolveEngineRuntime } from "./engine-runtime.js";
import { createLocalReviewServer, LOCAL_ALLOWED_HOST } from "./local-server.js";

/**
 * Process entrypoint for the local server: Bastion over stdio, which is the
 * transport Claude Code, Cursor, Codex, and VS Code use for a local server.
 *
 * Kept separate from `local-server.ts` for the same reason `boot.ts` is separate
 * from `main.ts`: the factory stays importable (tests drive it over an in-memory
 * transport) without a module-load side effect that starts talking on stdout.
 *
 * stdout is the JSON-RPC channel and must carry nothing else, so the banner and
 * every line of engine progress go to stderr, where a host shows them as server
 * log output. The banner always names the critique backend first, because the
 * one thing a reader must never have to guess is whether the findings they are
 * about to read came from a model or from a fixture.
 *
 * Environment:
 *   BASTION_ENGINE          auto (default) | fixture | verdict-cli | verdict-http
 *   VERDICT_CLI             path to a built verdict checkout; selects the CLI backend
 *   VERDICT_MODEL           auto (default) | mock | canned | live
 *   VERDICT_CONTEXT_DIR     directory whose design system grounds the critique
 *   MODEL_BASE_URL/MODEL_API_KEY   passed through to verdict for a live model
 *   ENGINE_BASE_URL/ENGINE_HMAC_SECRET   a running verdict job API instead
 *   BASTION_ALLOWED_HOSTS   comma-separated hosts to authorize besides the demo host
 */

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function main(): McpServer {
  const extraHosts = (process.env.BASTION_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);

  const runtime = resolveEngineRuntime(process.env, { log });
  const server = createLocalReviewServer({ allowedHosts: extraHosts, engine: runtime.create() });

  log("mcp-review local server ready on stdio");
  log(`  engine: ${runtime.description}`);
  log(`  authorized hosts: ${[LOCAL_ALLOWED_HOST, ...extraHosts].join(", ")}`);
  if (extraHosts.length === 0 && runtime.mode !== "fixture") {
    log(
      "  note: only the demo host is authorized, and nothing is ever fetched from it. " +
        "Set BASTION_ALLOWED_HOSTS to your own https preview host to review it.",
    );
  }
  return server;
}

let server: McpServer;
try {
  server = main();
} catch (error) {
  // A half-configured engine is a startup failure, never a quiet downgrade to
  // fixture judgments: that is the one outcome this server must not produce.
  if (error instanceof EngineConfigError) {
    log(`mcp-review failed to start: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
await server.connect(new StdioServerTransport());
