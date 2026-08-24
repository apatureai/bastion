# Examples

Runnable examples for bastion. Each is self-contained and needs only a built checkout.

Build once from the repo root first:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

## `local-review/`

Drives the offline MCP server through one complete review loop and writes the resulting `Critique`
to `local-review/out/review.json`.

```bash
node examples/local-review/review.mjs
```

It uses **no dependencies** — only Node builtins — and speaks MCP's newline-delimited JSON-RPC over
the server's stdio directly, so the whole client is one readable file you can lift into your own
integration. A production client would use the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) client
instead; the repo's `pnpm demo` is that version of the same walkthrough.

Expected output ends with a submitted job, a `grade: unjudged`, three fixture findings, and a written
`out/review.json`. With nothing configured the judgments come from a fixture describing a fictional
pricing page, not the URL passed: `provenance.model_backed` is `false` and the grade is `"unjudged"`.
See the top-level README section [Getting real judgments](../README.md#getting-real-judgments) to
wire a real critique backend.
