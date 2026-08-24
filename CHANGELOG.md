# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions below track the
**release/package version** in the workspace `package.json` files and the git tags.

> **Two version numbers, on purpose.** This repository carries two independent version schemes and
> this changelog tracks only the first. See
> [Versioning](README.md#versioning-two-numbers-on-purpose) for the full explanation.
>
> - **Release version** (`0.1.0` here): the npm package version and the git tag / GitHub release.
>   This is what an adopter pins and what every entry below is filed under.
> - **Catalog version** (`1.3.0`): the MCP protocol surface a client sees on the wire, advertised by
>   `directory/server.json`, `schemas/mcp-tools.json`, and the server handshake, and locked across
>   all three by the `catalog-drift` test. It moves when the tool contract changes, not when a
>   release is cut, so it is not tracked here.

## [Unreleased]

### Added

- `CHANGELOG.md` (this file).
- `.github/workflows/release.yml`: on a `v*` tag it builds, runs the full suite, creates a GitHub
  release from the matching changelog section, and — only when an `NPM_TOKEN` secret is present —
  publishes both workspace packages to npm with provenance. The token is a maintainer opt-in; the
  publish step is skipped when it is absent, so tagging never publishes by surprise.
- `examples/local-review/`: a standalone, dependency-free Node script an adopter can run against a
  built checkout to drive a full review loop over MCP and write out the `Critique` JSON and panel.
- README `Versioning` and `Releasing` sections, and a `Releasing` section in `CONTRIBUTING.md`,
  documenting the two version schemes and the tag-driven release flow.

### Changed

- Packages renamed to the `@apatureai/*` scope, matching the GitHub org and ahead of the first npm
  publish (nothing was published under the old scope). `@apature/mcp-server` → `@apatureai/bastion`,
  `@apature/mcp-types` → `@apatureai/bastion-types`, and the private monorepo root
  `@apature/mcp-review-monorepo` → `@apatureai/bastion-mcp-review-monorepo`. All cross-package
  dependencies, imports, tsconfig/vitest aliases, and docs were updated to match.
- `@apatureai/bastion` and `@apatureai/bastion-types` are no longer `private`. Both now declare
  `publishConfig.access: "public"` and a `prepack` build so they can be published to npm under the
  `@apatureai` scope. The monorepo root stays private and is never published. Publishing
  still requires the maintainer to add the `NPM_TOKEN` secret; nothing is published automatically by
  these changes.
- `packages/mcp-server/src/boot.ts` gained a `#!/usr/bin/env node` shebang so the
  `mcp-review-server` bin is directly executable, matching the other two bins.

## [0.1.0] - 2026-08-10

First tagged release. The code is unchanged from the last commit on `main` at tag time; the tag
exists as a fixed point to clone, cite, and file issues against.

### Added

- The full five-tool MCP server running locally over stdio, offline, with no credentials, no
  database, no Docker, and no network calls (`design_review`, `design_review_get`,
  `design_recheck`, `design_review_cancel`, `design_review_panel_action`) and all five result views
  (`status`, `summary`, `findings`, `focus`, `evidence`).
- Target authorization on every submit: HTTPS-only canonicalization, an ownership-verified host
  allowlist, full IP-range egress classification (loopback, RFC 1918, link-local, cloud metadata,
  reserved, NAT64, 6to4, CGNAT), and rejection of mixed public/private DNS answers as a rebind
  attempt.
- Job lifecycle with idempotency on a caller-supplied `client_request_id`, recheck semantics with
  zero-charge rejection paths, and cancellation arbitration that cannot be raced.
- The Streamable HTTP edge: RFC 9728 discovery, JWKS-backed JWT verification, per-client transport
  isolation, body and in-flight limits, tested over real HTTP.
- The Postgres application plane: advisory-locked, checksum-pinned migrations, tenant-keyed tables
  with RLS, tested against PGlite in-process and against real Postgres in CI.
- Multimodal results: an interactive self-contained review panel, per-finding text, and evidence
  images, with an honest downgrade that names withheld images rather than dropping them silently.
- Provenance and coverage stamping so a fixture judgment can never be mistaken for a model's: every
  `Critique` carries `provenance.model_backed` and `coverage.state`, and an unjudged or
  nothing-reviewed run is graded `"unjudged"` / `"nothing_reviewed"` rather than a flattering value.

### Known gaps at this release

- Judgments come from a golden fixture unless a critique backend is configured; the payload says so.
- `design_recheck` reports `"unjudged"` on the fixture path and is not wired to a verdict backend.
- No hosted endpoint; `directory/server.json` deliberately declares no `remotes`.
- Evidence crops are deterministic placeholder PNGs, not your page's pixels.
- The auth path has not had an external security review.

See the README's [Status and roadmap](README.md#status-and-roadmap) for the full, current list.

[Unreleased]: https://github.com/apatureai/bastion/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/apatureai/bastion/releases/tag/v0.1.0
