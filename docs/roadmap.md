Part of [bastion](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Status and roadmap

Working today, covered by the suite:

| Component | Notes |
|---|---|
| Local MCP server (stdio, offline) | `pnpm demo`, `pnpm start:local` |
| Real critique backend over a local verdict checkout | `pnpm review <url>`; see [Getting real judgments](../README.md#getting-real-judgments) |
| All five tools, five views, panel round trip | End to end in the quickstart |
| Target authorization + egress classification | Enforced by the local server too |
| Job lifecycle, idempotency, recheck semantics, budgets | Including zero-charge rejection paths |
| Streamable HTTP edge: OAuth 2.1 auth, limits, per-client isolation | Tested over real HTTP |
| Postgres application plane, RLS, migration arbitration | Tested against PGlite and real Postgres |

Known gaps, in rough priority order. Each names the seam to work against, and each is a reasonable first contribution.

**1. Finish the critique backend.** The main gap in earlier releases was that judgments were fixtures with no way to make them real. That is closed for reviews: `VERDICT_CLI` points this server at a local [apatureai/verdict](https://github.com/apatureai/verdict) checkout, verdict captures and critiques the page, and its `EngineReviewResult` flows through the same `EngineClient` port the fixture mock uses. See [Getting real judgments](../README.md#getting-real-judgments). Three pieces of that work are genuinely unfinished, and each is a good contribution:

- **`design_recheck` against a verdict backend.** Verdict has no per-finding recheck surface, over its CLI or its job API, so both adapters refuse rather than synthesizing outcomes. The seam is `EngineClient.recheck`; the honest fix starts upstream, with a recheck endpoint that re-captures the flagged elements.
- **Run the job API backend against a real verdict deployment.** `src/verdict-job-engine.ts` speaks the contract and is tested against a stub, but verdict's long-running service needs a `CAPTURE_ENDPOINT` capture fleet that verdict does not implement, so the two programs have never met over HTTP. Reporting where the shapes disagree, once one exists, is exactly the useful bug report.
- **Verify the live model path from here.** The `--model live` command line is under test and the endpoint variables are passed through unchanged, but the end-to-end runs recorded in this README used verdict's mock client, because this repository has no endpoint credentials.

**2. Screenshot capture.** Not implemented here, and still not planned to live here: capture belongs behind the engine boundary above, and it is already written there. `verdict` drives headless Chromium through playwright-core and produces deterministic screenshots plus a DOM geometry map, and with `VERDICT_CLI` set those screenshots land in `out/verdict/<run>/screenshots` on every review. What this repository still lacks is a way to serve them back through the MCP evidence view, which is item 3.

**3. Real evidence images.** `EvidenceProvider` in `src/evidence.ts` is the seam and it is documented; the only implementation is `SyntheticEvidenceProvider`, which emits deterministic placeholder PNGs (real bytes, no pixels of your page). This one got easier: with `VERDICT_CLI` configured, verdict writes the real screenshots to `out/verdict/<run>/screenshots` and stamps each finding's `screenshotId` with the key it wrote them under, so a provider that reads that directory is a self-contained, testable change that would put your own page into the evidence view and the panel.

**4. Move the recheck index and unit ledger into the store.** Job records persist to Postgres, but the recheck index and the tenant unit counter (a flat 1000 per `ReviewService`) live in memory on an instance constructed per MCP connection, so a recheck only resolves a review submitted on the same connection. The fix is to read the review back from `ReviewApplicationStore` and move the ledger into it. Well-scoped and high value for anyone actually deploying this.

**5. Domain-ownership verification.** `target-auth.ts` enforces the verified-host list and `002_review_targets.sql` stores it, but nothing here issues or checks the DNS / well-known / deployment proofs that put a row in that table; rows are expected pre-verified. A proof issuer is a clean standalone module.

**6. Engine-side view projections.** `design_review_get`'s `focus` and `evidence` views are projections of the local `Critique`. The original design also specified coverage counts, a paginated finding index, and `patchContext` for selected element refs, which were computed upstream. They could be computed here instead.

**7. Feedback events.** `schemas/feedback-event.schema.json` defines the contract; there is no writer in `src/`. Wiring one up is how the review loop learns which findings a team actually accepts.

**8. Metering beyond a single replica.** Units are reserved and consumed on job records. There is no payment integration and no cross-replica ledger.

**9. Stateless transport adapter.** The protocol baseline is `2025-11-25`. The design reserved room for a stateless `2026-07-28` adapter; it does not exist yet.

**10. MCP Tasks adapter.** `execution.taskSupport` is `forbidden` in the catalog, because application job ids were always the canonical handle. Exposing jobs as MCP Tasks as well is a compatible addition.

**11. `design_direction` tool.** Specified, deliberately deferred, still unimplemented.

**12. Track down one flaky run.** A single unidentified test failure appeared once in roughly 43 consecutive full-suite runs and has not reproduced since. If you see a red run on an unchanged commit, re-run before treating it as a regression, and if you can reproduce it, that is a genuinely useful bug report.

Two honesty notes that are not roadmap items so much as things to know.

**There are still no published quality numbers, so assume no measured accuracy claims.** The harness to produce them is no longer missing, though: it lives in [apatureai/verdict](https://github.com/apatureai/verdict) under `packages/eval`, which carries the canaries, the golden-set tooling, and the precision, recall and human-agreement metrics, and it declares the bars it grades against as `DEFAULT_QUALITY_BARS` in `packages/eval/src/quality-gate.ts`. What has not happened is a promoted candidate run, so neither repo publishes a results table. With `VERDICT_CLI` configured the judgments you get here are verdict's, which means any number measured there would describe them; there is simply no such number yet.

**The auth path has not had an external security review.** The OAuth 2.1 resource-server code, the token verifier and the SSRF boundary are covered by this repo's own tests and nothing more. See [SECURITY.md](../SECURITY.md).

Some modules are exported from `packages/mcp-server/src/index.ts` and not yet reachable from either composition root (the HTTP evidence path, for instance). They are exported on purpose so a fork can compose them, and they are covered by unit tests, but treat "exported" as "available", not "wired".
