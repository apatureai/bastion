# Production application plane

Added July 11, 2026 for issue #36.

MCP transports are disposable. Product jobs live in `ReviewApplicationStore`, keyed by the credential-derived tenant plus the MCP job ID. Idempotency is uniquely reserved as `(tenant_id, client_request_id)` with the normalized request hash stored beside it; an exact retry reuses the job and a different hash fails with `IDEMPOTENCY_CONFLICT`.

## Required composition

Production startup must inject all of the following into `startFromEnv`:

- `PostgresReviewApplicationStore` backed by migration `packages/mcp-server/migrations/001_review_application.sql`;
- an `EngineClient` backed by the signed Judgment Engine API, plus `JudgmentEngineHttpClient.ready` for readiness;
- an ownership-verified `AllowlistResolver` with a real readiness probe;
- the sandboxed `DnsResolver` and its readiness probe.

The container entrypoint deliberately refuses to boot with placeholders. `/livez` proves only that the process is alive. `/readyz` returns 503 until the job store, Judgment Engine, target store, and DNS boundary all report usable.

Judgment Engine calls sign the exact request body with HMAC-SHA256, propagate correlation/trace identifiers, enforce bounded timeouts/retries, honor `Retry-After` for 429/503, and reject a missing or mismatched `x-schema-version`.

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
