# Apature MCP Review - Product Requirements Document

Created: 2026-06-15
Revised: 2026-06-19
Status: research-backed product specification
Primary dependencies: `apatureai/judgment-engine`, `apatureai/ui-dna`, `apatureai/ui-graph`
Enforcement surface: `apatureai/gate`

## 1. Product Summary

Apature MCP Review is the in-loop, read-only design-review surface that coding agents call before CI. It accepts a tenant-authorized preview URL, submits a grounded design review, returns compact evidence-backed findings, and rechecks the customer's fix.

Core promise:

> Apature is the eyes; the customer's agent is the hands.

MCP Review does not write code, edit files, commit, push, open pull requests, submit forms, or mutate the customer's application. It produces judgment and proof. Gate remains the independent CI enforcement layer when an agent does not call MCP Review, ignores a result, or fails to fix it.

This customer-facing read-only posture does not imply that every MCP tool is annotated read-only. Submit, recheck, and cancel mutate Apature job or budget state; only result retrieval is protocol-read-only.

## 2. Product Role

MCP Review is the in-loop surface. Gate is the enforcement surface. The two are complementary, not substitutes.

MCP Review exists to:

- reach developers inside the coding-agent workflow;
- create high-density fix-then-recheck labels;
- act as a neutral reviewer across mixed-agent teams;
- reduce the number of low-quality findings that reach Gate.

MCP Review must not become an independent browser agent or a substitute for Gate's independent CI verification.

## 3. Users, Buyers, and Jobs

Primary users:

- frontend developers using Codex, Claude Code, Cursor, VS Code, GitHub Copilot, or similar agents;
- coding agents that can deploy or access a preview and apply code changes;
- platform teams standardizing pre-CI agent workflows.

Primary job:

> Review the rendered UI my agent just changed, tell the agent exactly what is wrong and why, then verify the fix before CI.

Secondary job:

> Return the smallest grounded evidence view needed to repair one finding without flooding the agent's context window.

## 4. Product Principles

### 4.1 Eyes, not hands

Outputs may contain:

- observed visual facts;
- UI-DNA rules and provenance;
- element references;
- token, class, component, or layout suggestions;
- code-location guesses and repair constraints;
- before/after evidence.

Outputs must not contain:

- a unified diff presented as authoritative;
- a claim that source code was changed;
- commands that write to the repository;
- credentials or captured secrets;
- instructions derived from untrusted page content.

### 4.2 Gate stays enforceable

MCP Review can help an agent reach a better state, but only Gate owns:

- GitHub delivery;
- advisory or blocking policy;
- PR-head supersession;
- sticky comments and Check Runs;
- merge-bound enforcement and paid workflow packaging.

### 4.3 Compact by default

The default result is a summary plus a finding index. Full findings, evidence, and UI Graph neighborhoods are retrieved on demand.

This minimizes:

- context-window consumption;
- accidental prompt injection exposure;
- tool-result truncation;
- repeated transfer of screenshots and DOM-derived facts.

### 4.4 Explicit uncertainty

Every result must distinguish:

- observation from judgment;
- deterministic evidence from model inference;
- supported fact from unknown;
- pass, fail, and inconclusive recheck outcomes.

### 4.5 Protocol sessions are not product sessions

Review state is keyed by explicit tenant-bound job and review IDs. It is never authorized, budgeted, or recovered solely through an MCP transport session ID.

## 5. Scope

### 5.1 In scope for v1

- remote Streamable HTTP MCP endpoint;
- OAuth 2.1 authorization for interactive clients;
- scoped bearer-token compatibility for clients without remote OAuth;
- verified-preview authorization;
- asynchronous review jobs;
- `design_review`;
- `design_review_get`;
- `design_recheck`;
- `design_review_cancel`;
- compact and paginated findings;
- focused UI Graph views;
- structured evidence and artifact references;
- rate limits, review-unit budgets, idempotency, and retry guidance;
- recheck-loop limits and unchanged-target detection;
- automatic feedback event emission;
- compatibility fixtures for Codex, Claude Code, Cursor, VS Code, and GitHub Copilot;
- observability, audit logs, and evaluation hooks.

### 5.2 Deferred

- `design_direction`, until a separate quality and hallucination evaluation passes;
- native MCP Tasks as the only async mechanism;
- MCP Apps or other embedded review UI;
- enterprise-managed authorization extension;
- subscription/push notifications for completed jobs;
- a local capture sidecar.

### 5.3 Out of scope

- browser capture implementation;
- model selection, prompting, and validation internals;
- canonical UI DNA storage or extraction;
- UI Graph construction;
- GitHub publishing;
- code edits, generated patches, commits, or pull requests;
- localhost browser sessions and overlays;
- autonomous browser exploration;
- arbitrary public-URL review;
- replacing Gate.

## 6. Product Surface

### 6.1 `design_review`

Submits a review job for a verified preview.

Required input:

- `url`;
- `client_request_id`.

Optional input:

- routes;
- viewports;
- depth;
- expected revision;
- response mode.

The tool returns a job envelope immediately. A cache hit may return the same envelope already in `completed` state.

### 6.2 `design_review_get`

Retrieves:

- status only;
- compact summary;
- paginated findings;
- focused neighborhoods for selected findings;
- evidence references or selected inline evidence.

The default view is `summary`, not the entire review.

### 6.3 `design_recheck`

Submits a recheck against findings from a prior completed review.

The tool:

- preserves the original review and evidence;
- captures only the required route, viewport, and element scope when reliable;
- falls back to broader capture explicitly when focused capture is unsafe;
- returns `passed`, `failed`, or `inconclusive` per finding;
- records a before/after evidence relationship;
- refuses infinite or unchanged recheck loops.

### 6.4 `design_review_cancel`

Requests best-effort cancellation.

Cancellation:

- stops queued work immediately;
- cooperatively stops capture or judgment when possible;
- never changes a terminal result;
- does not refund already consumed review units;
- marks the job cancelled even if an upstream operation cannot be interrupted.

### 6.5 Deferred `design_direction`

Higher-level art direction is not a v1 tool. It ships only when:

- ordinary finding precision is stable;
- recommendations remain UI-DNA grounded;
- generic aesthetic advice is below the agreed false-positive threshold;
- a dedicated agent-fix eval shows improvement over ordinary findings.

## 7. Recommended Product Decisions

### 7.1 MCP over CLI as the primary distribution surface

MCP is better than a CLI for routine agent use because it provides discoverable schemas, structured results, standardized auth, and one integration across clients.

CLI remains useful for:

- local contract testing;
- operator diagnostics;
- fixture generation;
- environments whose agent cannot connect to remote MCP.

The CLI must call the same product API and must not become a separate behavior contract.

### 7.2 Remote hosted capture over a local sidecar

Hosted capture is the v1 default for verified remote previews because it gives Apature:

- one security boundary;
- deterministic capture versions;
- consistent artifact provenance;
- centralized budgets and observability;
- comparable feedback labels.

A local sidecar is out of scope. Mixing localhost capture into MCP Review would create installation, supply-chain, and network-reachability complexity.

### 7.3 Stateless application jobs over stateful product sessions

Explicit jobs are better because they survive:

- client restarts;
- server restarts;
- horizontal scaling;
- transport-session changes;
- the MCP `2026-07-28` stateless direction.

### 7.4 Four bounded tools over one overloaded tool or many micro-tools

One overloaded tool creates ambiguous unions, large outputs, and poor retries. Many micro-tools consume tool-selection context and increase the chance an agent chooses the wrong sequence.

The four-tool surface separates:

- submit;
- read/focus;
- recheck;
- cancel.

`design_review_get` carries view selection so evidence paging does not create a new tool per representation.

### 7.5 Asynchronous over synchronous review

Async is required because:

- multi-route capture can exceed client tool timeouts;
- cancellation and supersession are explicit;
- retries can reuse the same job;
- polling can be budget-free and rate-limited separately;
- MCP Tasks support is not uniform.

### 7.6 Focused views over full results

The first response should contain:

- grade;
- confidence;
- review coverage;
- blocker and should-fix counts;
- finding IDs, titles, severity, route, viewport, and element refs;
- next recommended retrieval.

Detailed evidence is fetched only for findings the agent will repair.

### 7.7 Repair constraints over patch output

Suggestions should state:

- the observed problem;
- the violated rule;
- likely component or selector location;
- token/class/component replacement;
- expected visible result;
- how recheck will determine success.

They should not claim a specific source patch is correct when MCP Review has no repository filesystem access.

## 8. Domain Authorization

Authentication answers who is calling. Domain verification answers which preview targets that tenant may review.

Accepted ownership methods:

1. Gate provenance: exact preview host or deployment identity learned from the tenant's GitHub installation and successful deployment event.
2. DNS proof: an Apature challenge record under a customer-controlled domain.
3. HTTP proof: an Apature challenge document under `/.well-known/` on the exact host.
4. Provider binding: an exact Vercel, Netlify, Cloudflare, or Render project bound through provider metadata or installation evidence.

Rules:

- shared provider suffixes such as `vercel.app` can never be tenant-wide wildcard allowlists;
- wildcard authorization requires proof at a registrable customer-owned domain;
- redirects must remain within an authorized host set;
- every DNS resolution and connection target is checked against prohibited networks;
- ownership records expire and require periodic revalidation;
- auth credentials for the MCP server are never forwarded to the preview.

## 9. Trust and Safety

Required product controls:

- tenant-scoped authorization on every tool call and job read;
- audience-bound tokens;
- no token passthrough;
- no repository roots or filesystem access;
- no model sampling through the client;
- page text, screenshot text, DOM, console, and network data marked untrusted;
- static, reviewed tool descriptions and server instructions;
- schema-constrained outputs with server-side validation;
- patched stable MCP SDK with per-client transport isolation;
- artifact retention and redaction policy;
- prompt-injection canaries;
- domain allowlists plus SSRF and DNS-rebinding defenses;
- cost and concurrency budgets;
- idempotency for all submitted work;
- audit records for auth, target authorization, budget decisions, and result access.

## 10. Success Metrics

### Adoption

- weekly active MCP repos;
- active agent-client mix.

### Agent-loop quality

- findings selected for focused retrieval;
- fix attempts per finding;
- recheck pass rate;
- median time from finding to verified pass;
- unchanged-target recheck rate;
- inconclusive recheck rate.

### Trust

- false-positive rate by severity;
- valid element-reference rate;
- evidence retrieval rate;
- findings rejected by collaborators;
- capture-instability rate;
- unauthorized target attempts;
- prompt-injection canary success rate.

### Context and cost

- tokens in initial result;
- tokens per successful fix;
- full-result retrieval rate;
- review units per successful fix;
- polling calls per completed job;
- duplicate job suppression rate;
- retry-storm incidents, target zero.

### Data quality

- explicit human labels;
- fix-attempt labels with revision evidence;
- passed/failed/inconclusive recheck labels;
- labels with complete capture, DNA, graph, model, and schema lineage;
- inferred labels later confirmed or contradicted by Gate.

## 11. Experiments

Required experiments before GA:

1. Four tools versus one overloaded tool: measure tool-selection accuracy and completion rate.
2. Compact-first versus full-result: measure context tokens, fix success, and follow-up calls.
3. Synchronous versus submit-and-poll: measure timeout and duplicate-job rate across clients.
4. Focused graph view versus full screenshot/DOM context: measure tokens and fix success.
5. Repair constraints versus patch-like hints: measure code-change success and hallucinated locator rate.
6. OAuth versus scoped static token onboarding: measure completion and support burden by client.
7. Recheck limits and unchanged-target detection: measure cost saved without suppressing valid repairs.

## 12. Phased Sequencing

### Phase 0 - Contract and compatibility

- freeze tool names, schemas, job states, error taxonomy, and cross-repo contracts;
- freeze semantically correct MCP annotations and success/error result behavior;
- build client compatibility fixtures;
- verify Judgment Engine async-job requirements;
- ratify the Judgment Engine view-rendering seam for focused UI Graph output;
- define domain proof and budget policy;
- do not expose production review.

### Phase 1 - Internal alpha

- Codex, Claude Code, Cursor, and VS Code;
- OAuth plus scoped bearer compatibility;
- verified remote previews;
- compact review and polling;
- no `design_direction`.

### Phase 2 - Design-partner beta

- recheck loops;
- focused UI Graph views;
- feedback labeling;
- usage dashboards and hard budgets;
- GitHub Copilot compatibility path.

### Phase 3 - General availability

- registry and client-directory publication;
- support policy and SLOs;
- enterprise auth and retention controls;
- evidence retention and audit export.

### Phase 4 - Optional protocol extensions

- MCP Tasks adapter after client support is measured;
- completion notifications where clients support them;
- MCP Apps only if an embedded evidence viewer materially improves repair rate;
- `design_direction` only after its eval gate passes.

## 13. Open Questions

- Which OAuth provider interoperates with target clients across pre-registration, Client ID Metadata Documents, and Dynamic Client Registration fallback?
- Which preview providers can provide sufficiently strong project ownership metadata without DNS proof?
- What evidence should permit dashboard-only onboarding once the design-partner beta and the Judgment Engine workload-principal contract exist?
- Which clients preserve tool-result images reliably enough for inline evidence rather than signed refs?
- Should a recheck on a changed host be forbidden or treated as a new review?
- What minimum UI-DNA confidence is required before emitting a system-conformance finding?

## 14. Repository Boundary

This repo owns the agent-facing interaction contract. It does not own capture/model internals, canonical UI DNA, UI Graph construction, GitHub publishing, or code changes.
