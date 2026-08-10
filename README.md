# mcp-review

**A remote MCP server for in-loop design review, and a worked reference for OAuth 2.1 auth, SSRF-safe URL handling, and long-running jobs over MCP.**

A coding agent changes a UI, deploys a preview, and has no way to see whether the result looks right. `mcp-review` is the MCP server on the other end of that loop: the agent submits a preview URL, gets back structured findings (route, viewport, element ref, suggested fix), applies the fixes itself, then asks the server to recheck them. The server judges and verifies; it never edits code.

It is also, deliberately, a reference implementation. Most public MCP servers are stdio, unauthenticated, single-tenant, and return in milliseconds. This one carries the other shape: a Streamable HTTP edge with OAuth 2.1 resource-server auth, per-tenant Postgres state, submit-and-poll jobs that outlive the transport session, and a hardened boundary around the one thing an agent-supplied URL always is, which is an SSRF primitive.

Everything below runs offline with no credentials. The judgments come from a fixture (see [Status and roadmap](#status-and-roadmap)); every other layer is the real code path.

## Quickstart

Node 24+ and pnpm 9.15.0 (`corepack enable` installs pnpm from the `packageManager` field). Nothing else: no API key, no database, no Docker. `pnpm install` needs the npm registry once; after that nothing here opens a connection.

```bash
git clone https://github.com/apatureai/mcp-review.git
cd mcp-review
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

`pnpm demo` is a real MCP client. It spawns the server as a child process over stdio, completes a handshake, submits a review, reads it back four ways, acts on a finding, rechecks it, and gets denied on an unauthorized host:

```console
$ pnpm demo

mcp-review local server ready on stdio: offline, fixture judgments, authorized host: preview.example.com
connected to apature-mcp-review v1.1.0 over stdio

[1] tools/list
    design_review                metered
    design_review_get            free
    design_recheck               metered
    design_review_cancel         free
    design_review_panel_action   free

[2] design_review  https://preview.example.com/pricing
    job job_f3484b5d-c440-4bbe-82ed-3089899f691c -> completed, 1 unit(s)

[3] design_review_get  view=status
    status=completed, review body present: false

[4] design_review_get  view=summary
    review rev_60ed3a95-21cd-4188-8660-51a5727bf1fa -> grade needs_work
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

**Success looks like** nine numbered steps, `3 findings, 3 recheck outcomes`, and two new files. `out/review.json` is the agent-facing `Critique`; `out/panel.html` is the review panel:

```bash
open out/panel.html      # macOS; use xdg-open on Linux
```

The panel is self-contained HTML with no scripts, no external requests, and evidence embedded as `data:` URIs. The `job_*` and `rev_*` ids are freshly generated, so yours will differ from the transcript.

If `pnpm demo` reports `Cannot find module`, `pnpm build` has not been run. If step 2 comes back `DNS_TARGET_PROHIBITED` instead of a job, something changed `LOCAL_RESOLVED_ADDRESS` in `packages/mcp-server/src/local-server.ts` to a non-public address, and that rejection is the SSRF guard working.

### Connect your own MCP client

The local server speaks MCP over stdio, which is what Claude Code, Cursor, Codex, and VS Code use for a local server:

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

`pnpm demo` spawns exactly that command and completes a real handshake against it, so the command is verified here; registration differs per client.

The only host the local server authorizes is `preview.example.com`; every other host is rejected as `DOMAIN_UNVERIFIED`. To add your own, edit `packages/mcp-server/src/local-stdio.ts` and rebuild:

```ts
import { createLocalReviewServer } from "./local-server.js";

const server = createLocalReviewServer({ allowedHosts: ["preview.mycompany.com"] });
```

Remember what that buys you: the target is authorized for real, and then judged from a fixture. It will not tell you anything about your page.

## Who this is for

- **Engineers building a remote MCP server.** Streamable HTTP, OAuth 2.1 resource-server auth with RFC 9728 discovery and JWKS verification, per-client transport isolation, request limits, and a tenant-scoped Postgres plane, all under test. There is not much public prior art for this shape.
- **Anyone whose agent fetches a model-supplied URL.** `target-auth.ts` and `egress.ts` are a complete, dependency-free SSRF boundary you can read in one sitting and lift into your own server.
- **People wiring long-running work behind MCP.** Capture plus inference takes minutes; MCP clients time out in seconds. The submit-and-poll job design, the idempotency key, and the cancellation arbitration are the answer worked all the way through.
- **People building AI design review.** The tool surface, the `Critique` contract, the multimodal content shaping, and the judge/act boundary are the product-shaped part.

## What it does

- Runs a complete five-tool MCP server locally over stdio, with no credentials, no database, no network calls, and no model.
- Submits a review of an HTTPS preview URL as an async job, and serves the result through five views: `status`, `summary`, `findings`, `focus`, `evidence`.
- Returns findings as MCP content blocks (an interactive HTML review panel, per-finding text, annotated evidence images), degrading honestly on a host that cannot render one of them.
- Rechecks 1 to 20 findings from a completed review after the agent claims a fix, and rejects an unchanged target without spending anything.
- Authorizes every target before it would ever be fetched: HTTPS-only canonicalization, an ownership-verified host allowlist, and full IP-range egress classification with DNS-rebind rejection.
- Carries the Streamable HTTP edge for the same tools: OAuth 2.1 resource-server auth, per-client transport isolation, and a Postgres application plane. The suite exercises that edge end to end over real HTTP and, with `MCP_TEST_DATABASE_URL`, real Postgres.

## What it deliberately does not do

- **It never edits code.** No patching, committing, pushing, opening pull requests, or driving a browser. It returns judgments and evidence; the agent on the other end does the work. The server is the eyes, the agent is the hands.
- **It does not screenshot anything and it does not call a model.** Capture and inference sit behind the engine boundary, in the public sibling [apatureai/judgment-engine](https://github.com/apatureai/judgment-engine): it drives headless Chromium for real captures and calls an OpenAI-compatible endpoint configured with `MODEL_BASE_URL` / `MODEL_API_KEY`. That repo exists and is MIT, but this one is not wired to it yet, so the judgments you get here are still fixture-backed. Closing that gap is roadmap item 1 in [Status and roadmap](#status-and-roadmap).
- **It does not judge the URL you pass.** Offline, the findings come from a golden fixture describing a fictional pricing page.

## Why this is technically interesting

Most MCP servers are thin wrappers: one tool call maps to one function call, returns in milliseconds, and trusts its arguments. A design reviewer breaks all three assumptions, and most of the interesting code is the consequence.

**Long work behind a short-timeout protocol.** Browser capture across several routes and viewports plus multimodal inference routinely takes minutes. MCP clients do not wait that long (Codex documents a 60-second default tool timeout) and Streamable HTTP sessions drop. So the tool surface is a submit-and-poll job API rather than a blocking call. Job state lives in Postgres, keyed by tenant, entirely independent of the MCP session: a client can disconnect, reconnect against a different replica, and recover its job by id. Tool calls are idempotent on a caller-supplied `client_request_id`, enforced by a `(tenant_id, client_request_id)` unique constraint, so a retried submit after a dropped connection returns the original job (`reused: true`) instead of billing a second review. Reusing that key with different arguments is an explicit `IDEMPOTENCY_CONFLICT`, never a silent overwrite.

**"Fetch this URL for me" is an SSRF primitive.** A tool that accepts a URL from an agent and loads it server-side is a confused deputy. `target-auth.ts` and `egress.ts` are the defense, in layers: the URL is canonicalized (HTTPS only, no userinfo, no fragment, IDNA-normalized host, default port dropped, raw IP literals rejected); the host must appear in the tenant's ownership-verified registry, so a valid token cannot capture a host the tenant does not own; every address the host resolves to is classified against a denylist (loopback, RFC 1918, link-local, the `169.254.169.254` cloud-metadata address, multicast, reserved, NAT64-embedded IPv4, 6to4, CGNAT); and a mixed answer set (some public, some private) is rejected as a DNS-rebind attempt rather than partially allowed. Failures collapse to a single `DNS_TARGET_PROHIBITED` code, so the response never tells the caller which internal address resolved. `egress.ts` is pure and dependency-free by design: it never touches the network, it only classifies addresses a resolver already produced, which makes it exhaustively testable.

**Page content is data, never instruction.** The server reads a preview an attacker may control. Nothing captured from the page becomes server instructions, a tool description, an authorization decision, or a new tool call. In the review panel every page-derived string is HTML-escaped and evidence is embedded as a `data:` URI, so the panel fetches nothing.

**Per-client protocol isolation.** MCP SDK server and transport instances are mutable and are never shared across clients or tenants. Each connection gets its own short-lived adapter pair over one shared, protocol-neutral application store, so a transport-layer bug cannot leak state between tenants. The HTTP edge enforces its own limits before the SDK sees a request: declared and streamed body size, body-read timeout, media type, and in-flight requests per principal, each with a distinct counted rejection reason.

**Cancellation that cannot be raced.** A review job has two identities: the MCP-facing product job id and the engine's own job id. The application record stores both, and cancel/poll calls use the engine id. Completion and cancellation share a single store transaction as their linearization point, so a result arriving after a cancellation wins cannot overwrite it.

**Migrations that survive concurrent replicas.** Every boot opens one transaction, takes a product-scoped Postgres advisory lock, and only then reads migration state; the lock, the pending DDL, and the tracking inserts all share that transaction, so racing replicas serialize and a killed runner rolls back cleanly. Applied migrations are pinned by SHA-256: historical files are immutable after first adoption, and a mismatch fails startup. An older image tolerates an unknown newer checksum-pinned id, which is what makes rolling rollback safe. Tables are tenant-keyed with RLS; the adapter binds `app.tenant_id` inside every transaction and the role must not hold `BYPASSRLS`.

**Multimodal results with an honest downgrade.** A design review's most useful output is a picture. `multimedia-content.ts` shapes a critique into ordered MCP content blocks: the interactive panel first where the host supports MCP-Apps, then per-finding text, then annotated crops as image blocks. A host that cannot render images gets the identical text and structured findings plus an explicit `images_withheld` list of the evidence it is not seeing, never a broken block and never a silent drop. Image blocks are only emitted for evidence that actually exists with a real `image/*` MIME type; evidence is never fabricated to fill a slot.

**The catalog cannot drift.** The tool set is declared in three places: the Zod input schemas the SDK advertises, `schemas/mcp-tools.json`, and the `directory/server.json` registry listing. A test performs a `tools/list` against a real server instance over an in-process transport, failing the build if they disagree, including the version string.

## Tool surface

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

### The eyes-not-hands boundary, in code

`design_review_panel_action` is where the product boundary is easiest to violate and easiest to test. A reviewer clicks "apply fix" on a finding; the server:

1. reads the completed `Critique` for that job;
2. projects it into fix items (`reviewFixItemsFromCritique`), where a finding is **grounded** only if it is localizable (`element_ref`) *and* carries a concrete repair constraint (`suggestion`); anything else is **advisory**;
3. runs the pure reducer (`handlePanelAction`).

A grounded finding comes back as `{ "type": "fix", "fix": "..." }`, and that fix is *for the host to hand to the coding agent*. An advisory finding comes back `{ "type": "human_only" }`, never an auto-fix. "Resolved" is a recheck verdict the service earns, not a status the panel can set.

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

### What is real and what is synthetic offline

| Part | Offline behaviour |
|---|---|
| MCP protocol, tools, input validation, error taxonomy | Real |
| Target authorization, egress classification, DNS-rebind rejection | Real (runs on every submit) |
| Job lifecycle, idempotency, budgets, recheck rejection and throttling | Real |
| Views, content blocks, panel projection and reducer | Real |
| The findings themselves | **Fixture.** A golden engine result about a fictional pricing page, not a judgment of the URL you passed |
| DNS | **Stub.** One fixed public address, returned without a lookup; no network call is made |
| Evidence crops | **Placeholder.** Deterministic generated PNGs where the engine's annotated screenshots would be |

## Running the HTTP server

`Dockerfile` builds the workspace and runs `packages/mcp-server/dist/boot.js`, the production composition root: Streamable HTTP transport, bearer JWT verification against an issuer's JWKS, a Postgres application plane, and a signed client for the judgment engine. It fails closed with a readable message when configuration is missing.

It boots, authenticates, persists, and migrates. It cannot complete a review until `ENGINE_BASE_URL` points at a judgment engine that speaks the `EngineJobClient` protocol (see [Status and roadmap](#status-and-roadmap)). The production root deliberately has no mock fallback: a server that answers with fixture judgments must be the local one, explicitly, never a misconfigured production one.

**There is no hosted endpoint, and no URL here to point a client at.** Nobody operates a public instance of this server, so `directory/server.json` declares no `remotes` at all rather than publishing a host that would not answer. If you deploy it, take the `ai.apature/self_hosted_remote_template` block out of that file's `_meta`, put your own host in it, and move it up into a real `remotes` array before submitting the listing anywhere. A test enforces that the checked-in listing stays remote-free while that is the truth.

### Configuration

Every variable below is read by the code. None are needed by the local server, the quickstart, or the test suite.

| Variable | Required | Default | Effect |
|---|---|---|---|
| `MCP_RESOURCE_URL` | yes (HTTP mode) | none | This server's public resource id, the expected token `aud` |
| `MCP_AUTHORIZATION_SERVERS` | yes (HTTP mode) | none | Comma-separated issuer URLs published in RFC 9728 discovery |
| `MCP_JWKS_URL` | yes (HTTP mode) | none | Issuer JWKS endpoint used to verify token signatures |
| `MCP_TOKEN_ISSUER` | yes (HTTP mode) | none | Expected token `iss` |
| `DATABASE_URL` | yes (HTTP mode) | none | Postgres for durable jobs and the verified-target registry; migrations run at boot |
| `ENGINE_BASE_URL` | yes (HTTP mode) | none | Judgment engine async job API origin |
| `ENGINE_HMAC_SECRET` | yes (HTTP mode) | none | Shared secret signing service-to-service calls |
| `PORT` | no | `8080` | Listener port |
| `MCP_PATH` | no | `/mcp` | MCP endpoint path |
| `MCP_ALLOWED_HOSTS` | no | host of `MCP_RESOURCE_URL` | Permitted `Host` headers (DNS-rebinding defense) |
| `MCP_MAX_BODY_BYTES` | no | `262144` | Request body ceiling; hard maximum 1 MiB |
| `MCP_BODY_TIMEOUT_MS` | no | `30000` | Body-read timeout |
| `MCP_MAX_IN_FLIGHT_PER_PRINCIPAL` | no | `8` | Concurrent authenticated requests per principal; hard maximum 64 |
| `MCP_TEST_DATABASE_URL` | no | none | Test-only. When set, runs the Postgres migration test instead of skipping it |

## Repository map

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
  src/production*.ts, main.ts, boot.ts   composition root and HTTP entrypoint
  migrations/                      001_review_application.sql, 002_review_targets.sql (RLS)

schemas/                           machine-readable tool catalog, error and feedback schemas
directory/server.json              the MCP registry listing
```

Some source comments cite design documents by shorthand (`TRD §4.1`, `THREAT_MODEL T1`) and issue numbers from a private tracker. Those documents are not in this repository; the citations are left in place as provenance for the decisions they explain.

## Development

```console
$ pnpm test

 RUN  v4.1.10

 Test Files  29 passed | 1 skipped (30)
      Tests  254 passed | 2 skipped (256)
```

```bash
pnpm lint                                                  # eslint, warnings fail the build
pnpm typecheck                                             # tsc -b across project references
pnpm test packages/mcp-server/test/local-server.test.ts    # one file
pnpm clean                                                 # remove build output
```

The skipped file is `packages/mcp-server/test/production-postgres.test.ts`, which exercises migration arbitration against a real database and only runs when `MCP_TEST_DATABASE_URL` is set. With one supplied the suite is 30 files / 256 tests, all passing:

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcp_review_test postgres:17-alpine

MCP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mcp_review_test pnpm test
```

That suite creates and drops its own schemas, so point it at a scratch database only.

Nothing in the suite touches a model, a browser, or the network: the engine is a fixture mock, the DNS resolver is a stub, and the Postgres application plane runs in-process against [PGlite](https://pglite.dev). `vitest.config.ts` raises the timeouts to 30s because a cold first run instantiates PGlite (WASM Postgres) inside a hook.

Both workspace packages are `private`; there is no published npm package yet. See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and how changes get reviewed.

## Status and roadmap

Working today, covered by the suite:

| Component | Notes |
|---|---|
| Local MCP server (stdio, offline) | `pnpm demo`, `pnpm start:local` |
| All five tools, five views, panel round trip | End to end in the quickstart |
| Target authorization + egress classification | Enforced by the local server too |
| Job lifecycle, idempotency, recheck semantics, budgets | Including zero-charge rejection paths |
| Streamable HTTP edge: OAuth 2.1 auth, limits, per-client isolation | Tested over real HTTP |
| Postgres application plane, RLS, migration arbitration | Tested against PGlite and real Postgres |

Known gaps, in rough priority order. Each names the seam to work against, and each is a reasonable first contribution.

**1. Wire a real critique backend.** This is the main one. Judgments come from a golden fixture, so the server currently tells you nothing about the URL you passed. The seam is `EngineClient` / `EngineJobClient` in `packages/mcp-server/src/engine-client.ts`, with an HMAC-signed HTTP implementation already written in `engine-http-client.ts` and a deterministic mock next to it. A backend needs to answer submit/poll/cancel and return an `EngineReviewResult` matching `packages/mcp-types/fixtures/engine-review-result.golden.json`.

[apatureai/judgment-engine](https://github.com/apatureai/judgment-engine) is the intended counterpart and it is public and MIT, so this is closer than it used to be. Its `packages/api` serves the same async job API this client calls (`POST /jobs`, `GET /jobs/:id`, `DELETE /jobs/:id`), and the request signing lines up on both sides: the same `x-gate-signature` / `x-gate-installation` / `x-gate-timestamp` headers over the same `timestamp.installationId.body` canonical string. What nobody has done is run the two against each other, so treat the result payload mapping (its review output onto `EngineReviewResult`) as unverified rather than done. Standing up `ENGINE_BASE_URL` against it and reporting where the shapes disagree is a genuinely useful contribution, and any service speaking the same shape works just as well.

**2. Screenshot capture.** Not implemented here, and still not planned to live here: capture belongs behind the engine boundary above, and it is already written there. `judgment-engine` drives headless Chromium through playwright-core and produces deterministic screenshots plus a DOM geometry map; its `browser:install` and `review` scripts are the entry points, and that repo's README documents how to run them. So the missing piece is not a capture implementation, it is the link in item 1.

**3. Real evidence images.** `EvidenceProvider` in `src/evidence.ts` is the seam and it is documented; the only implementation is `SyntheticEvidenceProvider`, which emits deterministic placeholder PNGs (real bytes, no pixels of your page). An implementation that fetches annotated crops from an artifact store is self-contained and testable.

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

**There are still no published quality numbers, so assume no measured accuracy claims.** The harness to produce them is no longer missing, though: it lives in [apatureai/judgment-engine](https://github.com/apatureai/judgment-engine) under `packages/eval`, which carries the canaries, the golden-set tooling, and the precision, recall and human-agreement metrics, and it declares the bars it grades against as `DEFAULT_QUALITY_BARS` in `packages/eval/src/quality-gate.ts`. What has not happened is a promoted candidate run, so neither repo publishes a results table. Since this server returns fixture judgments anyway, no number measured there would describe what you get here until item 1 is wired.

**The auth path has not had an external security review.** The OAuth 2.1 resource-server code, the token verifier and the SSRF boundary are covered by this repo's own tests and nothing more. See [SECURITY.md](SECURITY.md).

Some modules are exported from `packages/mcp-server/src/index.ts` and not yet reachable from either composition root (the HTTP evidence path, for instance). They are exported on purpose so a fork can compose them, and they are covered by unit tests, but treat "exported" as "available", not "wired".

## Contributing

Contributions are welcome, including small ones. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the test and lint commands, the conventions that matter (the eyes-not-hands boundary, the contract-tested tool catalog, golden fixtures), and how pull requests get reviewed. The roadmap items above are the best place to start; open an issue first if a change is large.

## Security

Report vulnerabilities privately through GitHub's private vulnerability reporting on the repository's Security tab. [SECURITY.md](SECURITY.md) describes supported versions, what a reporter can expect, and what to check before running this against a network you care about.

## License

MIT. See [LICENSE](LICENSE).
