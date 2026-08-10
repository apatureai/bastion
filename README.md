# mcp-review

**Archived and provided as-is. No updates expected.** Issues and pull requests are not monitored. Last verified working 2026-08-09 on macOS 15 + Node 24.14.0 + pnpm 9.15.0.

An MCP server that hands a coding agent structured design-review findings for a web preview, then re-verifies the findings after the agent fixes them.

## Why this exists

Apature was a GitHub-native AI design reviewer: screenshot a PR's preview deploy, judge the rendered UI against the repo's own design system with a vision-language model, and post the critique. This repository is the agent-facing half: the MCP server and the control plane around it. The company was wound down in 2026 and the code is published under MIT as a record of the engineering.

The capture and the model inference lived in a separate service that is not part of this release. What is here runs offline against a fixture judgment, which is enough to exercise every part of the protocol surface: the tools, the job lifecycle, the SSRF boundary, the result views, the multimedia evidence, and the review panel.

## What it does

- Runs a complete five-tool MCP server locally over stdio, with no credentials, no database, no network calls, and no model.
- Submits a review of an HTTPS preview URL as an async job, and serves the result through five views: `status`, `summary`, `findings`, `focus`, `evidence`.
- Returns findings as MCP content blocks (an interactive HTML review panel, per-finding text, and annotated evidence images), degrading honestly on a host that cannot render one of those.
- Rechecks 1 to 20 findings from a completed review after the agent claims a fix, and rejects an unchanged target without spending anything.
- Authorizes every target before it would ever be fetched: HTTPS-only canonicalization, an ownership-verified host allowlist, and full IP-range egress classification with DNS-rebind rejection.
- Carries the Streamable HTTP edge for the same tools: OAuth 2.1 resource-server auth (RFC 9728 discovery, JWKS/JWT), per-client transport isolation, and a Postgres application plane. The test suite exercises that edge end to end over real HTTP and, with `MCP_TEST_DATABASE_URL`, real Postgres.

## What it does not do

- **It never edits code.** No patching, committing, pushing, opening pull requests, or driving a browser. It returns judgments and evidence; the agent on the other end does the work. Internally: "Apature is the eyes, the agent is the hands."
- **It does not screenshot anything, and it does not call a model.** Both lived in a separate service. See [Limitations](#limitations).
- **It does not judge the URL you pass.** Offline, the findings come from a golden fixture describing a fictional pricing page.
- **It does not stand up as a hosted service.** Production mode needs an OAuth issuer, a Postgres instance, and a judgment engine that is not part of this release, so it can boot but never complete a review. The local server is the runnable path.

## Requirements

| Requirement | Check | Notes |
|---|---|---|
| Node 24+ | `node -v  # need v24.0.0+` | Verified on v24.14.0; `.node-version` pins 24 |
| pnpm 9.15.0 | `pnpm -v  # need 9.15.0` | `corepack enable` installs it from the `packageManager` field |
| macOS 15 | n/a | The only OS this run verified. CI ran ubuntu-latest |

No credentials, API keys, network access, or Docker are needed for anything in Install, Quickstart, or Development. Dependencies are pinned and `pnpm-lock.yaml` is committed, so install with `--frozen-lockfile`.

One optional extra: Docker, only to run the single Postgres-backed test that is skipped by default (see [Development](#development)).

## Install

From a clean clone, run in the repository root:

```bash
git clone https://github.com/apatureai/mcp-review.git
cd mcp-review
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` is part of installing, not an optional step: everything below runs compiled JavaScript out of `packages/*/dist`.

## Quickstart

One command runs a full review loop: a real MCP client spawns the local server as a child process over stdio, submits a review, reads it back four ways, acts on a finding, rechecks it, and gets denied on an unauthorized host.

```console
$ pnpm demo

> @apature/mcp-review-monorepo@0.0.0 demo /Users/you/mcp-review
> node packages/mcp-server/dist/demo.js

mcp-review local server ready on stdio — offline, fixture judgments, authorized host: preview.example.com
connected to apature-mcp-review v1.1.0 over stdio

[1] tools/list
    design_review                metered
    design_review_get            free
    design_recheck               metered
    design_review_cancel         free
    design_review_panel_action   free

[2] design_review  https://preview.example.com/pricing
    job job_d2c6ce3b-e189-47f6-a6eb-05482aff0ee8 -> completed, 1 unit(s)

[3] design_review_get  view=status
    status=completed, review body present: false

[4] design_review_get  view=summary
    review rev_7973205c-67a5-4b33-a56a-5917888d5396 -> grade needs_work
    The new pricing page reads clearly on desktop, but the mobile layout breaks the design system: the primary CTA loses its brand color and the card grid overflows the viewport. Two nits on spacing.
    f_001  should_fix Primary CTA uses an off-brand color on mobile
             /pricing (mobile) button[data-testid='cta-primary']
             fix: Apply the `--color-accent` token (or the `btn-primary` class) so the CTA matches the brand accent used elsewhere.
    f_002  should_fix Pricing card grid overflows the mobile viewport
             /pricing (mobile) .pricing-grid
             fix: Switch the grid to a single column under the `sm` breakpoint.
    f_003  nit        Inconsistent vertical rhythm between feature rows
             /pricing (desktop) .feature-row
             fix: Use a single spacing token for consistent vertical rhythm.
    not reviewed: route /checkout (no preview deployment matched the head SHA)
    not reviewed: viewport tablet (not configured)

[5] design_review_get  view=focus  (nits dropped)
    2 actionable of 3 findings

[6] design_review_get  view=evidence  (multimedia + MCP-Apps panel)
    content blocks: resource, text, text, image, text, image, text, text
    panel=true multimedia=true withheld=[]
    wrote out/review.json and out/panel.html

[7] design_review_panel_action  apply_fix  (eyes, not hands)
    f_001 -> fix
    hand to the coding agent: Apply the `--color-accent` token (or the `btn-primary` class) so the CTA matches the brand accent used elsewhere.

[8] design_recheck  after the agent claims a fix
    f_001  passed       The flagged issue is no longer observed at the target.
    f_002  failed       The flagged issue is still present after the change.
    f_003  passed       The flagged issue is no longer observed at the target.

[9] design_review  https://evil.example.org/  (SSRF boundary)
    rejected: DOMAIN_UNVERIFIED (next_action: verify_domain)

Done. 3 findings, 3 recheck outcomes.
Open out/panel.html in a browser to see the review panel.
```

**Success looks like:** nine numbered steps, `3 findings, 3 recheck outcomes`, and two new files. `out/review.json` is the agent-facing Critique; `out/panel.html` is the review panel. Open it:

```bash
open out/panel.html      # macOS; use xdg-open on Linux
```

The panel is plain self-contained HTML, with no scripts, no external requests, and evidence embedded as `data:` URIs. It shows the grade `needs_work`, the overall verdict, all three findings with route, viewport, element ref, description and suggested fix, an evidence image under `f_001` and `f_002`, the two not-reviewed entries, and a routing label on each finding. All three are labelled `agent-appliable` here, because every finding in the fixture is localizable and carries a concrete fix; an advisory finding is labelled `needs a human`. The `job_*` and `rev_*` ids are freshly generated, so yours will differ from the transcript above.

If `pnpm demo` reports `Cannot find module`, `pnpm build` has not been run. If the review comes back `DNS_TARGET_PROHIBITED` instead of a job, something changed `LOCAL_RESOLVED_ADDRESS` in `packages/mcp-server/src/local-server.ts` to a non-public address. That rejection is the SSRF guard working.

### What is real and what is synthetic

The local server is honest about its own boundary:

| Part | Offline behaviour |
|---|---|
| MCP protocol, tools, input validation, error taxonomy | Real |
| Target authorization, egress classification, DNS-rebind rejection | Real (runs on every submit) |
| Job lifecycle, idempotency, budgets, recheck rejection and throttling | Real |
| Views, content blocks, panel projection and reducer | Real |
| The findings themselves | **Fixture.** A golden engine result about a fictional pricing page, not a judgment of the URL you passed |
| DNS | **Stub.** One fixed public address, returned without a lookup; no network call is made |
| Evidence crops | **Placeholder.** Deterministic generated PNGs where the engine's annotated screenshots would be |

## Usage

### Connect your own MCP client

The local server speaks MCP over stdio, which is what Claude Code, Cursor, Codex, and VS Code use for a local server. The command is:

```bash
node /absolute/path/to/mcp-review/packages/mcp-server/dist/local-stdio.js
```

`pnpm demo` spawns exactly that command and completes a real MCP handshake against it, so the command itself is verified here; how you register it differs per client. Most take a JSON block of this shape:

```json
{
  "mcpServers": {
    "apature-review-local": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-review/packages/mcp-server/dist/local-stdio.js"]
    }
  }
}
```

The only host the local server will authorize is `preview.example.com`; every other host is rejected as `DOMAIN_UNVERIFIED`. To add your own, edit `packages/mcp-server/src/local-stdio.ts` and rebuild; the factory takes the extra hosts directly:

```ts
import { createLocalReviewServer } from "./local-server.js";

const server = createLocalReviewServer({ allowedHosts: ["preview.mycompany.com"] });
```

Remember what that buys you: the target is authorized for real, and then judged from a fixture. It will not tell you anything about your page.

### Tool surface

| Tool | Metered | What it does |
|---|---|---|
| `design_review` | yes | Submit an async review of an authorized HTTPS preview (routes, viewports, `triage`/`deep` depth). Returns a job. |
| `design_review_get` | no | Poll job status or read the result in one of five views. |
| `design_recheck` | yes | Re-judge 1 to 20 findings from a completed review after the agent changed the UI. Rejects a host change or an unchanged target. |
| `design_review_cancel` | no | Best-effort cancel of a queued or running job; requires the `reviews:cancel` scope. |
| `design_review_panel_action` | no | Route a review-panel interaction: return a grounded finding's fix for the agent, or the refs to re-verify. |

MCP annotations are set from the truth rather than from the marketing: only `design_review_get` and `design_review_panel_action` carry `readOnlyHint: true`, because submit and recheck create metered jobs and cancel terminates one. "Read-only" describes the customer's code, not every tool.

### `design_review_get` views

| `view` | Returns |
|---|---|
| `status` | The job envelope only. No result body, so it stays cheap while a job is still running. |
| `summary` (default) | Job plus the full `Critique`. |
| `findings` | Same body as `summary`; the `Critique` already carries every finding inline. |
| `focus` | Job plus the `Critique` narrowed to actionable findings: `blocker` and `should_fix`, with nits dropped. |
| `evidence` | Job, `Critique`, MCP content blocks (panel, text, images), and a `presentation` object naming what the host could not render. |

The original design specified richer server-side projections for these views (coverage counts, a paginated finding index, `patchContext` for selected element refs). Those were computed by the engine, which is not in this release, so the views here are projections of the `Critique` this repo holds.

### The eyes-not-hands boundary, in code

`design_review_panel_action` is where the product boundary is easiest to violate and easiest to test. A reviewer clicks "apply fix" on a finding; the server:

1. reads the completed `Critique` for that job;
2. projects it into fix items (`reviewFixItemsFromCritique`), where a finding is **grounded** only if it is localizable (`element_ref`) *and* carries a concrete repair constraint (`suggestion`); anything else is **advisory**;
3. runs the pure reducer (`handlePanelAction`).

A grounded finding comes back as `{ "type": "fix", "fix": "..." }`, and that fix is *for the host to hand to the coding agent*. An advisory finding comes back `{ "type": "human_only" }`, never an auto-fix. "Resolved" is a recheck verdict the service earns, not a status the panel can set.

### Production mode

`Dockerfile` builds the workspace and runs `packages/mcp-server/dist/boot.js`, the production composition root: Streamable HTTP transport, bearer JWT verification against an issuer's JWKS, a Postgres application plane, and a signed client for the judgment engine. It fails closed with a readable message when configuration is missing.

**It cannot complete a review.** It requires an OAuth issuer, a Postgres instance with RLS enforced, and a reachable judgment engine. The engine is not part of this release, so `ENGINE_BASE_URL` has nothing to point at. The production root deliberately has no mock fallback: a server that answers with fixture judgments must be the local one, explicitly, never a misconfigured production one. Read this mode as an implementation of the auth/transport/persistence shape; run the local server to actually use the tools.

## Configuration

Every variable below is read by the code (`grep`-verified). None are needed by the local server, the quickstart, or the test suite.

| Variable | Required | Default | Effect |
|---|---|---|---|
| `MCP_RESOURCE_URL` | yes (production) | none | This server's public resource id, the expected token `aud` |
| `MCP_AUTHORIZATION_SERVERS` | yes (production) | none | Comma-separated issuer URLs published in RFC 9728 discovery |
| `MCP_JWKS_URL` | yes (production) | none | Issuer JWKS endpoint used to verify token signatures |
| `MCP_TOKEN_ISSUER` | yes (production) | none | Expected token `iss` |
| `DATABASE_URL` | yes (production) | none | Postgres for durable jobs and the verified-target registry; migrations run at boot |
| `ENGINE_BASE_URL` | yes (production) | none | Judgment engine async job API origin |
| `ENGINE_HMAC_SECRET` | yes (production) | none | Shared secret signing service-to-service calls |
| `PORT` | no | `8080` | Listener port |
| `MCP_PATH` | no | `/mcp` | MCP endpoint path |
| `MCP_ALLOWED_HOSTS` | no | host of `MCP_RESOURCE_URL` | Permitted `Host` headers (DNS-rebinding defense) |
| `MCP_MAX_BODY_BYTES` | no | `262144` | Request body ceiling; hard maximum 1 MiB |
| `MCP_BODY_TIMEOUT_MS` | no | `30000` | Body-read timeout |
| `MCP_MAX_IN_FLIGHT_PER_PRINCIPAL` | no | `8` | Concurrent authenticated requests per principal; hard maximum 64 |
| `MCP_TEST_DATABASE_URL` | no | none | Test-only. When set, runs the Postgres migration test instead of skipping it |

## How it works

A `design_review` call in production mode:

```
HTTP edge (TLS, Host allowlist, body + in-flight limits)
  -> bearer JWT verified against the issuer's JWKS -> tenant + scopes
  -> per-client MCP adapter (never shared between clients)
  -> request normalization + idempotency fingerprint
  -> target authorization: canonicalize -> verified-host lookup -> DNS -> egress classification
  -> unit reservation -> durable job row
  -> HMAC-signed submit to the judgment engine
```

The client gets a `job_id` and a `poll_after_ms`, and polls `design_review_get`, which refreshes from the engine when a refresh is due and returns the completed `Critique`. Locally the same path runs with the fixture engine and an in-memory store, synchronously; the job is already `completed` when submit returns.

A recheck adds: the prior review must exist and be completed; every requested finding id must belong to it; the target host must be unchanged; and the target fingerprint (URL plus `expected_revision`) must actually have changed, or it is rejected as `TARGET_UNCHANGED` without running judgment. Rejections and throttles both happen before any unit is reserved, so they cost nothing.

### Why this is technically interesting

Most MCP servers are thin wrappers: one tool call maps to one function call, returns in milliseconds, and trusts its arguments. A design reviewer breaks all three assumptions, and most of the interesting code is the consequence.

**Long work behind a short-timeout protocol.** Browser capture across several routes and viewports plus multimodal inference routinely takes minutes. MCP clients do not wait that long (Codex documents a 60-second default tool timeout), and Streamable HTTP transport sessions drop. So the tool surface is a submit-and-poll job API rather than a blocking call. Job state lives in Postgres, keyed by tenant, entirely independent of the MCP session: a client can disconnect, reconnect against a different replica, and recover its job by id. Tool calls are idempotent on a caller-supplied `client_request_id`, enforced by a `(tenant_id, client_request_id)` unique constraint, so a retried submit after a dropped connection returns the original job (`reused: true`) instead of billing a second review. Reusing that key with different arguments is an explicit `IDEMPOTENCY_CONFLICT`, never a silent overwrite.

**"Fetch this URL for me" is an SSRF primitive.** A tool that accepts a URL from an agent and loads it server-side is a confused deputy. `target-auth.ts` and `egress.ts` are the defense, in layers: the URL is canonicalized (HTTPS only, no userinfo, no fragment, IDNA-normalized host, default port dropped, raw IP literals rejected); the host must appear in the tenant's ownership-verified registry, so a valid token cannot capture a host the tenant does not own; every address the host resolves to is classified against a denylist (loopback, RFC 1918, link-local, the `169.254.169.254` cloud-metadata address, multicast, reserved, NAT64-embedded IPv4, 6to4, CGNAT); and a mixed answer set (some public, some private) is rejected as a DNS-rebind attempt rather than partially allowed. Failures collapse to a single `DNS_TARGET_PROHIBITED` code, so the response never tells the caller which internal address resolved. `egress.ts` is pure and dependency-free by design: it never touches the network, it only classifies addresses a resolver already produced, which makes it exhaustively testable in one sitting.

**Page content is data, never instruction.** The server reads a preview an attacker may control. Nothing captured from the page becomes server instructions, a tool description, an authorization decision, or a new tool call. In the review panel, every page-derived string is HTML-escaped and evidence is embedded as a `data:` URI, so the panel fetches nothing.

**Per-client protocol isolation.** MCP SDK server and transport instances are mutable and are never shared across clients or tenants. Each connection gets its own short-lived adapter pair over one shared, protocol-neutral application store, so a transport-layer bug cannot leak state between tenants. The HTTP edge enforces its own limits before the SDK sees a request: declared and streamed body size, body-read timeout, media type, and in-flight requests per principal, each with a distinct counted rejection reason.

**Cancellation that cannot be raced.** A review job has two identities: the MCP-facing product job id and the engine's own job id. The application record stores both, and cancel/poll calls use the engine id. Completion and cancellation share a single store transaction as their linearization point, so a result arriving after a cancellation wins cannot overwrite it.

**Migrations that survive concurrent replicas.** Every boot opens one transaction, takes a product-scoped Postgres advisory lock, and only then reads migration state; the lock, the pending DDL, and the tracking inserts all share that transaction, so racing replicas serialize and a killed runner rolls back cleanly. Applied migrations are pinned by SHA-256: historical files are immutable after first adoption, and a mismatch fails startup. An older image tolerates an unknown newer checksum-pinned id, which is what makes rolling rollback safe. Tables are tenant-keyed with RLS; the adapter binds `app.tenant_id` inside every transaction and the role must not hold `BYPASSRLS`.

**Multimodal results with an honest downgrade.** A design review's most useful output is a picture. `multimedia-content.ts` shapes a critique into ordered MCP content blocks: the interactive panel first where the host supports MCP-Apps, then per-finding text, then annotated crops as image blocks. A host that cannot render images gets the identical text and structured findings plus an explicit `images_withheld` list of the evidence it is not seeing, never a broken block and never a silent drop. Image blocks are only emitted for evidence that actually exists with a real `image/*` MIME type; evidence is never fabricated to fill a slot.

**The catalog cannot drift.** The tool set is declared in three places: the Zod input schemas the SDK advertises, `schemas/mcp-tools.json`, and the `directory/server.json` registry listing. A test performs a `tools/list` against a real server instance over an in-process transport, failing the build if they disagree, including the version string.

### Directory map

```
packages/mcp-types/                boundary contracts, no runtime dependencies
  src/critique.ts                  agent-facing envelopes (Job, Budget, Critique, content blocks)
  src/engine.ts                    engine wire result + confidence/calibration types
  src/error.ts                     typed ReviewError contract (code, retriable, next_action)
  src/panel.ts                     MCP-Apps panel action/response contract
  fixtures/                        golden engine result, the offline judgment

packages/mcp-server/
  src/tools.ts                     Zod input schemas, source of the advertised JSON Schema
  src/server.ts                    the five MCP tools, views, and typed error mapping
  src/local-server.ts              offline composition root (fixture engine, stub DNS)
  src/local-stdio.ts               `mcp-review-local` process entrypoint (stdio transport)
  src/demo.ts                      the quickstart client: spawns the server, drives the loop
  src/review-service.ts            job lifecycle, idempotency, budgets, recheck semantics
  src/normalize.ts                 request normalization and the idempotency fingerprint
  src/target-auth.ts               canonicalization, verified-host check, rebind rejection
  src/egress.ts                    pure IP classification (private/loopback/metadata/reserved)
  src/rate-limit.ts                recheck budgets, per-finding windows, backoff
  src/critique-map.ts              engine result -> agent-facing Critique
  src/multimedia-content.ts        content-block shaping with capability downgrade
  src/panel-html.ts                the MCP-Apps panel document (escaped, self-contained)
  src/panel-findings.ts            Critique -> fix items -> PanelFindings
  src/panel-interaction.ts         the pure panel reducer (grounded -> agent, advisory -> human)
  src/evidence.ts                  EvidenceProvider seam, where annotated crops come from
  src/synthetic-evidence.ts        deterministic placeholder PNG encoder (offline evidence)
  src/http-server.ts               Streamable HTTP edge: PRM discovery, auth, limits, health
  src/auth.ts                      principal/scope derivation, RFC 9728 metadata
  src/jwt-verifier.ts              JWKS-backed JWT verification (jose)
  src/application-store.ts         ReviewApplicationStore port + in-memory adapter
  src/postgres-store.ts            tenant-scoped Postgres adapter
  src/pg.ts                        advisory-locked, checksum-pinned migration runner
  src/engine-client.ts             engine port + the deterministic fixture mock
  src/engine-http-client.ts        HMAC-signed async client for the judgment engine
  src/engine-cancel.ts             engine status -> MCP status, cancellation arbitration
  src/production*.ts, main.ts, boot.ts   production composition root and entrypoint
  migrations/                      001_review_application.sql, 002_review_targets.sql (RLS)

schemas/                           machine-readable tool catalog, error and feedback schemas
directory/server.json              the MCP registry listing (marked archived)
```

Source comments cite internal design documents by shorthand (`TRD §4.1`, `THREAT_MODEL T1`) and issue numbers in repositories that were never public. Those documents are not part of this release; the citations are left as historical provenance.

## Development

```console
$ pnpm test

> @apature/mcp-review-monorepo@0.0.0 test /Users/you/mcp-review
> vitest run

 RUN  v4.1.10 /Users/you/mcp-review

 Test Files  29 passed | 1 skipped (30)
      Tests  254 passed | 2 skipped (256)
```

The skipped file is `packages/mcp-server/test/production-postgres.test.ts`, which exercises migration arbitration against a real database and only runs when `MCP_TEST_DATABASE_URL` is set. With one supplied the suite is 30 files / 256 tests, all passing.

```bash
pnpm lint                                          # eslint, warnings fail the build
pnpm typecheck                                     # tsc -b across project references
pnpm test packages/mcp-server/test/local-server.test.ts   # one file
pnpm clean                                         # remove build output
```

To run the Postgres test locally (needs Docker), against a scratch database only, since the suite creates and drops its own schemas:

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcp_review_test postgres:17-alpine

MCP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mcp_review_test pnpm test
```

Nothing in the suite touches a model, a browser, or the network: the engine is a fixture mock, the DNS resolver is a stub, and the Postgres application plane runs in-process against [PGlite](https://pglite.dev). `vitest.config.ts` raises the timeouts to 30s because a cold first run instantiates PGlite (WASM Postgres) inside a hook.

Both workspace packages are `private`; there is no published npm package.

## Limitations

| Component | Status | Notes |
|---|---|---|
| Local MCP server (stdio, offline) | Working | `pnpm demo`, `pnpm start:local` |
| All five tools, views, panel round trip | Working | Covered by the suite; see Quickstart |
| Target authorization + egress classification | Working | Enforced by the local server too |
| Evidence images | Partial | Real PNG bytes, but generated placeholders; real crops need a capture service. Seam: `EvidenceProvider` in `src/evidence.ts` |
| Screenshot capture and model judgment | Not implemented | Out of scope for this repo; they lived in the unpublished engine. Seams: `EngineClient` / `EngineJobClient` in `src/engine-client.ts` |
| Production HTTP mode | Partial | Boots, authenticates, persists, migrates. Cannot complete a review: no engine to reach |
| `design_review_get` view projections | Partial | Projections of the local `Critique`; the engine-side coverage counts, finding index, and `patchContext` are not in this repo |
| Domain-ownership verification | Not implemented | `target-auth.ts` enforces the verified list and `002_review_targets.sql` stores it, but nothing here issues or checks the DNS/well-known/GitHub-deployment proofs. Rows arrive pre-verified from a system outside this repo |
| Recheck index and unit ledger | Partial | Job records persist to Postgres, but the recheck index and the tenant unit counter (a flat 1000 per `ReviewService`) live in memory on an instance constructed per MCP connection. A recheck resolves only a review submitted on the same connection. Seam: read the review back from `ReviewApplicationStore` and move the ledger into it |
| Metering | Partial | Units are reserved and consumed on job records. No payment integration, no cross-replica ledger |
| Feedback events | Not implemented | `schemas/feedback-event.schema.json` exists; there is no writer in `src/` |
| MCP Tasks adapter | Not implemented | `execution.taskSupport` is `forbidden` in the catalog. Application job ids were always the canonical handle |
| `design_direction` tool | Not implemented | Specified but deliberately deferred; out of scope |
| Published quality numbers | Not implemented | The planned protocol, quality, security, and cost evaluations were not completed. Assume no measured accuracy claims |

### Some caveats

The hosted service is gone. `https://mcp.apature.ai/mcp` and `https://apature.ai` are decommissioned; `directory/server.json` retains the listing as a historical record and is marked archived. No tokens are issued, and nothing in this repository reaches either host.

The protocol baseline is `2025-11-25`. The stateless `2026-07-28` adapter the design reserved room for does not exist.

During archival testing a single unidentified test failure appeared in one of roughly 43 consecutive full-suite runs and could not be reproduced in the other 42. If you see a red run on an unchanged commit, re-run before treating it as a regression.

The auth path is unreviewed as of archival, and dependency updates stopped when the project did. Read [SECURITY.md](SECURITY.md) before running any of this against something you care about.

## Contributing

This repository is archived. Pull requests are not accepted and issues are not monitored. Forking is the intended path. MIT, no strings. [CONTRIBUTING.md](CONTRIBUTING.md) documents the layout and conventions so a fork starts from working instructions.

## Security

No security support: no patch releases, no advisories, no response guarantee. [SECURITY.md](SECURITY.md) explains how to report something as a courtesy to downstream forks, and what to check before running this code.

## License

MIT. See [LICENSE](LICENSE).
