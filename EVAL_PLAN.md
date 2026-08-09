# Apature MCP Review - Evaluation Plan

Created: 2026-06-18
Revised: 2026-06-19
Status: pre-implementation acceptance plan

## 1. Evaluation Objective

Prove that MCP Review:

- works across target clients;
- produces useful grounded repair loops;
- uses less context than a full-result baseline;
- cannot be used as an arbitrary capture service;
- remains within cost and retry budgets;
- preserves clean feedback labels;
- does not weaken Gate's enforcement role.

No external beta should begin until protocol, security, and judgment-quality gates pass.

## 2. Evaluation Layers

### 2.1 Contract conformance

Validate:

- tool input schemas;
- tool output schemas;
- review-error schema;
- feedback event schema;
- text content mirrors structured content;
- success output versus `isError` error behavior;
- annotation truthfulness for service-side effects;
- additive-version behavior;
- unknown enum/error behavior;
- all golden fixtures.

Pass criteria:

- 100% schema-valid fixtures;
- 100% invalid fixtures rejected;
- no partial result after schema failure.

### 2.2 MCP protocol

Test:

- initialize and protocol-version negotiation for `2025-11-25`;
- patched stable SDK version at or above `1.26.0`;
- tools/list;
- tools/call;
- outputSchema and structuredContent;
- progress when requested;
- non-task cancellation;
- Streamable HTTP disconnect/reconnect;
- transport-session expiration;
- concurrent clients with isolated server/transport instances;
- OAuth challenge and refresh;
- bearer-token path;
- server instruction loading;
- stateless job recovery.

Pass criteria:

- official MCP Inspector suite passes;
- no response, progress notification, cancellation, or session state crosses concurrent client/tenant boundaries;
- job recovery succeeds after transport session loss;
- no result is authorized solely by session ID;
- cancellation produces a stable terminal application state.

### 2.3 Client compatibility

Clients:

- Codex CLI and IDE;
- Claude Code;
- Cursor;
- VS Code;
- GitHub Copilot cloud agent/code review where test access exists.

Scenarios:

1. install/configure;
2. authenticate;
3. submit review;
4. poll;
5. retrieve compact summary;
6. retrieve focus view;
7. apply an external code fix;
8. submit recheck;
9. cancel a queued job;
10. handle rate/domain/budget errors.

Measure:

- setup success;
- tool-selection accuracy;
- timeout rate;
- duplicate-job rate;
- schema parse rate;
- result truncation;
- image/evidence display behavior;
- auth support burden.

Pass criteria:

- Codex, Claude Code, Cursor, and VS Code complete the core loop;
- GitHub Copilot completes the loop with scoped bearer auth and tools only;
- no client requires MCP Tasks, resources, prompts, or Apps.

## 3. Product Experiments

### Experiment A: Four tools versus one overloaded tool

Design:

- identical tasks;
- compare proposed four-tool catalog to a single union tool.

Metrics:

- correct tool sequence;
- invalid argument rate;
- task completion;
- context tokens from tool definitions;
- user approval count.

Decision bar:

- four-tool surface must improve completion or reduce invalid calls without materially increasing context.

### Experiment B: Async submit/poll versus synchronous

Metrics:

- client timeout;
- connection loss;
- duplicate work;
- time to first useful status;
- total completion time.

Decision bar:

- async path has lower timeout/duplicate rate across all clients.

### Experiment C: Compact-first versus full result

Metrics:

- initial result tokens;
- total tokens per fixed finding;
- follow-up calls;
- fix success;
- result truncation;
- prompt-injection exposure.

Decision bar:

- compact-first reduces median total context by at least 40% with no more than a 5-point absolute reduction in fix success.

### Experiment D: Focus view versus full screenshot/DOM evidence

Metrics:

- tokens;
- valid code locator rate;
- fix success;
- follow-up perception calls;
- agent time to repair.

Decision bar:

- focus view improves token efficiency and does not reduce fix success.

### Experiment E: Repair constraints versus patch-like hints

Metrics:

- compile/test success of agent changes;
- source locator accuracy;
- incorrect confident patch rate;
- visual recheck pass rate.

Decision bar:

- repair constraints produce equal or better recheck success with fewer incorrect source assumptions.

### Experiment F: Recheck limits

Variants:

- no limit;
- per-finding ceiling only;
- ceiling plus unchanged-target detection and backoff.

Metrics:

- units consumed;
- successful fixes;
- abandoned loops;
- repeated identical captures.

Decision bar:

- proposed policy reduces wasted units by at least 70% while blocking fewer than 2% of ultimately successful fix loops.

## 4. Judgment and Agent-Loop Quality

Dataset:

- frozen capture set from Judgment Engine;
- real frontend PR previews;
- synthetic injected defects;
- clean controls;
- UI-DNA-present, draft, and missing cases.

Finding metrics:

- precision/recall by severity and dimension;
- blocker recall;
- nit precision;
- valid element-ref rate;
- evidence sufficiency;
- generic-suggestion rate;
- UI-DNA provenance validity;
- hallucinated source-locator rate.

Agent-loop metrics:

- fix attempt rate;
- recheck pass rate;
- time to pass;
- number of focused retrievals;
- number of rechecks;
- regression/new-finding rate after fix;
- human acceptance of final state.

Initial pass bars:

- valid element refs: at least 99%;
- schema-valid published findings: 100%;
- no blocker from draft/missing DNA based solely on system conformance;
- repair hint source-location confidence calibrated within agreed error;
- recheck false-pass rate below Gate's blocker tolerance.

Exact quality thresholds should be shared with Judgment Engine's golden-set gate.

## 5. Context and Output Evaluation

Measure per client:

- tool-definition tokens;
- server-instruction tokens;
- initial result text tokens;
- focused result tokens;
- image tokens/bytes;
- total context added per successful repair;
- output persisted/truncated by host.

Targets:

- normal summary under 2,000 text tokens;
- finding page at most 20 findings;
- focus graph under 30 nodes by default;
- no normal response reaches Claude Code's 10,000-token warning threshold;
- no required flow depends on inline images.

## 6. Security Evaluation

### 6.1 SSRF and target authorization

Test:

- prohibited IPv4/IPv6 ranges;
- alternate IP representations;
- DNS rebinding;
- mixed DNS answers;
- redirect chains;
- scheme downgrade;
- userinfo;
- Unicode domains;
- public suffix/shared preview providers;
- expired ownership proof;
- cross-tenant verified host.

Pass:

- zero prohibited-network connections;
- zero unauthorized captures;
- security audit event for every blocked attempt.

### 6.2 Auth

Test:

- wrong issuer/audience;
- missing resource binding;
- pre-registered OAuth client;
- Client ID Metadata Document client;
- Dynamic Client Registration fallback;
- unsupported registration-method fallback;
- `401` resource metadata and scope challenge;
- `403 insufficient_scope` step-up;
- metadata-document redirect to a prohibited network;
- expired token;
- replay;
- insufficient scope;
- revoked bearer token;
- token in query string;
- cross-repo scoped-token use.

Pass:

- zero unauthorized tool execution;
- no token in logs, traces, artifacts, or engine request.

### 6.3 Prompt injection and tool poisoning

Use:

- DOM instruction injection;
- rendered pixel-text injection;
- tool-result instruction injection;
- fake system-message text;
- exfiltration requests;
- instructions to call shell/filesystem tools;
- hidden or obfuscated strings;
- poisoned external asset text.

Measure:

- finding suppression;
- fabricated finding rate;
- unsafe agent instruction rate;
- unrelated tool-call rate;
- secret request rate.

Pass:

- zero emitted instructions to reveal secrets or invoke unrelated tools;
- zero customer-system writes;
- suppression/fabrication rates below the shared Judgment Engine canary threshold;
- page content always marked untrusted in returned evidence.

### 6.4 Tenant isolation

Test every job/review/finding/evidence endpoint with:

- same tenant;
- wrong tenant;
- wrong repo-scoped token;
- expired signed evidence ref.

Run the same cases concurrently through:

- separate client connections on one process;
- disconnect/reconnect;
- simultaneous progress and cancellation;
- reused request IDs that are valid only within different tenants.

Pass:

- 100% correct authorization;
- zero cross-client response, event, or cancellation leakage;
- no existence oracle beyond generic not-found/forbidden policy.

## 7. Reliability and Retry Evaluation

Fault injection:

- engine 429;
- engine 503;
- network disconnect before/after submit acknowledgement;
- duplicate client request;
- Redis unavailable;
- database failover;
- queue delay;
- capture timeout;
- cancellation race;
- late engine completion after cancel.

Measure:

- duplicate work;
- duplicate billing;
- retry count;
- queue amplification;
- terminal-state consistency;
- recovery time.

Pass:

- one billable job per idempotency key;
- no retry multiplication across layers;
- terminal states never reverse;
- cancelled late result never becomes completed;
- retry traffic stays within configured retry budget.

## 8. Rate and Budget Evaluation

Load profiles:

- normal single-agent loop;
- five agents on one repo;
- hot tenant with many repos;
- synchronized polling;
- repeated failed rechecks;
- burst after provider outage.

Pass:

- per-repo concurrency remains one;
- fair tenant scheduling;
- 429/structured rate errors include usable retry timing;
- polling does not starve review submissions;
- hard limits cannot be bypassed with new MCP sessions or principals from the same tenant;
- usage never exceeds a configured hard limit without an explicit opt-in.

## 9. Feedback Label Evaluation

Verify:

- polls do not create preference labels;
- lifecycle telemetry validates without fake labels or target-change fields;
- `review_submitted` uses `job_id` before `review_id` exists;
- repeated event delivery dedupes;
- unchanged recheck emits `target_unchanged`, not pass/fail;
- target fingerprints are present for recheck labels;
- explicit human verdict outranks inferred agent behavior;
- Gate correlation can confirm/contradict MCP outcomes;
- training eligibility honors customer policy.

Quality audit:

- sample 100 events per type;
- verify lineage completeness;
- compare event semantics to captured evidence;
- measure ambiguous-label rate.

Pass:

- 100% required lineage fields;
- no unchanged-target pass label;
- duplicate-label rate zero after dedupe;
- ambiguous labels excluded from training exports by default.

## 10. Failure-Mode Drills

Run tabletop and automated drills for:

- OAuth provider outage;
- Judgment Engine outage;
- preview provider DNS incident;
- leaked scoped token;
- cross-tenant access alert;
- prompt-injection regression;
- runaway review-unit consumption;
- artifact-store deletion;
- tool catalog unauthorized change;
- MCP specification/client breaking update.

Each drill must identify:

- detection signal;
- operator action;
- customer-facing error;
- recovery path;
- data/billing correction;
- post-incident test.

## 11. Release Gates

### Internal alpha

- schemas and golden fixtures pass;
- mock-engine client suite passes;
- auth, tenant isolation, and target authorization pass;
- no implementation of code writes exists.

### External beta

- four primary clients pass;
- GitHub Copilot compatibility path documented;
- shared Judgment Engine quality gate passes;
- SSRF/prompt-injection suite passes;
- budgets and idempotency survive load test;
- patched SDK and cross-client transport-isolation suite pass;
- support and incident runbooks exist.

### GA

- 30-day beta reliability data;
- no retry-storm or cross-tenant incident;
- official Registry/client directory metadata reviewed;
- compatibility matrix refreshed against current client versions and final MCP specification.

## 12. Evaluation Artifacts

When implementation begins, store:

- `fixtures/tools/*.json`;
- `fixtures/results/*.json`;
- `fixtures/errors/*.json`;
- `fixtures/feedback/*.json`;
- client configuration fixtures;
- protocol traces;
- capture golden-set references;
- security attack cases;
- experiment analysis notebooks or reports.

This repository should continue to own agent-surface fixtures, while Judgment Engine owns capture/model golden sets.
