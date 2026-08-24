#!/usr/bin/env node
/**
 * Container entrypoint. This module exists only to run the production
 * composition root as a process.
 *
 * It is deliberately separate from `main.ts`. The boot guard used to live at
 * the bottom of `main.ts` as `await import("./production.js")`, but
 * `production.ts` statically imports `startFromEnv` from `main.ts`. When
 * `main.js` was the process entry, its top-level await blocked on evaluating
 * `production.js`, which was waiting on the still-evaluating `main.js`, an ESM
 * cycle whose top-level await never settled, so `node dist/main.js` exited 13
 * with "Detected unsettled top-level await" and never reached the intended
 * fail-fast error message.
 *
 * With the guard here the import graph is acyclic (boot -> production -> main),
 * so missing config or an unusable database exits non-zero with a readable
 * reason, never a green-but-unusable listener, and never an opaque Node
 * internals warning.
 */

import { bootProduction } from "./production.js";

bootProduction().catch((error: unknown) => {
  console.error(`mcp-review failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
