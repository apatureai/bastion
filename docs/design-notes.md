Part of [bastion](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Who this is for

- **Engineers building a remote MCP server.** Streamable HTTP, OAuth 2.1 resource-server auth with RFC 9728 discovery and JWKS verification, per-client transport isolation, request limits, and a tenant-scoped Postgres plane, all under test. There is not much public prior art for this shape.
- **Anyone whose agent fetches a model-supplied URL.** `target-auth.ts` and `egress.ts` are a complete, dependency-free SSRF boundary you can read in one sitting and lift into your own server.
- **People wiring long-running work behind MCP.** Capture plus inference takes minutes; MCP clients time out in seconds. The submit-and-poll job design, the idempotency key, and the cancellation arbitration are the answer worked all the way through.
- **People building AI design review.** The tool surface, the `Critique` contract, the multimodal content shaping, and the judge/act boundary are the product-shaped part.

## What it does

- Runs a complete five-tool MCP server locally over stdio, with no credentials, no database, no network calls, and no model. Set `VERDICT_CLI` and the same server reviews your page for real.
- Submits a review of an HTTPS preview URL as an async job, and serves the result through five views: `status`, `summary`, `findings`, `focus`, `evidence`.
- Returns findings as MCP content blocks (an interactive HTML review panel, per-finding text, annotated evidence images), degrading honestly on a host that cannot render one of them.
- Rechecks 1 to 20 findings from a completed review after the agent claims a fix, and rejects an unchanged target without spending anything.
- Authorizes every target before it would ever be fetched: HTTPS-only canonicalization (with a narrow plain-http exception for an explicitly named loopback dev host), an ownership-verified host allowlist, and full IP-range egress classification with DNS-rebind rejection.
- Carries the Streamable HTTP edge for the same tools: OAuth 2.1 resource-server auth, per-client transport isolation, and a Postgres application plane. The suite exercises that edge end to end over real HTTP and, with `MCP_TEST_DATABASE_URL`, real Postgres.

## What it deliberately does not do

- **It never edits code.** No patching, committing, pushing, opening pull requests, or driving a browser. It returns judgments and evidence; the agent on the other end does the work. The server is the eyes, the agent is the hands.
- **It does not screenshot anything itself and it does not call a model itself.** Capture and inference sit behind the engine boundary, in the public sibling [apatureai/verdict](https://github.com/apatureai/verdict): it drives headless Chromium for real captures and calls an OpenAI-compatible endpoint configured with `MODEL_BASE_URL` / `MODEL_API_KEY`. This server now runs that engine when you configure it and consumes its result; it does not reimplement either half. See [Getting real judgments](../README.md#getting-real-judgments).
- **It does not judge the URL you pass until you configure a backend.** With nothing set, the findings come from a golden fixture describing a fictional pricing page, and every entry point says so before it prints them.

## Why this is technically interesting

Most MCP servers are thin wrappers: one tool call maps to one function call, returns in milliseconds, and trusts its arguments. A design reviewer breaks all three assumptions, and most of the interesting code is the consequence.

**Long work behind a short-timeout protocol.** Browser capture across several routes and viewports plus multimodal inference routinely takes minutes. MCP clients do not wait that long (Codex documents a 60-second default tool timeout) and Streamable HTTP sessions drop. So the tool surface is a submit-and-poll job API rather than a blocking call. Job state lives in Postgres, keyed by tenant, entirely independent of the MCP session: a client can disconnect, reconnect against a different replica, and recover its job by id. Tool calls are idempotent on a caller-supplied `client_request_id`, enforced by a `(tenant_id, client_request_id)` unique constraint, so a retried submit after a dropped connection returns the original job (`reused: true`) instead of billing a second review. Reusing that key with different arguments is an explicit `IDEMPOTENCY_CONFLICT`, never a silent overwrite.

**"Fetch this URL for me" is an SSRF primitive.** A tool that accepts a URL from an agent and loads it server-side is a confused deputy. `target-auth.ts` and `egress.ts` are the defense, in layers: the URL is canonicalized (HTTPS only — the sole exception, and only on the **local stdio server** that runs on the agent's own machine, being plain http to an explicitly named loopback dev host, `localhost`/`127.0.0.0/8`/`::1`; the production hosted edge never grants it, since there loopback is the shared capture host's own interface — no userinfo, no fragment, IDNA-normalized host, default port dropped, raw IP literals rejected outside loopback); the host must appear in the tenant's ownership-verified registry (a named loopback host on the local server is self-owned and skips this check, but a public name that resolves to loopback does not and is caught by the denylist below), so a valid token cannot capture a host the tenant does not own; every address the host resolves to is classified against a denylist (loopback, RFC 1918, link-local, the `169.254.169.254` cloud-metadata address, multicast, reserved, NAT64-embedded IPv4, 6to4, CGNAT); and a mixed answer set (some public, some private) is rejected as a DNS-rebind attempt rather than partially allowed. Failures collapse to a single `DNS_TARGET_PROHIBITED` code, so the response never tells the caller which internal address resolved. `egress.ts` is pure and dependency-free by design: it never touches the network, it only classifies addresses a resolver already produced, which makes it exhaustively testable.

**Page content is data, never instruction.** The server reads a preview an attacker may control. Nothing captured from the page becomes server instructions, a tool description, an authorization decision, or a new tool call. In the review panel every page-derived string is HTML-escaped and evidence is embedded as a `data:` URI, so the panel fetches nothing.

**Per-client protocol isolation.** MCP SDK server and transport instances are mutable and are never shared across clients or tenants. Each connection gets its own short-lived adapter pair over one shared, protocol-neutral application store, so a transport-layer bug cannot leak state between tenants. The HTTP edge enforces its own limits before the SDK sees a request: declared and streamed body size, body-read timeout, media type, and in-flight requests per principal, each with a distinct counted rejection reason.

**Cancellation that cannot be raced.** A review job has two identities: the MCP-facing product job id and the engine's own job id. The application record stores both, and cancel/poll calls use the engine id. Completion and cancellation share a single store transaction as their linearization point, so a result arriving after a cancellation wins cannot overwrite it.

**Migrations that survive concurrent replicas.** Every boot opens one transaction, takes a product-scoped Postgres advisory lock, and only then reads migration state; the lock, the pending DDL, and the tracking inserts all share that transaction, so racing replicas serialize and a killed runner rolls back cleanly. Applied migrations are pinned by SHA-256: historical files are immutable after first adoption, and a mismatch fails startup. An older image tolerates an unknown newer checksum-pinned id, which is what makes rolling rollback safe. Tables are tenant-keyed with RLS; the adapter binds `app.tenant_id` inside every transaction and the role must not hold `BYPASSRLS`.

**Multimodal results with an honest downgrade.** A design review's most useful output is a picture. `multimedia-content.ts` shapes a critique into ordered MCP content blocks: the interactive panel first where the host supports MCP-Apps, then per-finding text, then annotated crops as image blocks. A host that cannot render images gets the identical text and structured findings plus an explicit `images_withheld` list of the evidence it is not seeing, never a broken block and never a silent drop. Image blocks are only emitted for evidence that actually exists with a real `image/*` MIME type; evidence is never fabricated to fill a slot.

**One published contract, served verbatim.** `tools/list` advertises `schemas/mcp-tools.json` itself: the catalog's own `inputSchema` and `outputSchema` per tool, read from that file and handed to the client unchanged. Previously the SDK derived a laxer input schema from the Zod shapes and advertised no output schema at all, so there were two published contracts and a client could not validate structured content for itself. Now the Zod shapes are only what the server *parses*, the catalog is only what a client is *told*, and `schema-conformance.test.ts` drives real calls through both and fails if they disagree. A test also performs a `tools/list` against a real server instance over an in-process transport and compares it to the catalog and to the `directory/server.json` registry listing, failing the build if any of the three disagree — including the catalog version, held identical across `schemas/mcp-tools.json`, the listing's `_meta.ai.apature/catalog_version`, and the server handshake. (The listing's *top-level* `version` is the release version, verified separately against the package version.)

## Versioning: two numbers, on purpose

This repository carries two independent version numbers, and they do not, and are not meant to,
agree. Seeing them differ is not a bug.

| | Release version | Catalog version |
|---|---|---|
| Value today | `0.1.2` | `1.3.0` |
| Where it lives | `package.json` (both packages), the git tag, the GitHub release, [`CHANGELOG.md`](../CHANGELOG.md), and the `directory/server.json` **top-level** `version` (what the MCP Registry pins to the npm artifact) | `schemas/mcp-tools.json`, `directory/server.json` `_meta.ai.apature/catalog_version`, and the MCP handshake (`serverInfo.version`) |
| Where you see it | `npm install`, the release page, the changelog | `connected to apature-mcp-review v1.3.0` when a client connects |
| What it tracks | this codebase as a shipped artifact: what you pin, clone, and cite | the agent-facing MCP contract: the tool surface, its input and output schemas, and the protocol baseline |
| When it moves | when a release is cut | when the published tool contract changes |

The **catalog version** is deliberately held identical across `schemas/mcp-tools.json`,
`directory/server.json`'s `_meta.ai.apature/catalog_version`, and the server's `serverInfo`, and the
`catalog-drift` test (`packages/mcp-server/test/catalog-drift.test.ts`) fails the build if the three
ever drift apart. (Before the registry listing carried a `packages` entry, the listing's top-level
`version` held the catalog version too; it now holds the release version so the MCP Registry can pin
the listing to the published npm package, and that field is checked against the package version
instead.) The catalog version
is the number a coding agent negotiates against, so it belongs to the contract, not to the release
calendar: the tool surface reached `1.x` and settled long before the repository was first tagged for
release at `0.1.0`.

So the mapping an adopter needs is this one: the thing you clone, pin, and read this changelog for is
the **release version**. The `v1.3.0` a client prints on connect is the **catalog version**, and it
maps to the tool contract in `schemas/mcp-tools.json`, not to a changelog entry. If you need to cite
"the version of bastion I ran", cite the release version (the git tag), and note the catalog version
alongside it if the tool surface is what matters.
