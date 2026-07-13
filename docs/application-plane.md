# Production application plane

Added July 11, 2026 for issue #36.

MCP transports are disposable. Product jobs live in `ReviewApplicationStore`, keyed by the credential-derived tenant plus the MCP job ID. Idempotency is uniquely reserved as `(tenant_id, client_request_id)` with the normalized request hash stored beside it; an exact retry reuses the job and a different hash fails with `IDEMPOTENCY_CONFLICT`.

## Required composition

Production startup must inject all of the following into `startFromEnv`:

- `PostgresReviewApplicationStore` backed by migration `packages/mcp-server/migrations/001_review_application.sql`;
- an `EngineJobClient` backed by the signed Judgment Engine API, plus `JudgmentEngineHttpClient.ready` for readiness;
- an ownership-verified `AllowlistResolver` with a real readiness probe;
- the sandboxed `DnsResolver` and its readiness probe.

The container entrypoint deliberately refuses to boot with placeholders. `/livez` proves only that the process is alive. `/readyz` returns 503 until the job store, Judgment Engine, target store, and DNS boundary all report usable.

## HTTP resource limits

Added July 12, 2026 for issue #42.

Authenticated MCP POSTs are bounded before the SDK transport or application
plane sees them. The production defaults are a 256 KiB body, a 30 second total
body/request lifetime, 10 second headers, 5 second keep-alive, 100 requests per
socket, and 8 in-flight requests per verified tenant/principal. The body ceiling
has a non-configurable 1 MiB hard maximum and the per-principal ceiling has a
hard maximum of 64.

Set `MCP_MAX_BODY_BYTES`, `MCP_BODY_TIMEOUT_MS`, and
`MCP_MAX_IN_FLIGHT_PER_PRINCIPAL` only when a measured client requirement needs
the override. Oversized declared bodies fail before reading; chunked bodies stop
buffering at the ceiling. Unsupported media, malformed JSON/UTF-8, slow bodies,
and saturation return deterministic 415/JSON-RPC parse/408/429 responses without
echoing or logging payloads or credentials. `metrics()` exposes only aggregate
in-flight, rejection-reason, and rejected-byte counters. Capacity saturation
never changes `/readyz`; readiness continues to report dependency health only.

Judgment Engine calls sign the exact request body with HMAC-SHA256, propagate correlation/trace identifiers, enforce bounded timeouts/retries, honor `Retry-After` for 429/503, and reject a missing or mismatched `x-schema-version`.

## Durable cancellation binding

Added July 12, 2026 for issue #32.

The MCP product job ID and Judgment Engine job ID are distinct. Submission stores the engine ID on the tenant/principal-owned application record; poll and cancel always address that stored engine ID. A cancel that races submission records its timestamp, first reason, and `awaiting_engine_job_id` decision, then the submitter forwards the request as soon as the upstream ID is durable.

Only credentials carrying `reviews:cancel` can read or mutate cancellation state. Transport sessions are bound to both tenant and principal, so another client in the same tenant cannot reuse a session ID. Duplicate cancellation calls poll the existing request rather than issuing repeated upstream deletes. The store transaction is the completion-versus-cancel linearization point: terminal cancellation suppresses a late result, while a completion that commits first remains immutable. Units stay reserved but unconsumed until completion; cancellation consumes none.

## Migration and retention

Apply migrations before bringing up a new application revision. The table uses tenant-scoped primary/unique keys and Postgres RLS; the adapter binds `app.tenant_id` inside every transaction. Grant the runtime role no `BYPASSRLS` privilege.

Expire terminal records only after the public `expires_at` plus the support/replay window. A sweeper may delete expired rows in bounded batches, but must retain the budget/audit ledger according to tenant policy. Never reuse an expired `client_request_id` while its ledger entry remains in retention.

## Backup, restore, and rollback

- Back up the application table with the same point-in-time recovery policy as the budget ledger.
- Restore application jobs and ledger state to one consistent recovery point; do not restore either independently.
- After restore, keep non-terminal jobs pollable and reconcile their `engine_job_id` before accepting cancellation or settlement.
- Roll back application code before rolling back an additive migration. This migration is backward-compatible; leave the table and RLS policy in place during code rollback.
- Verify `/readyz`, then run the deterministic reconnect, cross-tenant, and idempotency-race fixtures before restoring traffic.

Staging graduation additionally requires a verified target to complete through the real Judgment Engine and a focused recheck/cancel exercise. Default tests use only in-memory stores and fake HTTP responses—never a model, browser, or network.
