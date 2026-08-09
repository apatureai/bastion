# Contributing

**This project is archived.** Apature has been wound down and this repository is published as a
snapshot for people who want to read or reuse the code.

What that means in practice:

- Issues and pull requests may never be reviewed, and probably will not be.
- No roadmap, no releases, no maintenance commitment.
- **Forking is encouraged.** MIT license, no strings. If you want to carry any of this forward,
  fork it and make it yours — that is a better use of your time than waiting on a review here.

The rest of this file exists so that a fork starts from working instructions rather than
guesswork.

## Layout

pnpm workspace, TypeScript, two packages:

- `packages/mcp-types` — boundary contracts: tool envelopes, the `Critique` result shape, and
  golden engine fixtures. Single source of truth for the agent-facing surface.
- `packages/mcp-server` — the Streamable HTTP MCP server: tools, auth, job store, rate limiting,
  engine client, Postgres application plane.

Supporting material: `schemas/` (machine-readable MCP tool and error schemas),
`directory/server.json` (the directory listing), `migrations/` under `packages/mcp-server`, and
the design docs listed in the README.

## Building and testing

Prerequisites:

- **Node 24 or newer** (`.node-version` pins `24`; CI runs that version).
- **pnpm 9.15.0** — `corepack enable` picks it up from the `packageManager` field.

```bash
pnpm install --frozen-lockfile
pnpm lint        # eslint . --max-warnings=0  (warnings fail)
pnpm typecheck   # tsc -b across project references
pnpm build       # tsc -b (same compiler invocation; emits dist/)
pnpm test        # vitest run
```

`pnpm clean` (`tsc -b --clean`) removes build output.

All of these were run green against this tree on Node 24.14.0. `pnpm test` reports 23 files
passed and 1 skipped (222 passed, 2 skipped); the skipped file needs Postgres, below.

One caveat, recorded for honesty: during archival testing a single unidentified test failure
appeared in one of ~43 consecutive full-suite runs and could not be reproduced in the other 42.
If you see a red run on an unchanged commit, re-run before treating it as a regression. Vitest's
`testTimeout`/`hookTimeout` were raised to 30s in `vitest.config.ts` because a cold first run
instantiates PGlite (WASM Postgres) inside a hook and could exceed the 5s default.

### Postgres-backed tests

`packages/mcp-server/test/production-postgres.test.ts` exercises migration arbitration against a
real database and is skipped unless `MCP_TEST_DATABASE_URL` is set. CI used `postgres:17-alpine`;
locally:

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcp_review_test postgres:17-alpine

MCP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mcp_review_test \
  pnpm test
```

With a database supplied the suite is 24 files / 224 tests, all passing. The suite creates and
drops its own throwaway schemas — point it at a scratch database, never a real one.

### Running the server

`packages/mcp-server` exposes `mcp-review-server` (`node dist/boot.js`). It fails closed, with a
readable message, without `MCP_RESOURCE_URL`, `MCP_AUTHORIZATION_SERVERS`, `MCP_JWKS_URL`,
`MCP_TOKEN_ISSUER`, `DATABASE_URL`, `ENGINE_BASE_URL`, and `ENGINE_HMAC_SECRET`. The `Dockerfile`
builds the workspace and runs that entrypoint on port 8080 with `/livez` and `/readyz` probes. See
`packages/mcp-server/DEPLOYMENT.md` and `docs/application-plane.md` — noting that the hosted
service those docs describe is no longer operated, and that a real Judgment Engine to point
`ENGINE_BASE_URL` at is not part of this release.

`src/boot.ts` is the entrypoint rather than `src/main.ts` on purpose: `production.ts` imports
`startFromEnv` from `main.ts`, so a top-level boot guard inside `main.ts` formed an ESM import
cycle that never settled. Keep the entrypoint out of the cycle if you refactor this.

## Conventions, if you fork

- **The product boundary is load-bearing.** Apature is the eyes; the agent is the hands. This
  server judges, explains, and verifies — it never edits code, commits, pushes, opens pull
  requests, or drives the customer's application. Most of the type and tool design only makes
  sense with that constraint held.
- **The tool catalog is contract-tested.** `schemas/mcp-tools.json`, `directory/server.json`, and
  the live server's `tools/list` are cross-checked by `directory.test.ts` and
  `catalog-drift.test.ts`. Change one, change all three.
- **Contracts live in `mcp-types`**, with golden fixtures under `packages/mcp-types/fixtures`.
  Changing a result shape means updating the golden file deliberately, not regenerating it to make
  tests pass.
- Lint is zero-warning, and CI ran lint, typecheck, and test in that order.

## If you open a PR anyway

That is fine — just calibrate your expectations. Keep it small, explain the change in the
description, and make sure `pnpm lint && pnpm typecheck && pnpm test` passes. It may sit
unreviewed indefinitely, and a fork is the supported path.
