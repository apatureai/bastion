# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the npm
packages. Note that the on-the-wire `serverInfo`/tool-catalog version (`1.3.0`)
is the protocol/tool-contract version and is deliberately independent of the
package/release version tracked here.

## [Unreleased]

### Added
- **Runnable local walkthrough of the remote HTTP + OAuth 2.1 edge** (`pnpm dev:http`).
  A development composition root boots the same Streamable HTTP transport, JWT
  verifier, and SSRF boundary the production edge serves, against a fixture engine
  and an in-memory store — no database, no real IdP, no model. A throwaway
  in-process issuer generates an ES256 keypair, serves a real JWKS, and mints a
  working bearer token carrying the `tenant_id` and `scope` claims the verifier
  requires. It is never imported by the production root.
- **`pnpm register-target`**: the documented, runnable procedure a
  `DOMAIN_UNVERIFIED` / `verify_domain` rejection points at, recording a verified
  target host in `mcp_review_targets` under the server's own RLS tenant binding.
- **`examples/`** directory with copy-pasteable MCP client registration configs
  for the local stdio server and the dev HTTP edge.
- **npm-publish readiness**: both workspace packages carry `publishConfig.access`,
  a `prepublishOnly` build, and a `README`/`LICENSE` in the tarball; a
  `release.yml` workflow publishes on `vX.Y.Z` tags with provenance once a
  maintainer adds an `NPM_TOKEN` secret and owns the `@apature` scope.
- **`UPSTREAM_UNAVAILABLE` / `UPSTREAM_RATE_LIMITED`** are now emitted: an
  unreachable or throttling judgment engine surfaces as a distinct, retriable
  upstream error (with the engine's `Retry-After`) instead of a generic
  `INTERNAL_ERROR`, so an agent loop can tell a dependency outage from a bug here.

### Changed
- **Output schemas are fully closed.** Every payload body in
  `schemas/mcp-tools.json` — `job`, `review`, each finding item, `provenance`,
  `recheck` and its outcomes, `budget` — now sets `additionalProperties: false`
  and declares its complete shape, so the Ajv conformance test catches an
  undeclared emitted field rather than passing trivially over an open subtree.
  The advertised finding item now declares `finding_id`, `severity`, `dimension`,
  `title`, `description`, `route`, `viewport`, `element_ref`, `suggestion`,
  `evidence_id`, `confidence`, and the `unjudged` marker. The one deliberate
  open bag is a typed error's `details`.

### Fixed
- Documentation now matches reality: the version-identity relationship
  (`0.1.0` package vs `1.3.0` wire), the npm-publish status, and the
  schema-checkability claim are all stated truthfully.

## [0.1.0] - 2026-08-10

First tagged release. A fixed point to clone, cite, and file issues against; no
code changed from the last `main` commit at tagging time.

### Added
- The full five-tool MCP server over stdio, offline, with no credentials, no
  database, and no network calls: `design_review`, `design_review_get`,
  `design_recheck`, `design_review_cancel`, `design_review_panel_action`, and the
  five result views (`status`, `summary`, `findings`, `focus`, `evidence`).
- Target authorization on every submit: HTTPS-only canonicalization, an
  ownership-verified host allowlist, full IP-range egress classification, and
  DNS-rebind rejection (`egress.ts`, pure and dependency-free).
- Job lifecycle with idempotency, recheck semantics with zero-charge rejection
  paths, and un-raceable cancellation arbitration.
- The Streamable HTTP edge: RFC 9728 discovery, JWKS-backed JWT verification,
  per-client transport isolation, and request limits, tested over real HTTP.
- The Postgres application plane: advisory-locked, checksum-pinned migrations and
  tenant-keyed tables with RLS, tested against PGlite and real Postgres.
- Multimodal results: a self-contained interactive review panel, per-finding
  text, and evidence images, with an honest capability downgrade.
- Provenance and coverage on every review, so a consumer reading only the JSON
  can tell whether a model judged the page and whether it judged anything.

### Known gaps at this release
- Judgments come from a golden fixture; no real critique backend is wired.
- Evidence crops are deterministic placeholder PNGs, not the page's pixels.
- The recheck index and unit ledger are in-memory, per MCP connection.
- Domain-ownership proofs are not issued here; rows are expected pre-verified.
- No published quality numbers; the auth path has had no external security review.

[Unreleased]: https://github.com/apatureai/bastion/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/apatureai/bastion/releases/tag/v0.1.0
