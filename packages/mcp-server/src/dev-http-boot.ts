/**
 * Process entrypoint for the local remote-edge walkthrough: `pnpm dev:http`.
 *
 * Boots the Streamable HTTP + OAuth 2.1 server (`dev-http.ts`) against a
 * fixture engine and an in-memory store, mints a working bearer token, and
 * prints a copy-pasteable recipe: the MCP endpoint, the token, the one host it
 * will authorize as a review target, and how to get a fresh token. Nothing here
 * needs a database, a real IdP, or a model. Every judgment is a fixture and says
 * so in `provenance`, exactly like `pnpm demo`.
 *
 * It is separate from `boot.ts` (the production root, which refuses to boot
 * without a real issuer, database, and engine, and never serves fixtures).
 */

import { bootDevHttp } from "./dev-http.js";

const handle = await bootDevHttp();

const line = "─".repeat(72);
process.stdout.write(
  [
    "",
    "bastion dev HTTP edge ready (Streamable HTTP + OAuth 2.1, fixture judgments)",
    line,
    `  MCP endpoint : ${handle.mcpUrl}`,
    `  target host  : ${handle.allowedTargetHosts.join(", ")}  (the only host this server will review)`,
    `  issuer JWKS  : ${handle.issuer.jwksUrl}`,
    `  fresh token  : curl -sX POST ${handle.issuer.tokenUrl}`,
    line,
    "  A bearer token for this session (tenant_id + reviews:cancel scope):",
    "",
    `  export BASTION_TOKEN='${handle.token}'`,
    "",
    "  List the tools over authenticated Streamable HTTP:",
    "",
    `  curl -sN ${handle.mcpUrl} \\`,
    '    -H "Authorization: Bearer $BASTION_TOKEN" \\',
    '    -H "Content-Type: application/json" \\',
    '    -H "Accept: application/json, text/event-stream" \\',
    `    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`,
    "",
    "  Everything the fixture judges is a fixture: provenance.model_backed is false.",
    "  Ctrl-C to stop.",
    line,
    "",
  ].join("\n"),
);

const shutdown = async (): Promise<void> => {
  await handle.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
