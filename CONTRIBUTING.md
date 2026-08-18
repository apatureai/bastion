# Contributing

Contributions are welcome. Bug reports, failing test cases, documentation fixes, and roadmap items
from the README are all useful, and small pull requests are easier to land than large ones.

If you are looking for somewhere to start, the numbered list in the README's
[Status and roadmap](README.md#status-and-roadmap) section is ordered roughly by value, and each
item names the seam to work against. Items 3 (real evidence images), 4 (move the recheck index and
unit ledger into the store), and 7 (feedback event writer) are self-contained and do not require
standing up anything outside this repository.

## Setup

Prerequisites:

- **Node 24 or newer.** `.node-version` pins `24`; CI runs that version.
- **pnpm 9.15.0.** `corepack enable` picks it up from the `packageManager` field.

```bash
git clone https://github.com/apatureai/bastion.git
cd bastion
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Nothing else is required: no API keys, no database, no Docker. `pnpm install` is the only step that
needs network access.

## Test, lint, typecheck

```bash
pnpm lint        # eslint . --max-warnings=0  (warnings fail the build)
pnpm typecheck   # tsc -b across project references
pnpm build       # tsc -b (same compiler invocation; emits dist/)
pnpm test        # vitest run
pnpm clean       # tsc -b --clean, removes build output
```

CI runs lint, typecheck, and test in that order, and a pull request needs all three green.

On this tree with Node 24.14.0, `pnpm test` reports 39 files passed and 1 skipped (397 passed,
3 skipped). Two of the skipped tests are the skipped file, which needs Postgres; the third needs a
verdict checkout. Both are below, and neither passes quietly when it does not run.

`pnpm build` also produces the runnable server and the worked example: `pnpm start:local` runs the
credential-free MCP server over stdio, and `pnpm demo` drives a full review loop against it. If you
change anything on the tool surface, run `pnpm demo` as well as the suite; it is the fastest way to
see the whole path.

One thing to know before you file a flake: a single unidentified test failure appeared once in
roughly 43 consecutive full-suite runs and has not reproduced since. If you see a red run on an
unchanged commit, re-run it before treating it as a regression, and if you can reproduce it
reliably, please open an issue with the seed and the output. Vitest's `testTimeout` and
`hookTimeout` are raised to 30s in `vitest.config.ts` because a cold first run instantiates PGlite
(WASM Postgres) inside a hook and can exceed the 5s default.

### Postgres-backed tests

`packages/mcp-server/test/production-postgres.test.ts` exercises migration arbitration against a
real database and is skipped unless `MCP_TEST_DATABASE_URL` is set. CI uses `postgres:17-alpine`;
locally:

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcp_review_test postgres:17-alpine

MCP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mcp_review_test \
  pnpm test
```

With a database supplied the suite is 40 files / 399 passed and 1 skipped. The suite creates and
drops its own throwaway schemas, so point it at a scratch database, never a real one.

### The upstream-fixture test

`packages/mcp-types/test/golden.test.ts` carries one test that compares this repository's copy of
the shared result contract against a real `apatureai/verdict` checkout, so it needs one on disk and
is skipped unless `VERDICT_REPO` points at a clone. It reports as SKIPPED rather than as a pass on
purpose: a check that did not run must never look like a check that agreed. CI performs the same
comparison in the separate `upstream-fixtures` job, which checks verdict out and runs
`scripts/verify-upstream-fixtures.mjs`.

```bash
git clone https://github.com/apatureai/verdict.git /tmp/verdict
VERDICT_REPO=/tmp/verdict pnpm test
```

With both variables set the suite is 40 files / 400 tests, none skipped.

## Layout

pnpm workspace, TypeScript, two packages:

- `packages/mcp-types` holds the boundary contracts: tool envelopes, the `Critique` result shape,
  and golden engine fixtures. Single source of truth for the agent-facing surface. No runtime
  dependencies, and it should stay that way.
- `packages/mcp-server` is the MCP server: tools, views, auth, job store, rate limiting, engine
  client, Postgres application plane, and both composition roots.

Supporting material: `schemas/` (machine-readable MCP tool and error schemas),
`directory/server.json` (the registry listing), and `migrations/` under `packages/mcp-server`. The
README has a file-by-file map.

## Conventions that matter

- **The product boundary is load-bearing.** This server judges, explains, and verifies. It never
  edits code, commits, pushes, opens pull requests, or drives the customer's application. It is the
  eyes; the agent is the hands. Most of the type and tool design only makes sense with that
  constraint held, and `panel-interaction.ts` is where it is easiest to break by accident.
- **The tool catalog is the published contract, served verbatim.** `tools/list` advertises the
  `inputSchema` and `outputSchema` straight out of `schemas/mcp-tools.json` (`tool-catalog.ts`), so
  editing that file changes what every client is told. The Zod shapes in `tools.ts` are what the
  server parses, not what it advertises; `schema-conformance.test.ts` validates every call against
  the advertised input schema and every payload against the advertised output schema, so a shape
  that disagrees with the catalog fails CI in either direction. `schemas/mcp-tools.json`,
  `directory/server.json`, and the live `tools/list` are also cross-checked by `directory.test.ts`
  and `catalog-drift.test.ts`, including the version string. Change one, change all three.
- **Contracts live in `mcp-types`**, with golden fixtures under `packages/mcp-types/fixtures`.
  Changing a result shape means updating the golden file deliberately, not regenerating it to make
  tests pass. If a shape change is the point of your PR, say so in the description.
- **ESM everywhere.** `"type": "module"` in both packages, and relative imports carry the `.js`
  extension even in TypeScript source (`./local-server.js`). TypeScript project references wire the
  packages together, so `tsc -b` from the root is the only build you need.
- **Entrypoints stay out of import cycles.** `src/boot.ts` is the process entrypoint rather than
  `src/main.ts` because `production.ts` imports `startFromEnv` from `main.ts`, and a top-level boot
  guard inside `main.ts` formed an ESM cycle that never settled. Same reason `local-stdio.ts` is
  separate from `local-server.ts`. Keep the entrypoint out of the cycle if you refactor this.
- **Zero-warning lint.** `eslint . --max-warnings=0`. Do not disable a rule inline without a comment
  explaining why.
- **A fixture must never pass for a judgment.** `src/engine-runtime.ts` resolves which critique
  backend a process runs and returns a one-line description with it; every entrypoint prints that
  line before doing any work, and a half-configured backend fails at startup instead of falling
  back to fixtures. If you add a backend, add its description, keep `modelBacked` honest (`null`
  when the answer lives in someone else's process), and never synthesize an engine result the
  engine did not produce.
- **No em dashes in prose or output strings**, and no AI attribution in commits, comments, or docs.
- New behaviour ships with a test. The suite is fast and runs offline, so there is no excuse.

## Security-sensitive areas

Changes to these get read closely, and a PR that touches them should explain the threat model
implication in the description:

- `src/target-auth.ts` and `src/egress.ts`: the SSRF boundary. Never widen the allowlist semantics,
  never leak which internal address resolved, and add a test for every new address range.
- `src/auth.ts`, `src/jwt-verifier.ts`: token verification and scope derivation.
- `src/http-server.ts`: body limits, media type, in-flight caps, Host allowlist.
- `src/panel-html.ts`: everything page-derived is escaped, and the panel fetches nothing.
- `src/pg.ts` and `migrations/`: applied migrations are checksum-pinned and immutable. Add a new
  file; never edit a historical one.

Please report vulnerabilities privately rather than in a pull request. See [SECURITY.md](SECURITY.md).

## Pull requests

- Branch from `main`, keep the change focused, and explain what it does and why in the description.
- Make sure `pnpm lint && pnpm typecheck && pnpm test` passes locally before you open it. CI runs
  the same three.
- Pull requests are reviewed by the maintainer. Expect a first response within about a week; ping on
  the PR if it goes quiet longer than that.
- Review is about correctness, the boundaries above, and test coverage. Style is enforced by lint,
  so there is nothing to argue about there.
- For anything large, or anything that changes a contract in `mcp-types`, open an issue first so the
  design conversation happens before you write the code.
