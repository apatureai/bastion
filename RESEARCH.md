# Apature MCP Review - Research Memo

Created: 2026-06-18
Revised: 2026-06-19
Research cutoff: 2026-06-19
Status: primary-source synthesis for product and architecture decisions

## 1. Research Question

What should Apature expose to coding agents before CI, and how should that surface remain interoperable, secure, economical, and subordinate to Gate?

Conclusion:

Build a remote MCP surface over explicit asynchronous review jobs. Keep four tools, compact results, verified targets, OAuth-first auth, scoped bearer-token compatibility, and server-enforced budgets. Treat MCP transport sessions and optional extensions as adapters, not product state.

The differentiated product is not the protocol. It is the loop:

1. verified rendered preview;
2. repo-specific UI DNA;
3. grounded evidence and element references;
4. the customer's agent applies a fix;
5. Apature rechecks;
6. Gate independently enforces the shipping boundary.

## 2. Current MCP Baseline

### 2.1 Final specification versus release candidate

As of June 19, 2026, the latest final MCP specification is [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25).

The MCP project published a [`2026-07-28` release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) on May 21, 2026. Its final publication is scheduled for July 28, 2026. It contains breaking transport and lifecycle changes, including a stateless core and Tasks as an extension.

Implication:

- target `2025-11-25` for initial compatibility;
- do not bind business state to `MCP-Session-Id`;
- isolate transport/lifecycle code;
- track the release candidate, but do not claim final support before final SDK and client conformance.

### 2.2 Transport

The final specification supports stdio and Streamable HTTP. Streamable HTTP can assign a transport session and can resume SSE streams with event IDs. See the final [transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

The official TypeScript server guide recommends:

- Streamable HTTP for remote servers;
- stdio for local integrations.

Source: [official TypeScript SDK v1 server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md).

Recommendation:

- production: remote Streamable HTTP;
- internal testing: optional stdio adapter over the same application service;
- no legacy SSE-only product contract.

### 2.3 Structured output

MCP tools can declare `outputSchema`, and servers must return conforming `structuredContent` when they do. For compatibility, structured output should also be serialized into a text content block.

Source: [MCP tool result and output schema specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Implication:

- every Apature tool has an input and output schema;
- the text block is a concise rendering, not a second divergent contract;
- schema version is included in every result;
- evidence is referenced and paginated instead of embedded by default.
- successful `structuredContent` conforms to the tool's `outputSchema`;
- expected tool-execution errors use `isError: true` and a separately versioned error schema rather than violating a success-only output schema.

### 2.4 Tool annotations and metered side effects

MCP defines `readOnlyHint` as a claim that a tool does not modify its environment. Creating a review job, reserving allowance, submitting a recheck, and cancelling work all modify Apature service state even though they never modify customer code or application state.

Source: [MCP ToolAnnotations schema reference](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).

Recommendation:

- `design_review`: `readOnlyHint: false`, `destructiveHint: false`, idempotent with `client_request_id`;
- `design_review_get`: `readOnlyHint: true`;
- `design_recheck`: `readOnlyHint: false`, `destructiveHint: false`, idempotent with `client_request_id`;
- `design_review_cancel`: `readOnlyHint: false`, `destructiveHint: true`, idempotent;
- all four declare Tasks forbidden until a measured Tasks adapter ships.

This distinction matters because some hosts use annotations in approval policy. Hard server-side budgets remain mandatory because annotations are untrusted hints and GitHub Copilot cloud workflows can call configured tools without per-call approval.

### 2.5 Progress, cancellation, and Tasks

The final specification supports optional progress notifications and request cancellation:

- progress tokens are caller-provided and unique among active requests;
- progress values increase monotonically;
- implementations should rate-limit progress notifications;
- non-task cancellation uses `notifications/cancelled`;
- task cancellation uses `tasks/cancel`.

Sources:

- [Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [Schema and cancellation](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- [Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

The `2026-07-28` release candidate moves long-running Tasks into an extension. Client support is therefore not a safe v1 assumption.

Recommendation:

- canonical async mechanism: Apature job IDs;
- optional progress during short submit/get calls;
- optional Tasks adapter only after measured client support;
- cancellation always maps to an application job.

### 2.6 Authorization

The final MCP authorization specification for HTTP is based on OAuth 2.1 behavior and related standards. It requires:

- Protected Resource Metadata;
- authorization-server discovery through OAuth or OpenID Connect metadata;
- support for pre-registration, Client ID Metadata Documents, or Dynamic Client Registration according to advertised capabilities;
- PKCE;
- the OAuth `resource` parameter;
- validation that access tokens were issued for the MCP resource;
- `401` scope guidance and `403 insufficient_scope` challenges for step-up authorization;
- no token passthrough.

Sources:

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [RFC 9728: OAuth Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [RFC 8707: OAuth Resource Indicators](https://datatracker.ietf.org/doc/html/rfc8707)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

Recommendation:

- OAuth is the primary remote auth path;
- tenant identity comes from the token, never tool arguments;
- access tokens are audience-bound to the canonical MCP resource URI;
- the authorization provider should support pre-registered clients first, Client ID Metadata Documents when advertised, and Dynamic Client Registration as a compatibility fallback;
- the resource server returns `resource_metadata` and minimum required scopes in `WWW-Authenticate`;
- scoped bearer tokens exist only for clients that cannot use remote OAuth;
- bearer tokens are revocable, repository-scoped where possible, and never forwarded to preview hosts.

### 2.7 Release-candidate migration seam

The `2026-07-28` release candidate adds operational requirements beyond simply removing sessions:

- `Mcp-Method` and `Mcp-Name` headers permit routing and must match the JSON-RPC body;
- list responses gain `ttlMs` and `cacheScope`;
- W3C Trace Context has fixed `_meta` keys;
- Tasks becomes an extension with a changed lifecycle;
- clients validate authorization-response `iss`, and registrations bind to the authorization-server issuer;
- tool schemas gain explicit full JSON Schema 2020-12 support.

Source: [MCP `2026-07-28` release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).

Recommendation:

- do not emit release-candidate-only headers or semantics under a `2025-11-25` negotiation;
- keep one protocol adapter around the application service;
- keep the tool catalog tenant-independent and release-versioned so a future `tools/list` response can be safely cached;
- propagate trace context internally now without making RC `_meta` keys part of the final-spec contract;
- retain object-shaped tool inputs and outputs for older-client compatibility even after full JSON Schema support arrives;
- require a separate conformance gate before enabling the new protocol version.

## 3. Official SDK State

The official TypeScript SDK repository is the correct implementation reference: [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).

Observed on June 19, 2026:

- `@modelcontextprotocol/sdk` latest stable: `1.29.0`;
- split v2 packages such as `@modelcontextprotocol/server`: `2.0.0-alpha.2`;
- v2 remains prerelease.

The official SDK repository also published three high-severity advisories affecting the v1 line:

- [GHSA-w48q-cv73-mx4w](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w): localhost DNS-rebinding protection, fixed in `1.24.0`;
- [GHSA-cqwc-fm46-7fff](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-cqwc-fm46-7fff): URI-template ReDoS, fixed in `1.25.2`;
- [GHSA-345p-7cg4-v4c7](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7): cross-client response leakage when server or transport instances are shared, fixed in `1.26.0`.

Recommendation:

- do not start implementation on an alpha SDK;
- use `@modelcontextprotocol/sdk >=1.26.0`, with the current stable release preferred at implementation time;
- instantiate and bind SDK server/transport state per client connection or request as required by the selected transport; never share a mutable server/transport instance across tenants;
- design contracts independent of SDK classes;
- use JSON Schema fixtures as the durable source of truth;
- use the `v1.x` branch and v1 API documentation during implementation, not examples from `main`, which targets v2;
- pin dependencies with a lockfile, scan advisories in CI, and test cross-tenant concurrent traffic;
- reassess the v2 SDK after the `2026-07-28` final specification and client validation window.

## 4. Client Compatibility Matrix

Client behavior changes faster than the protocol. This matrix records official documentation as of June 19, 2026 and should be rerun before beta and GA.

| Client | Remote transport | Auth | Relevant output/capability behavior | MCP Review implication |
|---|---|---|---|---|
| Codex CLI / IDE | Streamable HTTP and stdio | Bearer token and OAuth | Reads server instructions; configurable tool timeout defaults to 60 seconds; supports per-server tool approval policy and enterprise MCP allowlists | Async submit/poll is mandatory; put critical workflow and rate-limit guidance early in server instructions; publish stable server identity and tool names |
| Claude Code | HTTP recommended, stdio, legacy SSE | OAuth, static headers, preconfigured OAuth clients | Supports resources, prompts, elicitation, dynamic tool changes; warns above 10k tokens and defaults to a 25k MCP output limit; Tool Search defers definitions | Keep descriptions concise; compact/paginated results; resources may enhance evidence but cannot be required |
| Cursor | Streamable HTTP, SSE, stdio | OAuth, headers, static OAuth client credentials | Supports tools, prompts, resources, roots, elicitation, MCP Apps, and returned images; approval can be bypassed by configured run modes | Base contract can use tools and images, but metered calls need correct annotations and hard budgets |
| VS Code / Copilot Chat | Streamable HTTP, stdio, legacy SSE | OAuth | Documents full MCP support including tools, prompts, resources, elicitation, sampling, roots, server instructions, and Apps | Strongest optional-feature test client; still keep core contract tool-only compatible |
| GitHub Copilot cloud agent / code review | HTTP/SSE/local MCP configuration | Secrets/headers; remote OAuth not supported | Tools only; resources and prompts unsupported; configured tools can run autonomously without approval | Must support scoped bearer headers, expose all required data through tool results, and enforce hard server budgets |

Official sources:

- [Codex MCP manual](https://developers.openai.com/codex/mcp)
- [Claude Code MCP reference](https://code.claude.com/docs/en/mcp)
- [Cursor MCP documentation](https://cursor.com/docs/mcp)
- [VS Code MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [GitHub Copilot repository MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)

Compatibility conclusion:

- tools are the only universal capability;
- Streamable HTTP is the common remote transport;
- OAuth is common but not universal;
- MCP Tasks, resources, Apps, prompts, and push behavior must be progressive enhancements;
- no client should need to retain a transport session to recover a review.

## 5. Alternatives

### 5.1 MCP versus CLI versus direct HTTP versus local sidecar

| Option | Strength | Weakness | Decision |
|---|---|---|---|
| MCP | Shared agent integration, schemas, auth discovery, structured results | Client differences and evolving spec | Primary distribution surface |
| CLI | Simple debugging, works in shell-first environments | Agents parse text; auth/config duplicated; weaker discovery | Diagnostic and fallback adapter only |
| Direct HTTP API | Best service-to-service primitive and operational control | Every agent vendor needs custom integration | Internal application/engine seam, not primary user surface |
| Local sidecar | Can reach localhost and keep pixels local | Installation and supply-chain risk; fragmented capture versions; overlaps Pointer | Defer to Pointer |

Why MCP is better than CLI for this product:

- the agent can select a documented tool rather than infer shell syntax;
- schemas survive model and client changes better than prose output;
- OAuth and remote server discovery are standardized;
- tool results can carry images and resource links;
- one server reaches multiple coding agents.

Why HTTP still matters:

- MCP is the distribution layer, not the internal domain model;
- the job service, Judgment Engine, and Gate need stable non-MCP contracts;
- transport adapters should not leak MCP session semantics into core jobs.

### 5.2 Stateful sessions versus stateless jobs

Stateful sessions are useful for live browser interaction, which belongs to Pointer. They are a poor fit for remote review:

- sessions are lost when clients restart;
- the final MCP specification's session behavior is changing toward statelessness;
- session affinity complicates horizontal scaling;
- session IDs are not identity or authorization.

Explicit jobs are better because they are durable, tenant-bound, idempotent, auditable, and transport-neutral.

Decision: stateless application jobs.

### 5.3 One review tool versus composable tools

One tool such as `design_review(url, wait=true, view=full, recheck=...)` reduces tool count but creates:

- large conditional schemas;
- ambiguous retry behavior;
- synchronous timeout pressure;
- mixed create/read/cancel semantics;
- more opportunities for an agent to request excessive output.

Many fine-grained tools create:

- larger tool-definition context;
- tool-selection mistakes;
- client approval fatigue;
- brittle workflows.

Decision: four tools with one read/view tool:

- submit review;
- read status/result/focus;
- submit recheck;
- cancel.

### 5.4 Synchronous versus asynchronous

Synchronous review is attractive for a one-call demo, but conflicts with capture latency, client timeouts, cancellation, and retries.

Decision: asynchronous by contract. Cache hits may complete immediately but preserve the same job envelope.

### 5.5 Full findings versus focused graph views

Full findings maximize one-shot information but waste context when the agent repairs one or two issues. Claude Code explicitly documents output thresholds, and Codex defaults to a 60-second tool timeout. Tool outputs are also an indirect prompt-injection channel.

Decision:

- compact summary and finding index first;
- paginated findings second;
- UI Graph `focus` plus `patchContext` views for selected findings;
- evidence refs by default;
- inline images only on explicit request and within client-tested limits.

### 5.6 Local capture versus hosted capture

Local capture preserves privacy and reaches localhost, but it creates divergent capture environments and overlaps Pointer's live-session product.

Hosted capture provides deterministic versions and one security boundary, but requires verified remote previews and artifact controls.

Decision:

- hosted capture for MCP Review v1;
- enterprise can route to in-VPC Judgment Engine;
- localhost and local sidecar belong to Pointer.

### 5.7 Suggestions versus patch hints

The agent wants code-repair guidance. MCP Review lacks repository filesystem access, so exact patches are often false precision.

Decision:

- return `repair_hint`, not a patch;
- include token/class/component direction, likely locator, expected result, and verification rule;
- label locator confidence;
- let the customer's agent inspect code and produce the diff.

### 5.8 Per-call versus subscription pricing

Per-call:

- aligns revenue with COGS;
- discourages beneficial rechecks;
- creates unpredictable spend in agent loops.

Unlimited subscription:

- improves adoption;
- hides marginal cost;
- invites runaway loops.

Decision:

- Gate subscription with included review units;
- explicit hard budgets;
- opt-in metered overage;
- usage quote and remaining allowance in every create response.

## 6. URL Ownership and SSRF

The capture engine is a browser operating on attacker-influenced URLs. Authentication alone is insufficient.

The ACME standard demonstrates two established domain-control patterns:

- HTTP challenge under a known path;
- DNS challenge through a TXT record.

Source: [RFC 8555](https://datatracker.ietf.org/doc/html/rfc8555).

The MCP Registry independently uses GitHub namespace proof, DNS proof, and HTTP `/.well-known/` proof to authenticate publishers:

- [Registry trust model](https://modelcontextprotocol.io/registry/about)
- [Registry authentication](https://modelcontextprotocol.io/registry/authentication)

Recommended target-authorization order:

1. exact deployment provenance from Gate/GitHub installation;
2. provider project binding;
3. DNS challenge for a registrable customer domain;
4. HTTP challenge for an exact host.

OWASP recommends positive destination allowlists, scheme and port restrictions, redirect controls, and defenses against DNS rebinding and time-of-check/time-of-use races:

- [OWASP SSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP SSRF Top 10 guidance](https://owasp.org/Top10/2021/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/)

Apature must combine ownership proof with network-layer denial of internal, loopback, link-local, metadata, multicast, and otherwise prohibited destinations. Verification is not a substitute for safe connection handling.

## 7. Retry Storms, Idempotency, and Recheck Loops

Retries can amplify an overloaded dependency. AWS and Google recommend capped exponential backoff with jitter and retry limits:

- [AWS Builders' Library: timeouts, retries, backoff, and jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Google SRE: addressing cascading failures](https://sre.google/sre-book/addressing-cascading-failures/)

HTTP defines `Retry-After` for temporary unavailability, and HTTP 429 represents rate limiting:

- [RFC 9110 Retry-After](https://datatracker.ietf.org/doc/html/rfc9110#section-10.2.3)
- [RFC 6585 429 Too Many Requests](https://httpwg.org/specs/rfc6585.html#status.429)

Idempotency keys are an established pattern for making retries return the prior result instead of repeating work:

- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)

Recommended controls:

- require `client_request_id` on create/recheck;
- return the existing job for duplicate tenant/tool/request IDs;
- quote and reserve review units atomically before enqueue;
- one active job per review-chain target;
- one billable retry owner in the stack;
- poll floors and server-provided `poll_after_ms`;
- full jitter on 429/503 retries;
- unchanged-target fingerprint detection;
- per-finding and per-review-chain recheck ceilings;
- no automatic retry for auth, verification, schema, or budget errors.

## 8. Context-Window Economics

Agent context is a product resource.

Relevant client behavior:

- Claude Code warns above 10,000 MCP output tokens and defaults to a 25,000-token maximum;
- Claude Code's Tool Search defers tool definitions and truncates long descriptions/instructions;
- Codex asks server authors to put the critical part of server instructions in the first 512 characters;
- Cursor and other clients can attach returned images, but image handling depends on the selected model.

Sources:

- [Claude Code MCP output and Tool Search guidance](https://code.claude.com/docs/en/mcp)
- [Codex MCP guidance](https://developers.openai.com/codex/mcp)
- [Cursor image-result guidance](https://cursor.com/docs/mcp)

Implication:

- tool names and descriptions stay stable and concise;
- the server instruction begins with when to call, async flow, no-write boundary, and rate-limit behavior;
- initial results should be well below 2,000 text tokens for normal reviews;
- full finding pages should default to at most 20 items;
- focused views should default to fewer than 30 graph nodes, matching UI Graph's current target;
- images are fetched only for selected evidence.

## 9. Agent Trust, Tool Poisoning, and Prompt Injection

MCP itself requires clients to treat tool annotations as untrusted unless they come from trusted servers. The official security guidance covers token passthrough, SSRF, session hijacking, and local server compromise.

Sources:

- [MCP tools security language](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

Recent primary research finds that MCP-specific attacks occur throughout tool discovery, selection, invocation, and response handling:

- [MCP Security Bench, ICLR 2026](https://openreview.net/forum?id=irxxkFMrry) evaluates name collisions, tool-description injection, out-of-scope parameters, false errors, retrieval injection, and mixed attacks.
- [Model Context Protocol Threat Modeling and Tool Poisoning](https://arxiv.org/abs/2603.22489) reports tool poisoning as a high-impact client-side risk across tested clients.
- [MCP at First Glance](https://arxiv.org/abs/2506.13538) studies security and maintainability issues across open-source MCP servers.

MCP Review has two separate untrusted-content planes:

1. server metadata: tool descriptions and server instructions;
2. reviewed target content: DOM text, screenshot text, network/console content, and generated evidence.

Controls:

- tool catalog and server instructions are static build artifacts;
- metadata hash changes require review and release notes;
- no tenant or page content enters tool descriptions;
- page-derived content is explicitly labeled untrusted in structured output;
- page content cannot request other tools, secrets, or client actions;
- result schemas contain findings and evidence, not arbitrary instructions;
- no sampling, roots, repository filesystem, or write tools;
- clients should allowlist only Apature's review tools;
- publish through a verified MCP Registry namespace when GA-ready.

## 10. Feedback Labeling

The data moat requires separating high-quality labels from convenient but ambiguous telemetry.

Recommended label hierarchy:

1. explicit collaborator verdict;
2. recheck with changed target and deterministic evidence;
3. Gate outcome on a later PR head;
4. agent-declared fix attempt;
5. interaction telemetry such as finding retrieval;
6. weak inference such as the element being touched.

Rules:

- no GET/poll event becomes a positive judgment label;
- a recheck is not positive unless the target fingerprint changed;
- `passed`, `failed`, and `inconclusive` remain distinct;
- agent identity, human identity, and inference source are separate fields;
- every label carries review, finding, capture, model, prompt, UI DNA, UI Graph, and schema lineage;
- training exports can filter by label quality and consent.

## 11. Adjacent Products

### Playwright MCP

[Playwright MCP](https://github.com/microsoft/playwright-mcp) validates that coding agents can inspect browsers through structured snapshots and element refs. It is an interaction/perception baseline, not a design judge.

MCP Review should not reproduce browser-control tools. It consumes evidence from Judgment Engine and returns product-specific judgment.

### Source Of Truth

`apatureai/source-of-truth` serves approved UI DNA before generation. MCP Review judges after generation. The tools must remain distinct:

- Source Of Truth answers "what standard should I use?";
- MCP Review answers "does this rendered result meet the standard?";
- Gate answers "may this PR pass the enforced boundary?"

### Pointer

Pointer owns live localhost sessions, overlays, and pointing. MCP Review owns remote request/response review jobs. A local sidecar in MCP Review would collapse this boundary.

## 12. Recommended Choices

| Decision | Recommended choice | Why |
|---|---|---|
| Protocol version | `2025-11-25` final first; track `2026-07-28` RC | Avoid shipping against a breaking prerelease |
| SDK | Current stable TypeScript v1, never below `1.26.0` | v2 remains alpha; older v1 releases have high-severity advisories |
| Transport | Remote Streamable HTTP | Common client support and centralized policy |
| Product state | Explicit stateless jobs | Durable and transport-neutral |
| Async mechanism | Apature jobs; Tasks optional later | Universal client compatibility |
| Tool count | Four | Small but separates create/read/recheck/cancel |
| Result shape | Compact then focused/paginated | Context and injection control |
| Auth | OAuth first, scoped bearer fallback | Secure default plus Copilot compatibility |
| URL authorization | Gate/provider provenance, DNS, HTTP proof | Strong ownership with practical fallbacks |
| Capture | Hosted/in-VPC remote preview | Determinism and boundary clarity |
| Guidance | Repair constraints, not patches | No false claim of source authority |
| Pricing | Gate-included units plus opt-in overage | Predictable adoption and bounded COGS |

## 13. Research Gaps

- Client conformance for MCP Tasks and the `2026-07-28` final release after July 28, 2026.
- Actual inline-image behavior and limits across model choices in each client.
- Dynamic Client Registration and Client ID Metadata compatibility across target clients and the selected authorization provider.
- Provider-specific proof quality for Vercel, Netlify, Cloudflare, and Render previews.
- Measured capture and Qwen3-VL COGS needed to set review-unit allowances.
- Whether client hosts expose stable agent/session identifiers suitable for telemetry without becoming auth inputs.
