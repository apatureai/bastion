#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalReviewServer, LOCAL_ALLOWED_HOST } from "./local-server.js";

/**
 * Process entrypoint for the offline server: MCP Review over stdio, which is the
 * transport Claude Code, Cursor, Codex, and VS Code use for a local server.
 *
 * Kept separate from `local-server.ts` for the same reason `boot.ts` is separate
 * from `main.ts`: the factory stays importable (tests drive it over an in-memory
 * transport) without a module-load side effect that starts talking on stdout.
 *
 * stdout is the JSON-RPC channel and must carry nothing else — the banner goes to
 * stderr, where a host shows it as server log output.
 */

const server = createLocalReviewServer();
await server.connect(new StdioServerTransport());
process.stderr.write(
  `mcp-review local server ready on stdio — offline, fixture judgments, authorized host: ${LOCAL_ALLOWED_HOST}\n`,
);
