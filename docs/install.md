# Installing Apature MCP Review

> **Archived.** Apature is wound down. The hosted endpoint `https://mcp.apature.ai/mcp`
> is no longer running, `https://apature.ai` is decommissioned, and no tokens are
> issued. Nothing below will connect. This page is retained as a record of the
> protocol, transport, and auth shape the server actually exposed, and as a
> reference for anyone self-hosting from this source — see
> [Running it yourself](#running-it-yourself) at the end.

Apature MCP Review is a remote **Streamable HTTP** MCP server. There is nothing
to run locally and no package to install — you point your MCP client at the
hosted endpoint and authenticate.

- **Endpoint:** `https://mcp.apature.ai/mcp`
- **Transport:** Streamable HTTP (MCP protocol `2025-11-25`)
- **Auth:** OAuth (preferred) or a tenant-scoped bearer token
- **Tools:** `design_review`, `design_review_get`, `design_recheck`,
  `design_review_cancel`

The machine-readable listing submitted to client directories is
[`directory/server.json`](../directory/server.json).

> **Read-only boundary.** Apature is the eyes; your agent is the hands. The
> server judges, explains, and verifies — it never edits code, commits, pushes,
> or opens pull requests. `design_review` and `design_recheck` create metered
> jobs; only `design_review_get` is read-only.

## Authentication

Tokens were issued from the Apature dashboard at `https://apature.ai`, which no
longer exists.
Clients that support OAuth should use the OAuth path (the server advertises
Protected Resource Metadata); clients that only support static headers can send
a bearer token:

```
Authorization: Bearer <APATURE_TOKEN>
```

Tokens are tenant-scoped. A review can only target a preview host your tenant
has ownership-verified (GitHub deployment, provider project binding, or a DNS/
HTTP domain challenge) — see the product docs for verification.

## Claude Code

Add the remote server with the CLI:

```bash
claude mcp add --transport http apature-review https://mcp.apature.ai/mcp \
  --header "Authorization: Bearer ${APATURE_TOKEN}"
```

Or add it to `.mcp.json` (project) / `~/.claude.json` (user):

```json
{
  "mcpServers": {
    "apature-review": {
      "type": "http",
      "url": "https://mcp.apature.ai/mcp",
      "headers": { "Authorization": "Bearer ${APATURE_TOKEN}" }
    }
  }
}
```

The tool descriptions are kept concise so they work well with Tool Search.
Because submit and recheck are metered, keep them under your approval policy
rather than auto-approving them.

## Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "apature-review": {
      "url": "https://mcp.apature.ai/mcp",
      "headers": { "Authorization": "Bearer ${APATURE_TOKEN}" }
    }
  }
}
```

Cursor supports the Streamable HTTP OAuth path; if you authenticate via OAuth
you can omit the static header and complete the browser flow on first use.

## VS Code (GitHub Copilot / MCP)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "apature-review": {
      "type": "http",
      "url": "https://mcp.apature.ai/mcp",
      "headers": { "Authorization": "Bearer ${input:apature_token}" }
    }
  },
  "inputs": [
    { "id": "apature_token", "type": "promptString", "description": "Apature token", "password": true }
  ]
}
```

VS Code honors the read-only annotation, so `design_review_get` is treated as a
safe read while submit/recheck require confirmation.

## GitHub Copilot coding agent

Configure a scoped bearer secret and the remote endpoint in the repository's
Copilot MCP configuration. Operation is tools-only; keep the metered submit,
recheck, and cancel tools under the agent's approval policy with hard budgets.

## Generic MCP client

Any client that speaks Streamable HTTP can connect:

| Setting | Value |
|---|---|
| URL | `https://mcp.apature.ai/mcp` |
| Transport | Streamable HTTP |
| Protocol | `2025-11-25` |
| Auth header | `Authorization: Bearer <APATURE_TOKEN>` |

## First call

1. `design_review` with a tenant-authorized `https` preview URL and a
   `client_request_id` you can reuse on retries.
2. Poll `design_review_get` no faster than the returned `poll_after_ms`.
3. Apply fixes with your agent, then `design_recheck` the affected findings.

The submit response returns quickly with a job and budget envelope; the review
runs asynchronously. Reuse `client_request_id` on retries and honor
`retry_after_ms` and budget limits.

## Verifying the listing

The listing is CI-gated from both sides: the directory manifest must match the
catalog in [`schemas/mcp-tools.json`](../schemas/mcp-tools.json)
(`packages/mcp-server/test/directory.test.ts`), and a real server instance's
`tools/list` + `serverInfo.version`, obtained over an in-process transport, must
match that same catalog and the listing version
(`packages/mcp-server/test/catalog-drift.test.ts`) — so a published listing can
never advertise tools, descriptions, annotations, input fields, or a version the
built server does not actually serve.

## Running it yourself

The hosted service is gone, but the server in this repository still builds and
runs. It is a source archive, not a drop-in replacement: it authenticates against
an OAuth issuer you provide, stores jobs in a Postgres database you provide, and
delegates all capture and inference to a Judgment Engine that is **not** part of
this release, so there is no end-to-end review path here.

```bash
pnpm install --frozen-lockfile
pnpm build
node packages/mcp-server/dist/boot.js
```

With no configuration this exits non-zero and names the first missing variable.
The full environment table is in
[`packages/mcp-server/DEPLOYMENT.md`](../packages/mcp-server/DEPLOYMENT.md), and
the durable application-plane requirements are in
[`application-plane.md`](application-plane.md).
