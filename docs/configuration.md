Part of [bastion](../README.md). Moved from the README on 2026-08-24; anchors preserved.

This file holds the critique-backend variable reference and the honest list of what is not wired yet. The [Getting real judgments](../README.md#getting-real-judgments) walkthrough and the HTTP-server variable table stay in the README.

### Configuring the backend

| Variable | Effect |
|---|---|
| `BASTION_ENGINE` | `auto` (default), `fixture`, `verdict-cli`, `verdict-http`. `auto` picks the CLI backend when `VERDICT_CLI` is set, then the job API when `ENGINE_BASE_URL` is set, then the fixture |
| `VERDICT_CLI` | Path to a built verdict checkout, or directly to its `packages/cli/dist/main.js`. Selects the CLI backend |
| `VERDICT_MODEL` | `auto` (default), `mock`, `canned`, `live`. `auto` is live when `MODEL_API_KEY` is set, canned otherwise, which is verdict's own rule. An explicit `live` requires both `MODEL_BASE_URL` and `MODEL_API_KEY` |
| `VERDICT_CONTEXT_DIR` | Directory holding `tokens.json`, `.designreview.yml` and `package.json`, which is what grounds the critique in your design system. Without it the critique is ungrounded, not broken |
| `VERDICT_OUT_DIR` | Where per-review artifact directories are written. Default `out/verdict` under the working directory |
| `VERDICT_TIMEOUT_MS` | Ceiling on one review. Default 900000, fifteen minutes |
| `MODEL_BASE_URL`, `MODEL_API_KEY` | Verdict's variables, passed through unchanged |
| `BASTION_ALLOWED_HOSTS` | Comma-separated hosts to authorize besides the demo host. `pnpm review` adds the host you name on the command line |
| `ENGINE_BASE_URL`, `ENGINE_HMAC_SECRET`, `ENGINE_INSTALLATION_ID` | A running verdict job API instead of the CLI. See below |

Half-configured states fail at startup rather than degrading to fixtures: a base URL with no signing secret, a live model with no endpoint, a live model with no key, an unbuilt verdict checkout, and an unknown mode name each stop the server with the reason.

### What is not wired yet

**`design_recheck` reports `"unjudged"` on the fixture path, and does not work against either verdict backend.** The fixture engine derives each outcome from a hash of the finding id, so the recheck payload says so: `outcome` is `"unjudged"`, `confidence` is `null`, and `provenance.model_backed` is `false`. It exercises the recheck protocol, the budgets and the rate limits; it tells you nothing about your page.

**`design_recheck` does not work against either verdict backend.** Verdict exposes no per-finding recheck, over the CLI or over its job API. Bastion could re-review the target and guess which findings matched, but a guess presented as a per-finding verdict is worse than an error, so both adapters refuse with that reason and `design_recheck` stays usable only against the fixture engine. The seam to fill is `EngineClient.recheck` in `src/engine-client.ts`, and the honest implementation needs a recheck surface upstream.

**The verdict job API backend has never been run against a real verdict deployment.** `src/verdict-job-engine.ts` speaks the documented contract (`POST /jobs`, `GET /jobs/:id`, `DELETE /jobs/:id`, the same `x-gate-signature` / `x-gate-installation` / `x-gate-timestamp` signing over the same canonical string, the same `x-schema-version` gate) and is tested against a stub, but verdict's long-running service additionally requires a `CAPTURE_ENDPOINT` capture fleet that verdict does not implement. Until that exists the CLI backend is the one that produces judgments, which is why `auto` prefers it.

**The live model path has not been exercised from this repository.** Everything up to and including the `--model live` command line is under test, and `MODEL_BASE_URL` / `MODEL_API_KEY` reach verdict unchanged, but the end-to-end runs recorded here used verdict's mock client, because this repository has no endpoint credentials. The live client itself is verdict's code and is covered by verdict's tests.

**Reviews block for as long as capture takes.** The local server runs the backend synchronously inside the `design_review` tool call, so a deep review of several routes can hold that call open for minutes. The durable submit-and-poll path that solves this exists in `review-service.ts` and is used by the HTTP composition root; the local server does not use it.
