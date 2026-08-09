# Apature MCP Review - Architecture Decision Records

Created: 2026-06-18
Revised: 2026-06-19

## ADR-001: MCP is the primary agent distribution surface

Status: accepted

Decision:

Expose review through MCP, backed by a transport-neutral application API.

Why:

- common integration across coding agents;
- discoverable tool schemas;
- structured output and image/resource support;
- standardized remote authentication.

Alternatives:

- CLI only: weaker schemas and duplicated parsing/configuration.
- direct HTTP only: requires vendor-specific agent integration.

Consequences:

- client compatibility testing is a release gate;
- protocol adapters must not define the domain model.

## ADR-002: Remote Streamable HTTP is the production transport

Status: accepted

Decision:

Use remote Streamable HTTP. Keep stdio as an optional local test adapter.

Why:

- common support across target clients;
- OAuth support;
- centralized policy, budgets, and observability;
- no customer installation of capture code.

Rejected:

- SSE-only: legacy and weaker forward path.
- local stdio as product default: cannot reliably serve cloud agents and fragments policy.

## ADR-003: Application jobs are stateless and explicit

Status: accepted

Decision:

Store review state under explicit tenant-bound job/review IDs. Never use MCP transport sessions as product sessions.

Why:

- client and server restart recovery;
- horizontal scaling;
- authorization on every call;
- alignment with the `2026-07-28` stateless direction.

Consequence:

- every follow-up tool call carries a job or review ID;
- shared durable storage is required.

## ADR-004: Application jobs are the canonical async mechanism

Status: accepted

Decision:

Do not require MCP Tasks in v1. Add a Tasks adapter only after broad client support.

Why:

- Tasks support is not universal;
- Tasks move to an extension in the current release candidate;
- application jobs also serve CLI, HTTP, Gate, and recovery workflows.

Rejected:

- blocking tool calls: conflict with client timeouts and capture latency.

## ADR-005: Four tools form the v1 surface

Status: accepted

Decision:

- `design_review`
- `design_review_get`
- `design_recheck`
- `design_review_cancel`

Why:

- separates create/read/recheck/cancel semantics;
- avoids an overloaded union tool;
- avoids micro-tool context and selection overhead.

Deferred:

- `design_direction`;
- explicit feedback tool;
- separate evidence and graph tools.

## ADR-006: Results are compact and progressive

Status: accepted

Decision:

Return summary and finding index first. Retrieve finding pages, focus views, and evidence on demand.

Why:

- context-window economics;
- client output limits;
- lower prompt-injection exposure;
- most repair loops touch few findings.

Consequence:

- agents may make an extra read call;
- polling and reads must be cheap and not billable.

## ADR-007: Repair hints are not patches

Status: accepted

Decision:

Return token/class/component/layout constraints and likely code locators with confidence. Always set `patch_provided: false`.

Why:

- MCP Review has no repository filesystem access;
- exact patches would create false authority;
- the customer's agent is responsible for code inspection and edits.

## ADR-008: Hosted remote capture is the v1 capture mode

Status: accepted

Decision:

Review verified remote previews through hosted or customer in-VPC Judgment Engine.

Why:

- deterministic capture versions;
- centralized security and observability;
- comparable labels.

Rejected:

- MCP Review local sidecar: creates supply-chain/installation complexity and fragments capture environments.

## ADR-009: OAuth first, scoped bearer fallback

Status: accepted

Decision:

Use MCP-conformant OAuth for interactive clients. Support scoped bearer tokens for clients, including GitHub Copilot cloud agent, that do not support remote OAuth.

Why:

- secure and discoverable default;
- practical cross-client compatibility.

Consequence:

- bearer tokens require strong expiration, scoping, hashing, revocation, and audit.

## ADR-010: Domain proof and network safety are separate gates

Status: accepted

Decision:

Require both tenant ownership evidence and safe resolved network destinations.

Why:

- domain control does not prevent DNS rebinding;
- valid auth does not authorize arbitrary URLs;
- shared provider domains need exact project binding.

## ADR-011: Review units are the budget and quota primitive

Status: accepted

Decision:

Use versioned review units for quoting, reservation, and settlement.

Why:

- requests vary by route, viewport, depth, and recheck scope;
- request-count limits do not track cost;
- raw model-token billing is unstable and confusing.

## ADR-012: Withdrawn

Status: withdrawn

This ADR covered commercial packaging and was removed before publication. The
number is left vacant so later ADRs keep their identifiers.

## ADR-013: Tool metadata is static and release-controlled

Status: accepted

Decision:

Tool names, descriptions, annotations, and server instructions are versioned build artifacts with manifest hash monitoring.

Why:

- tool poisoning and rug-pull attacks target metadata;
- dynamic page or tenant content has no legitimate role in tool descriptions.

## ADR-014: No client sampling, roots, or repository access

Status: accepted

Decision:

MCP Review v1 does not request sampling, roots, or repository files from the client.

Why:

- Judgment Engine owns model calls;
- the product does not need repository access to preserve its boundary;
- fewer capabilities reduce trust and injection risk.

## ADR-015: Rechecks require changed-target evidence

Status: accepted

Decision:

Reject unchanged-target rechecks without invoking the judge.

Why:

- prevents accidental infinite loops;
- avoids contaminating feedback labels;
- controls cost.

## ADR-016: Gate remains the only enforceable PR surface

Status: accepted

Decision:

MCP Review never publishes GitHub status or represents a review as merge authorization.

Why:

- independent CI verification is the product boundary;
- in-loop results can be stale or selectively invoked;
- mixed-agent teams require a neutral final gate.

## ADR-017: Customer read-only posture is separate from MCP annotations

Status: accepted

Decision:

Only `design_review_get` uses `readOnlyHint: true`. Submit and recheck use `readOnlyHint: false` because they create metered Apature jobs. Cancel uses `readOnlyHint: false` and `destructiveHint: true` because it terminates work. All remain non-writing with respect to customer code and applications.

Why:

- MCP annotations describe effects on the tool environment, not only the customer's repository;
- accurate hints improve client approval behavior;
- GitHub Copilot and configurable client run modes still require hard server-side budgets.

## ADR-018: UI Graph views are served through Judgment Engine

Status: accepted

Decision:

MCP Review never calls `ui-graph` as a network service. Judgment Engine owns graph orchestration, snapshot storage, artifact authorization, and the application endpoint that renders `summary`, `violations`, `focus`, and `patchContext` views.

Why:

- `ui-graph` is specified as a deterministic package without network or storage credentials;
- direct MCP Review access would duplicate tenant and artifact authorization;
- the engine already owns the capture, graph snapshot, evidence, and retention lineage needed to render a safe view.

## ADR-019: Use a patched stable SDK with isolated transport instances

Status: accepted

Decision:

Use the current stable TypeScript SDK v1 release, never below `@modelcontextprotocol/sdk 1.26.0`. Create mutable SDK server and transport instances per client connection or request as required by the transport, and never share them across tenants.

Why:

- official advisories fixed DNS-rebinding protection in `1.24.0`, URI-template ReDoS in `1.25.2`, and cross-client response leakage in `1.26.0`;
- protocol classes are adapters, not safe multi-tenant application state;
- explicit instance isolation is testable and survives future SDK changes.
