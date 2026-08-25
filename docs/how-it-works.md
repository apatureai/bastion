Part of [bastion](../README.md). Moved from the README on 2026-08-24; anchors preserved.

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

The client gets a `job_id` and a `poll_after_ms`, and polls `design_review_get`, which refreshes from the engine when a refresh is due and returns the completed `Critique`. Locally the same path runs against an in-memory store, synchronously: the job is already `completed` when submit returns. What answers there is the fixture engine by default, or a verdict backend when one is configured, behind the same `EngineClient` port.

A recheck adds: the prior review must exist and be completed; every requested finding id must belong to it; the target host must be unchanged; and the target fingerprint (URL plus `expected_revision`) must actually have changed, or it is rejected as `TARGET_UNCHANGED` without running judgment. Rejections and throttles both happen before any unit is reserved, so they cost nothing.

### What is real and what is synthetic offline

This is the unconfigured server, the one `pnpm demo` drives. [Getting real judgments](../README.md#getting-real-judgments) replaces the fixture findings and the withheld panel fix; the rows below say what each part does until then, and which of them a verdict backend does not change.

| Part | Offline behaviour |
|---|---|
| MCP protocol, tools, input validation, error taxonomy | Real |
| Target authorization, egress classification, DNS-rebind rejection | Real (runs on every submit) |
| Job lifecycle, idempotency, budgets, recheck rejection and throttling | Real |
| Views, content blocks, panel projection and reducer | Real |
| The findings themselves | **Fixture, and the payload says so.** A golden engine result about a fictional pricing page, not a judgment of the URL you passed: `provenance.model_backed` is `false`, the grade is `"unjudged"`, every finding carries `"unjudged": true`, and `not_reviewed[0]` discloses it. Set `VERDICT_CLI` and they are a real critique of your page. See [Provenance](../README.md#provenance-did-anything-judge-this-page) |
| What the run covered | **Real, and carried from the engine.** `coverage` and `hallucination_drops` are verdict's own fields, passed through rather than computed here. Against the fixture they describe the golden run's honest partial (`/pricing` reviewed, `/checkout` skipped). An engine that does not report coverage yields `state: "unstated"`, which is never read as "everything was reviewed". See [Coverage](../README.md#coverage-what-did-it-actually-look-at) |
| Recheck outcomes | **Fixture, and the payload says so.** Derived from a hash of the finding id, so every outcome is `"unjudged"` with a `null` confidence and a reason that claims no observation of your target. Not available against a verdict backend at all; see [What is not wired yet](configuration.md#what-is-not-wired-yet) |
| A routed panel fix | **Withheld.** `design_review_panel_action` returns `unjudged` rather than handing fixture text to a coding agent |
| DNS | **Stub for the demo host only.** `preview.example.com` is answered from a constant so the demo makes no network call; every other host, including any you add, goes to the system resolver and is then classified for real |
| Evidence crops | **Placeholder.** Deterministic generated PNGs where the engine's annotated screenshots would be. Verdict's own screenshots are written to `out/verdict/<run>/screenshots` when a backend is configured |

## Repository map

```
packages/mcp-types/                boundary contracts, no runtime dependencies
  src/critique.ts                  agent-facing envelopes (Job, Budget, Critique, content blocks)
  src/engine.ts                    engine wire result + confidence/calibration types
  src/provenance.ts                the judgment-provenance contract (model_backed, source, engine)
  src/error.ts                     typed ReviewError contract (code, retriable, next_action)
  src/panel.ts                     MCP-Apps panel action/response contract
  fixtures/                        golden engine result, the offline judgment

packages/mcp-server/
  src/tools.ts                     Zod input schemas: what the server parses
  src/tool-catalog.ts              schemas/mcp-tools.json served verbatim: what tools/list advertises
  src/server.ts                    the five MCP tools, views, and typed error mapping
  src/local-server.ts              local composition root (fixture engine unless one is configured)
  src/local-stdio.ts               `bastion` / `bastion-local` process entrypoint (stdio transport)
  src/demo.ts                      the quickstart client: spawns the server, drives the loop
  src/review-cli.ts                `pnpm review <url>`: the same client, pointed at your target
  src/engine-runtime.ts            which critique backend this process runs, read from the env
  src/verdict-cli-engine.ts        backend: a local verdict checkout, driven through its CLI
  src/verdict-job-engine.ts        backend: a running verdict deployment, over its signed job API
  src/engine-result.ts             structural validation of a result that came from another program
  src/review-service.ts            job lifecycle, idempotency, budgets, recheck semantics
  src/normalize.ts                 request normalization and the idempotency fingerprint
  src/target-auth.ts               canonicalization, verified-host check, rebind rejection
  src/egress.ts                    pure IP classification (private/loopback/metadata/reserved)
  src/rate-limit.ts                recheck budgets, per-finding windows, backoff
  src/critique-map.ts              engine result -> agent-facing Critique, and the unjudged rule
  src/recheck-map.ts               engine recheck -> agent-facing Recheck, same unjudged rule
  src/provenance.ts                where every provenance stamp is minted, one module
  src/multimedia-content.ts        content-block shaping with capability downgrade
  src/panel-html.ts                the MCP-Apps panel document (escaped, self-contained)
  src/panel-findings.ts            Critique -> fix items -> PanelFindings
  src/panel-interaction.ts         the pure panel reducer (grounded -> agent, advisory -> human, unjudged -> nobody)
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
examples/local-review/             standalone, dependency-free review loop over MCP stdio (see examples/README.md)
```

Some source comments cite design documents by shorthand (`TRD §4.1`, `THREAT_MODEL T1`) and issue numbers from a private tracker. Those documents are not in this repository; the citations are left in place as provenance for the decisions they explain.
