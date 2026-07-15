# MCP Review — production deployment (#36)

The container entrypoint (`dist/main.js`) boots the production composition
root: durable Postgres application plane, signed Judgment Engine async client,
ownership-verified target registry, system DNS resolver, Streamable HTTP
transport with per-client isolation. Missing configuration or an unusable
database exits non-zero at startup; engine/target/DNS health degrade through
`/readyz` (they can recover without a restart).

## Configuration

Transport/auth (consumed by `startFromEnv`):

| Variable | Required | Meaning |
|---|---|---|
| `MCP_RESOURCE_URL` | yes | Public resource id (token `aud`), e.g. `https://mcp.apature.ai` |
| `MCP_AUTHORIZATION_SERVERS` | yes | Comma-separated issuer URLs for RFC 9728 discovery |
| `MCP_JWKS_URL` | yes | Issuer JWKS endpoint |
| `MCP_TOKEN_ISSUER` | yes | Expected token `iss` |
| `PORT` / `MCP_PATH` / `MCP_ALLOWED_HOSTS` | no | Listener basics (defaults 8080 / `/mcp` / resource host) |
| `MCP_MAX_BODY_BYTES` / `MCP_BODY_TIMEOUT_MS` / `MCP_MAX_IN_FLIGHT_PER_PRINCIPAL` | no | HTTP limits |

Application plane (consumed by `bootProduction`):

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres for jobs + verified-target registry |
| `ENGINE_BASE_URL` | yes | Judgment Engine async job API origin |
| `ENGINE_HMAC_SECRET` | yes | Shared secret for signed service-to-service calls (KMS-sourced) |

## Migrations

`migrations/*.sql` apply automatically at boot, in lexical order, tracked in
`mcp_schema_migrations`. One product-scoped transaction advisory lock covers
the post-lock state read, all pending DDL, and all tracking inserts. Concurrent
replica boots serialize; a killed runner rolls back and releases the lock so
another replica can finish. Current set:

- `001_review_application.sql` — `mcp_review_jobs` (tenant-scoped durable jobs,
  `(tenant_id, client_request_id)` idempotency uniqueness, RLS).
- `002_review_targets.sql` — `mcp_review_targets` (ownership-verified capture
  targets; only rows with `verified_at` are served, RLS).

Every applied ID stores the SQL file's SHA-256. The first checksum-aware boot
adopts legacy ID-only rows from the matching files; after that, historical
migration files are immutable and a mismatch fails startup. Add schema changes
in a new migration. Older images ignore unknown, checksum-pinned newer IDs, so
the current additive migrations allow rolling overlap and code rollback. Drain
older replicas before any future migration that is not backward compatible.

The database role must run with RLS enforced (not `BYPASSRLS`); every store
transaction binds `app.tenant_id`.

## Health

- `/livez` — process liveness only.
- `/readyz` — fails (503) until the durable store answers, Judgment Engine's
  `/readyz` answers, the target registry is queryable, and the DNS resolver is
  usable (a definitive NXDOMAIN counts as usable; resolver failure does not).

## Retention, backup, restore, rollback

- **Retention:** every job row carries `expires_at` (result-view lineage stays
  inside the record). Expired rows are eligible for deletion by a scheduled
  `DELETE FROM mcp_review_jobs WHERE expires_at < now()`; engine-side artifacts
  follow Judgment Engine's own retention, referenced by pointer only.
- **Backup:** standard Postgres PITR/base backups cover the whole plane — jobs
  and the target registry are ordinary tables. Restore re-serves job status and
  idempotency; engine results referenced by pointer re-fetch from the engine's
  object store.
- **Rollback:** deploy rollback is safe with the current migration set
  (additive only). A migration that must be reverted needs a forward-fix
  migration; the runner has no down path by design.
- **Replicas:** all replicas share the plane; idempotency is enforced by the
  `(tenant_id, client_request_id)` unique constraint, so concurrent replicas
  cannot duplicate engine submissions or billing.
