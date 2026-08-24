# @apature/mcp-server

The [Apature Bastion](https://github.com/apatureai/bastion) server: an in-loop, read-only design-review MCP server for coding agents. It exposes five agent-facing tools (`design_review`, `design_review_get`, `design_recheck`, `design_review_cancel`, `design_review_panel_action`) over two transports — a local stdio server that runs with no credentials, and a Streamable HTTP edge with OAuth 2.1 resource-server auth, per-tenant Postgres state, and submit-and-poll jobs. It judges and verifies a rendered UI; it never edits code.

With nothing configured the judgments come from a fixture and every review is stamped `provenance.model_backed: false`. Set `VERDICT_CLI` to a built [apatureai/verdict](https://github.com/apatureai/verdict) checkout and the same server reviews your page for real.

## Install

```bash
npm install @apature/mcp-server
```

## Usage

The package ships three binaries:

| Binary | What it is |
|---|---|
| `mcp-review-local` | the local stdio MCP server (fixture engine unless one is configured) |
| `mcp-review` | one-shot review of a URL through the configured backend |
| `mcp-review-server` | the production Streamable HTTP composition root (needs a database, issuer, and engine) |

Register the local server with any stdio MCP client:

```json
{
  "mcpServers": {
    "apature-review-local": {
      "command": "mcp-review-local"
    }
  }
}
```

Or compose the pieces directly:

```ts
import { createLocalReviewServer } from "@apature/mcp-server";

const server = createLocalReviewServer(); // fully offline, fixture judgments
```

## Configuration, the SSRF boundary, the OAuth edge, and running a real backend

are all documented in the [bastion repository README](https://github.com/apatureai/bastion#readme), including a no-credentials quickstart (`pnpm demo`), a local remote-edge walkthrough (`pnpm dev:http`), and how to point the server at a live judgment engine.

## License

MIT. See [LICENSE](LICENSE).
