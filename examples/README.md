# examples

Copy-pasteable starting points for adopting bastion. Every command referenced
here is the same one the README documents and the test suite exercises.

| File | What it is |
|---|---|
| [`mcp-client-local.json`](mcp-client-local.json) | Register the offline local stdio server (fixture judgments) with any MCP client — Claude Code, Cursor, Codex, VS Code. |
| [`mcp-client-configured.json`](mcp-client-configured.json) | The same registration with `BASTION_ALLOWED_HOSTS` and `VERDICT_CLI`/model env, so the server reviews your own preview URL for real. |
| [`dev-http-session.sh`](dev-http-session.sh) | Drive the remote (Streamable HTTP + OAuth 2.1) edge end to end against `pnpm dev:http`: 401 unauthenticated, authenticated `initialize`/`tools/list`, a review submission, and the SSRF rejection. |

## Using the client configs

Both JSON files use a placeholder absolute path,
`/absolute/path/to/bastion`. Replace it with the path to your clone after
`pnpm build`. Registration differs per client (some read `mcpServers` from a
settings file, some from a project file), but the `command`/`args`/`env` shape is
the same. `pnpm demo` spawns exactly the `mcp-client-local.json` command and
completes a real handshake against it, so the command itself is verified.

## Running the HTTP session example

```bash
# terminal 1
pnpm build && pnpm dev:http

# terminal 2 — paste the token the boot banner prints, then:
BASTION_TOKEN='eyJ...' bash examples/dev-http-session.sh
```

It needs only `curl`. No database, no IdP, no model: every judgment is a fixture
and says so in `provenance`.
