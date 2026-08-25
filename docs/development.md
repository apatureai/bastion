Part of [bastion](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Development

```console
$ pnpm test

 RUN  v4.1.10

 Test Files  39 passed | 1 skipped (40)
      Tests  398 passed | 3 skipped (401)
```

```bash
pnpm lint                                                  # eslint, warnings fail the build
pnpm typecheck                                             # tsc -b across project references
pnpm test packages/mcp-server/test/local-server.test.ts    # one file
pnpm demo                                                  # the fixture-backed protocol walkthrough
pnpm review <https url>                                    # one review through the configured backend
pnpm clean                                                 # remove build output
```

Three tests do not run by default, and each names the environment variable that turns it on rather than passing quietly. Two of them are the skipped file, `packages/mcp-server/test/production-postgres.test.ts`, which exercises migration arbitration against a real database and runs when `MCP_TEST_DATABASE_URL` is set. With one supplied the suite is 40 files / 400 passed, 1 skipped:

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcp_review_test postgres:17-alpine

MCP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mcp_review_test pnpm test
```

That suite creates and drops its own schemas, so point it at a scratch database only.

The third is the one still skipped above: `packages/mcp-types/test/golden.test.ts` compares this repository's copy of the shared result contract against a real verdict checkout, which needs one on disk. Point `VERDICT_REPO` at a clone and the suite is 40 files / 401 tests, none skipped. Without it the in-process test that does run proves only that nobody edited Bastion's copy, and its name says exactly that; the cross-repo comparison is the `upstream-fixtures` CI job, which checks verdict out and runs `scripts/verify-upstream-fixtures.mjs` against it.

```bash
git clone https://github.com/apatureai/verdict.git /tmp/verdict
VERDICT_REPO=/tmp/verdict pnpm test
```

Nothing in the suite touches a model, a browser, a subprocess, or the network: the engine is a fixture mock, the verdict backends are driven through their process and transport seams, DNS is stubbed or answered from a constant, and the Postgres application plane runs in-process against [PGlite](https://pglite.dev). `vitest.config.ts` raises the timeouts to 30s because a cold first run instantiates PGlite (WASM Postgres) inside a hook.

`@apatureai/bastion` and `@apatureai/bastion-types` are published to npm under the `@apatureai` scope, with provenance, by the tag-driven release workflow. See [Releasing](#releasing) for the flow and [CONTRIBUTING.md](../CONTRIBUTING.md) for conventions and how changes get reviewed.

## Regenerating the hero image

The README hero (`docs/assets/hero.png`) is a real `pnpm demo` transcript rendered in the shared terminal frame (`docs/assets/terminal-frame.html`). To regenerate it after the demo output changes:

```bash
pnpm build
pnpm demo | sed -n '/mcp-review local server ready/,$p' > docs/assets/hero-transcript.txt
# drop docs/assets/hero-transcript.txt into the <pre> of docs/assets/terminal-frame.html (HTML-escaped),
# then screenshot the .frame element at width 1520, deviceScaleFactor 2, with a headless Chromium:
node -e "const {chromium}=require('/absolute/path/to/verdict/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core');(async()=>{const p=require('path');const b=await chromium.launch({headless:true});const pg=await b.newPage({deviceScaleFactor:2});await pg.setViewportSize({width:1520,height:1200});await pg.goto('file://'+p.resolve('docs/assets/terminal-frame.html'),{waitUntil:'networkidle'});await (await pg.\$('.frame')).screenshot({path:'docs/assets/hero.png'});await b.close();})()"
```

Bastion ships no browser install script of its own; the command above borrows the Chromium a sibling [apatureai/verdict](https://github.com/apatureai/verdict) checkout installs via `pnpm browser:install`.

## Releasing

Releases are cut from a git tag and automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml). The tag tracks the **release
version** above.

1. Land the change set on `main`. Move the `## [Unreleased]` notes in [`CHANGELOG.md`](../CHANGELOG.md)
   under a new `## [x.y.z] - YYYY-MM-DD` heading, and bump `version` in both package `package.json`
   files (and the root) to `x.y.z`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The workflow builds, runs the full suite, verifies the tag matches `package.json`, and creates a
   GitHub release whose notes are the matching `CHANGELOG.md` section.
4. **npm publish is opt-in.** The workflow publishes both packages to npm with provenance *only if an
   `NPM_TOKEN` secret is present* on the repository; without it the publish step is skipped and only
   the GitHub release is created. To enable publishing, the maintainer adds an npm automation token
   as the `NPM_TOKEN` repository secret (Settings -> Secrets and variables -> Actions). Nothing here
   publishes to npm automatically until that secret exists.

The catalog version is not touched by this flow. It moves only when the tool contract in
`schemas/mcp-tools.json` and `directory/server.json` changes, together, as the `catalog-drift` test
requires.
