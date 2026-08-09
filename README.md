# Apature MCP Review

**Status: archived.** Apature was wound down in 2026. This repository is published as-is under
the MIT license as a record of the engineering. It is not actively developed, the hosted service
it talked to no longer exists, and issues and pull requests are unlikely to be reviewed. Read it,
fork it, lift whatever is useful.

If you landed here looking for a working AI design reviewer, this is not it — the screenshotting
and the model inference lived in a separate service. What *is* here, and what is worth your time,
is a production-shaped **remote MCP server**: OAuth-protected, multi-tenant, with an async job
plane that survives client timeouts and a hardened SSRF boundary. Skip to
[Why this is technically interesting](#why-this-is-technically-interesting).

---

MCP Review is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets a
coding agent — Claude Code, Cursor, Codex, VS Code / GitHub Copilot — ask a hosted service to look
at a deployed web preview and tell it what is visually wrong with it. The agent calls
`design_review` with an HTTPS preview URL; the service screenshots the pages, judges the rendered
UI against the repo's own design standards with a vision-language model, and returns structured
findings: severity, route, viewport, an element reference, a suggested fix, and a screenshot crop
as evidence. The agent then edits the code itself and calls `design_recheck` to ask whether the
specific findings it tried to fix are actually gone.

The hard boundary, which shows up everywhere in this code: **the server never touches the
customer's code.** It does not patch, commit, push, open pull requests, or drive the browser. It
returns judgments and evidence, and the agent on the other end does the work. Internally this was
"Apature is the eyes, the agent is the hands."

This repository contains the MCP protocol surface and the control plane around it — auth, target
authorization, job lifecycle, idempotency, rate limiting, result shaping. The capture and the
model inference happened in a separate service (`judgment-engine`), which is a network dependency
here, not code in this tree.

## Why this is technically interesting

Most MCP servers are thin wrappers: a tool call maps to one function call, returns in
milliseconds, and trusts its arguments. A design reviewer breaks all three assumptions, and most
of the interesting code here is the consequence.

**Long work behind a short-timeout protocol.** Browser capture across several routes and
viewports plus multimodal inference routinely takes minutes. MCP clients do not wait that long —
Codex documents a 60-second default tool timeout — and Streamable HTTP transport sessions drop.
So the tool surface is a submit-and-poll job API rather than a blocking call: `design_review`
returns a durable `job_id` and a `poll_after_ms`, and `design_review_get` polls it. Job state
lives in Postgres, keyed by tenant, entirely independent of the MCP session. A client can
disconnect, reconnect against a different replica, and recover its job by ID. Tool calls are
idempotent on a caller-supplied `client_request_id`, enforced by a `(tenant_id,
client_request_id)` unique constraint, so a retried submit after a dropped connection returns the
original job (`reused: true`) instead of billing a second review. Reusing that key with different
arguments is an explicit `IDEMPOTENCY_CONFLICT`, not a silent overwrite.
See `src/review-service.ts`, `src/application-store.ts`, `migrations/001_review_application.sql`.

**"Fetch this URL for me" is an SSRF primitive.** A tool that accepts a URL from an agent and
loads it server-side is a confused deputy. `target-auth.ts` and `egress.ts` are the defense, in
layers: the URL is canonicalized (HTTPS only, no userinfo, no fragment, IDNA-normalized host,
default port dropped, raw IP literals rejected); the host must appear in the tenant's
ownership-verified target registry, so a valid token cannot capture a host the tenant does not
own; every address the host resolves to is classified against a denylist (loopback, RFC 1918,
link-local, the `169.254.169.254` cloud-metadata address, multicast, reserved, NAT64-embedded
IPv4, 6to4, CGNAT); and a mixed answer set — some public, some private — is rejected as a
DNS-rebind attempt rather than partially allowed. Failures collapse to a single
`DNS_TARGET_PROHIBITED` error code so the response never tells the caller which internal address
resolved. `egress.ts` is pure and dependency-free by design: it never touches the network, it only
classifies addresses a resolver already produced, which makes it exhaustively testable and
auditable in one sitting.

**Page content is data, never instruction.** The server reads a preview that an attacker may
control. Nothing captured from the page is allowed to become server instructions, a tool
description, an authorization decision, or a new tool call. Tenant identity comes from the token,
never from a tool argument.

**Per-client protocol isolation.** MCP SDK server and transport instances are mutable and are
never shared across clients or tenants. Each connection gets its own short-lived adapter pair
over one shared, protocol-neutral application store — so a transport-layer bug cannot leak state
between tenants, and the durable job/authorization state does not care which protocol revision
the adapter speaks. The HTTP edge in front of it enforces its own limits before the SDK sees a
request: declared and streamed body size, body-read timeout, media type, and in-flight requests
per principal, each with a distinct counted rejection reason. See `src/http-server.ts`,
`src/auth.ts`, `src/jwt-verifier.ts`.

**Cancellation that cannot be raced.** A review job has two identities: the MCP-facing product
job ID and the Judgment Engine's own job ID. The application record stores both, and cancel/poll
calls use the engine ID. Completion and cancellation share a single store transaction as their
linearization point, so a result that arrives after a cancellation wins cannot overwrite it.

**Migrations that survive concurrent replicas.** Every boot opens one transaction, takes a
product-scoped Postgres advisory lock, and only then reads migration state; the lock, the pending
DDL, and the tracking inserts all share that transaction, so racing replicas serialize and a
killed runner rolls back cleanly. Applied migrations are pinned by SHA-256: historical files
become immutable after first adoption, and a mismatch fails startup. An older image tolerates an
unknown newer checksum-pinned ID, which is what makes rolling rollback safe. See `src/pg.ts`.

**Multimodal results with an honest downgrade.** A design review's most useful output is a
picture. `multimedia-content.ts` shapes a critique into ordered MCP content blocks — an
interactive HTML panel first where the host supports MCP-Apps, then per-finding text, then
annotated screenshot crops as image blocks. A host that cannot render images gets the identical
text and structured findings plus an explicit `images_withheld` list of the evidence it is not
seeing, never a broken block and never a silent drop. Image blocks are only emitted for evidence
that actually exists with a real `image/*` MIME type; evidence is never fabricated to fill a slot.
(This path is built and tested but not wired into the live tool handlers — see
[Limits](#limits-and-unfinished-work).)

**Read-only means read-only, including in the UI.** The panel reducer (`panel-interaction.ts`)
is where the product boundary gets tested hardest: a user clicks "apply fix" on a finding. The
reducer returns the fix *for the host to hand to the coding agent* — it never edits anything —
and for an advisory finding (model judgment without a grounded, mechanically appliable fix) it
returns `human_only` rather than an auto-fix. "Resolved" is a recheck verdict the service earns,
not a status the panel can set.

**The catalog cannot drift.** The tool set is declared in three places — the Zod input schemas
the SDK advertises, `schemas/mcp-tools.json`, and the `directory/server.json` registry listing —
and a test performs a `tools/list` against a real server instance over an in-process transport,
failing the build if they disagree, including the version string. The MCP annotations are set
from the truth rather than from the marketing: only `design_review_get` carries
`readOnlyHint: true`, because submit and recheck create metered jobs and cancel terminates one.
"Read-only" describes the customer's code, not every tool.

## Tool surface

| Tool | Metered | What it does |
|---|---|---|
| `design_review` | yes | Submit an async review of an authorized HTTPS preview (routes, viewports, `triage`/`deep` depth). Returns a job. |
| `design_review_get` | no | Poll job status or read the result. The only `readOnlyHint: true` tool. |
| `design_recheck` | yes | Re-judge 1–20 findings from a completed review after the agent changed the UI. Rejects a host change or an unchanged target. |
| `design_review_cancel` | no | Best-effort cancel of a queued or running job; requires the `reviews:cancel` scope. |

A fifth tool, `design_direction` (proactive design guidance rather than review), was specified in
the PRD and deliberately deferred until ordinary review quality cleared its evaluation bar. It
was never implemented.

## Where it sat in the stack

MCP Review was the agent-facing front end. It owned protocol adaptation, authentication, target
authorization, job UX, budgets, and result formatting — and delegated everything else:

- [`judgment-engine`](https://github.com/apatureai/judgment-engine) — browser capture, model
  inference, finding validation, artifact storage. MCP Review talks to its async `/jobs` API over
  HMAC-signed HTTP (`engine-http-client.ts`); this repo contains no capture or inference code.
- [`ui-dna`](https://github.com/apatureai/ui-dna) — the canonical extracted design standard a UI
  is judged against. MCP Review never edits or approves it; it receives version and provenance
  through engine results.
- [`ui-graph`](https://github.com/apatureai/ui-graph) — the structured representation of a
  rendered scene, and the `summary` / `violations` / `focus` / `patchContext` views a finding is
  grounded in. MCP Review requests named views by review and finding ID through the engine; it
  never calls UI Graph directly.
- [`gate`](https://github.com/apatureai/gate) — the GitHub side: PR comments, Check Runs,
  enforcement. MCP Review never publishes to GitHub. The intended division was that MCP is the
  in-loop fix surface and CI is the enforcement surface, never the reverse.

Not every sibling service named in Apature's internal design was open-sourced. Where the docs in
this repo describe a neighbouring system you cannot find, that is why.

## Quickstart

Requires Node 24 or newer (`.node-version` pins `24`; CI runs 24) and pnpm — the repo pins
`pnpm@9.15.0` via `packageManager`, so `corepack enable` picks the right one up.

```bash
pnpm install --frozen-lockfile
pnpm lint        # eslint, warnings fail
pnpm typecheck   # tsc -b across project references
pnpm build       # tsc -b (same compiler invocation; emits dist/)
pnpm test        # vitest run
```

All four were run green against this tree on Node 24.14.0. `pnpm test` reports **23 test files
passed, 1 skipped (222 tests passed, 2 skipped)** — the skipped suite is
`production-postgres.test.ts`, which only runs when `MCP_TEST_DATABASE_URL` points at a real
Postgres. With one supplied, the full suite is 24 files / 224 tests, all passing. CI provides it
via a `postgres:17-alpine` service container; see `.github/workflows/ci.yml` and
[CONTRIBUTING.md](CONTRIBUTING.md). Everything else runs with no external services: the
Postgres-backed application plane is exercised in-process against [PGlite](https://pglite.dev),
and the engine is a deterministic in-process mock.

There is no published npm package — both workspace packages are `private`.

## Repository layout

pnpm workspace, two packages:

```
packages/mcp-types/     boundary contracts, no runtime dependencies
  src/critique.ts       agent-facing result envelopes (Job, Budget, Critique, findings)
  src/engine.ts         the Judgment Engine wire result + confidence/calibration types
  src/error.ts          the typed ReviewError contract (code, retriable, next_action)
  src/panel.ts          MCP-Apps panel action/response contract
  fixtures/             golden engine result, mirrored byte-for-byte from gate's fixture

packages/mcp-server/
  src/tools.ts               Zod input schemas — the source of the advertised JSON Schema
  src/server.ts              the four MCP tools; maps typed errors to structured tool errors
  src/http-server.ts         Streamable HTTP edge: PRM discovery, bearer auth, per-client
                             transport isolation, host allowlist, body/in-flight limits,
                             /livez and /readyz
  src/auth.ts                principal/scope derivation, RFC 9728 metadata, WWW-Authenticate
  src/jwt-verifier.ts        JWKS-backed JWT verification (jose)
  src/target-auth.ts         canonicalization + verified-target check + rebind rejection
  src/egress.ts              pure IP classification (private/loopback/metadata/reserved/...)
  src/normalize.ts           request normalization and the idempotency fingerprint
  src/review-service.ts      job lifecycle, idempotency, budgets, recheck semantics
  src/rate-limit.ts          recheck budgets, per-finding windows, backoff
  src/application-store.ts   ReviewApplicationStore port + in-memory adapter (tests)
  src/postgres-store.ts      tenant-scoped Postgres adapter
  src/pg.ts                  advisory-locked, checksum-pinned migration runner
  src/engine-client.ts       engine port + deterministic mock used by tests
  src/engine-http-client.ts  HMAC-signed async client for judgment-engine /jobs
  src/engine-cancel.ts       engine status -> MCP status mapping, cancellation arbitration
  src/critique-map.ts        engine result -> agent-facing Critique
  src/multimedia-content.ts  image/panel content-block shaping with capability downgrade
  src/panel-*.ts             MCP-Apps panel findings producer + pure action reducer
  src/production.ts          production composition root (Postgres + engine + DNS)
  src/production-adapters.ts system DNS resolver, Postgres-backed target allowlist
  src/main.ts                transport/auth composition, startFromEnv
  src/boot.ts                the process entrypoint (runs the composition root)
  migrations/                001_review_application.sql, 002_review_targets.sql (both RLS-enabled)

schemas/       machine-readable tool catalog, error schema, feedback-event schema
directory/     server.json — the MCP registry listing (marked archived)
docs/          client install guide, production application-plane notes
```

The design record is unusually complete and is the most valuable thing here after the source:
`ARCHITECTURE.md` (boundaries, Mermaid diagrams, a full failure-mode table, invariants),
`CONTRACTS.md`, `TRD.md`, `ADRS.md` (including rejected alternatives), `THREAT_MODEL.md`,
`EVAL_PLAN.md`, `RESEARCH.md` (primary-source MCP client compatibility research), and `PRD.md`.
These are internal design documents preserved close to as-written: they use section shorthand and
cite issue numbers in repositories that are not public.

## Architecture, end to end

A `design_review` call goes: HTTP edge (TLS, host allowlist, body and in-flight limits) → bearer
JWT verification against the issuer's JWKS, deriving tenant and scopes → per-client MCP adapter →
request normalization and idempotency fingerprint → target authorization (canonicalize, verified-
host lookup, DNS resolution, egress classification) → unit reservation → durable job row →
HMAC-signed submit to Judgment Engine. The client gets a `job_id` and a `poll_after_ms` and polls
`design_review_get`, which refreshes from the engine when a refresh is due and returns the
completed `Critique`.

A recheck adds: the prior review must exist and be completed; every requested finding ID must
belong to it; the target host must be unchanged; and the target fingerprint (URL plus
`expected_revision`) must have actually changed, or the recheck is rejected as `TARGET_UNCHANGED`
without running inference. Rejections and throttles both happen before any unit is reserved, so
they cost nothing.

Production boot (`boot.ts` → `production.ts`) is fail-fast on the things that cannot recover —
missing config or an unusable database exits non-zero with a readable reason — and degrades
through `/readyz` on the things that can: the store, the engine, the target registry, and DNS each
have to answer before the process reports ready.

## Running it

`Dockerfile` builds the workspace and runs `packages/mcp-server/dist/boot.js`. It needs, at
minimum:

| Variable | Purpose |
|---|---|
| `MCP_RESOURCE_URL` | This server's public resource identifier (token `aud`) |
| `MCP_AUTHORIZATION_SERVERS` | Comma-separated issuer URLs for RFC 9728 discovery |
| `MCP_JWKS_URL` | Issuer JWKS endpoint |
| `MCP_TOKEN_ISSUER` | Expected token `iss` |
| `DATABASE_URL` | Postgres for jobs and the verified-target registry |
| `ENGINE_BASE_URL` | Judgment Engine async job API origin |
| `ENGINE_HMAC_SECRET` | Shared secret for service-to-service signing |

Optional: `PORT` (8080), `MCP_PATH` (`/mcp`), `MCP_ALLOWED_HOSTS`, `MCP_MAX_BODY_BYTES`,
`MCP_BODY_TIMEOUT_MS`, `MCP_MAX_IN_FLIGHT_PER_PRINCIPAL`. Full notes in
`packages/mcp-server/DEPLOYMENT.md` and `docs/application-plane.md`.

Starting it is not the same as having a working product: it needs an OAuth issuer, a Postgres
instance with RLS enforced, and a reachable Judgment Engine. Only the first two are things you
can provide yourself.

## Limits and unfinished work

Stated plainly, because an archived repo that oversells itself wastes people's time.

- **The hosted service is gone.** `docs/install.md`, `directory/server.json`, and the client
  snippets throughout the docs point at `https://mcp.apature.ai/mcp`, which is decommissioned.
  Read them as documentation of an interface, not as instructions that will work.
- **There is no runnable end-to-end path in this repo.** All real screenshotting and model
  inference lived in `judgment-engine`. `MockEngineClient` is a deterministic test double, not a
  local implementation; the shipped entrypoint deliberately has no mock-engine fallback, so there
  is no `--demo` mode. Wiring `createMcpReviewServer` to `MockEngineClient` and
  `InMemoryReviewApplicationStore` (both exported from `src/index.ts`) is the shortest path to a
  local toy server, and nobody wrote it.
- **The `view` parameter on `design_review_get` is accepted and ignored.** The schema advertises
  `status | summary | findings | focus | evidence`, and the compact/paginated/focused view
  projections are specified in `CONTRACTS.md`, but the handler calls `getReview(job_id)` and
  returns the full envelope regardless.
- **Some state is per-connection, not durable.** Job records — including the completed critique —
  persist to Postgres, but the recheck index (`reviewsById`) and the tenant unit counter
  (`tenantUnitsRemaining`, seeded at a flat 1000 per `ReviewService` instance) live in memory on
  the `ReviewService`, which is constructed per MCP connection. A recheck therefore only resolves
  a review submitted on the same connection, and budgets do not survive a reconnect or span
  replicas. Finishing this means reading the review back from the store and moving the ledger
  into it.
- **Domain verification is assumed, not performed.** `target-auth.ts` enforces that a host is on
  the tenant's verified list, and `002_review_targets.sql` stores the rows, but nothing here
  issues or checks the DNS TXT / well-known challenges or the GitHub-deployment and provider-
  project proofs the architecture describes. Rows arrive in that table pre-verified by a system
  outside this repo.
- **Metering is accounting, not billing.** Units are reserved and consumed on job records; there
  is no payment integration and no cross-replica ledger.
- **The multimedia and panel surfaces are built but not wired.** `buildDesignReviewContent`,
  `buildMultimediaCritiqueContent`, `buildPanelFindings`, and `handlePanelAction` are implemented,
  exported, and tested, but `server.ts` still returns JSON-only tool results — nothing calls them
  on the live path. The panel HTML itself is a caller-supplied input; the renderer was in an
  unpublished repo, so there is no panel markup in this tree.
- **Feedback events are a schema only.** `schemas/feedback-event.schema.json` and the
  architecture's feedback-writer role exist; there is no writer implementation in `src/`.
- **Protocol baseline is `2025-11-25`.** `execution.taskSupport` is `forbidden` in the catalog —
  MCP Tasks were intended as an optional adapter once client support was proven, and that adapter
  was never written. Likewise, the stateless `2026-07-28` adapter the architecture reserves room
  for does not exist. Application job IDs were always the canonical handle.
- **No published quality numbers.** `EVAL_PLAN.md` describes the protocol, quality, security,
  cost, and agent-loop evaluations that were planned. Assume they were not completed.

## Documentation index

- [docs/install.md](docs/install.md) — how clients connected to the (now retired) hosted server.
- [docs/application-plane.md](docs/application-plane.md) — durable jobs, required adapters,
  readiness, migrations, retention, backup/restore, rollback.
- [RESEARCH.md](RESEARCH.md) — primary-source research, alternatives, client compatibility.
- [PRD.md](PRD.md) — product requirements, users, and success metrics.
- [TRD.md](TRD.md) — tool behavior, lifecycle, auth, domain verification, budgets, errors.
- [ARCHITECTURE.md](ARCHITECTURE.md) — system boundaries, diagrams, failure modes.
- [CONTRACTS.md](CONTRACTS.md) — tool, evidence, engine, UI Graph, UI DNA, and feedback contracts.
- [ADRS.md](ADRS.md) — architecture decisions and rejected alternatives.
- [THREAT_MODEL.md](THREAT_MODEL.md) — assets, trust boundaries, threats, required controls.
- [EVAL_PLAN.md](EVAL_PLAN.md) — protocol, client, quality, security, and cost evaluations.
- [schemas/](schemas/) — machine-readable tool catalog, typed error contract, feedback events.
- [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) — what to expect from an
  archived repo, and how to build it if you fork it.

## License

MIT — see [LICENSE](LICENSE).
