# Apature MCP Review - Threat Model

Created: 2026-06-18
Revised: 2026-06-19
Method: trust-boundary review informed by MCP security guidance, STRIDE, and recent MCP security research

## 1. Security Objective

Allow an authenticated coding agent to obtain read-only design judgment for a tenant-authorized preview without:

- reaching an unauthorized network target;
- exposing credentials or preview data;
- mutating customer code or application state;
- letting page content control the agent;
- crossing tenant boundaries;
- creating unbounded cost;
- corrupting feedback labels.

## 2. Assets

- tenant identity and authorization;
- OAuth and scoped bearer credentials;
- verified-domain and provider-binding records;
- private preview screenshots and DOM-derived data;
- UI DNA and source provenance;
- UI Graph and element refs;
- review findings and evidence;
- budget ledger and billing allowance;
- feedback and preference labels;
- tool descriptions, server instructions, and schema integrity;
- internal engine credentials and endpoints;
- audit and trace data.

## 3. Trust Boundaries

1. MCP client to public MCP endpoint.
2. MCP endpoint to identity provider.
3. MCP Review to verified target policy.
4. MCP Review to Judgment Engine.
5. Judgment Engine to preview network.
6. Capture artifacts to model provider or in-VPC model.
7. Judgment Engine to UI DNA/UI Graph stores.
8. MCP Review result to the customer's agent.
9. MCP Review feedback events to the shared training data substrate.

## 4. Threat Actors

- unauthenticated internet attacker;
- authenticated tenant attempting to capture arbitrary or internal URLs;
- malicious preview application;
- compromised dependency or MCP server deployment;
- malicious or compromised MCP client;
- tenant user attempting cross-repo or cross-tenant access;
- agent caught in an accidental retry/recheck loop;
- internal operator with excessive access;
- model responding to prompt injection in DOM or pixels.

## 5. Threats and Controls

### T1: Arbitrary URL capture and SSRF

Attack:

- caller points capture at metadata, loopback, internal services, another tenant, or an unauthorized public target.

Controls:

- verified target required;
- HTTPS only;
- no IP-literal targets;
- Public Suffix List-aware authorization;
- exact project binding for shared preview providers;
- A/AAAA validation and DNS pinning;
- deny private, loopback, link-local, metadata, multicast, and reserved ranges;
- redirect revalidation;
- Judgment Engine sandbox and egress enforcement;
- no raw upstream response returned to caller.

Residual risk:

- public third-party assets can still contain malicious content; treat them as untrusted capture inputs.

### T2: DNS rebinding and TOCTOU

Attack:

- authorized hostname resolves public during policy check and private at connection.

Controls:

- resolve immediately before connection;
- reject mixed public/private answers;
- pin validated IP for the connection;
- verify TLS hostname;
- repeat checks per redirect/subrequest policy.

### T3: Cross-tenant job access

Attack:

- caller guesses a job, review, finding, or evidence ID.

Controls:

- opaque high-entropy IDs;
- credential-derived tenant filter on every read;
- Postgres row-level security or equivalent defense in depth;
- no global list endpoints;
- audit denied accesses;
- signed artifact refs scoped to tenant and expiry.

### T4: OAuth confused deputy and token passthrough

Attack:

- token intended for another resource is accepted or forwarded.

Controls:

- MCP Protected Resource Metadata;
- OAuth `resource` parameter;
- audience validation;
- exact issuer validation;
- PKCE;
- pre-registration, Client ID Metadata Documents, and Dynamic Client Registration only through advertised capabilities;
- bounded HTTPS-only metadata-document fetches with redirect and prohibited-network checks;
- issuer-bound registration credentials;
- `401`/`403` scope challenges for least-privilege step-up;
- no downstream user-token forwarding;
- separate service credential for Judgment Engine.

### T5: Scoped token theft

Attack:

- static bearer token leaks through config, logs, or a repository.

Controls:

- show once;
- store hash only;
- short default expiry;
- repo/installation scope;
- secret scanning pattern;
- redaction from logs and traces;
- rotation and revoke UI;
- anomaly alerts;
- documentation requiring environment/agent secret storage.

### T6: Tool poisoning or metadata rug pull

Attack:

- tool description or server instructions contain hidden directives that alter agent behavior or exfiltrate data.

Controls:

- static metadata checked into the release artifact;
- no page, tenant, database, or remote content interpolation;
- manifest hash in deployment provenance;
- review required for metadata changes;
- verified Registry namespace;
- concise literal descriptions;
- no instructions to call unrelated tools or expose secrets.

### T7: Indirect prompt injection from page text

Attack:

- DOM, console, network, or screenshot text instructs the model or calling agent to ignore policy, call tools, expose secrets, or modify unrelated files.

Controls:

- label all page content as untrusted;
- model system prompt explicitly treats visible text as page data;
- schema-constrained finding output;
- post-parse validation;
- no action tools in this server;
- no roots, client sampling, or repository access;
- result formatter keeps observations separate from repair hints;
- injection canaries in DOM and pixels;
- suspicious instructions retained only as redacted evidence when relevant.

### T8: Malicious preview mutates state during capture

Attack:

- page load triggers writes, forms, downloads, popups, or side effects.

Controls:

- capture is navigation/observation only;
- no clicks, typing, or form submission;
- disable downloads and external protocol handlers;
- fresh isolated browser context;
- no broad credentials;
- origin-scoped storage state only when explicitly configured;
- no storage state for fork/untrusted contexts;
- destroy sandbox after capture.

Residual risk:

- application GET endpoints may themselves have side effects; customer preview guidance and sandbox isolation remain necessary.

### T9: Credential exfiltration by preview

Attack:

- malicious preview script reads injected cookies or headers and sends them elsewhere.

Controls:

- MCP bearer/OAuth tokens never enter browser;
- preview auth secrets stay in Judgment Engine;
- exact-origin cookies;
- no org-wide SSO cookie;
- egress monitoring and size caps;
- storage state disabled by default and on fork contexts;
- retention and secret redaction.

### T10: Retry storm

Attack:

- clients and services independently retry, multiplying load during failure.

Controls:

- one retry owner per dependency;
- required idempotency key;
- duplicate job replay;
- maximum attempts;
- full jitter;
- honor `Retry-After`;
- circuit breaker;
- concurrency limits;
- explicit `retriable` field;
- clients told not to retry permanent errors.

### T11: Recheck cost loop

Attack:

- agent repeatedly edits and rechecks or rechecks without changes.

Controls:

- review-chain and per-finding budgets;
- target fingerprint comparison;
- unchanged-target rejection;
- progressive backoff after repeated failed rechecks;
- daily hard ceiling;
- budget metadata in every response;
- no paid overage without tenant opt-in.

### T12: Idempotency collision or abuse

Attack:

- caller reuses a request ID with different arguments, or a collision crosses tenant boundaries.

Controls:

- idempotency key scoped to tenant and tool;
- store normalized input hash;
- changed arguments return conflict;
- no cross-tenant lookup;
- bounded retention.

### T13: Result tampering or stale evidence

Attack:

- client receives evidence from the wrong target/version, or an artifact URL is substituted.

Controls:

- content hashes;
- signed refs;
- review and capture lineage;
- target fingerprint;
- artifact authority allowlist;
- result schema validation;
- no raw arbitrary URLs in repair hints.

### T14: Schema confusion

Attack:

- malformed engine or client payload exploits coercion or causes a misleading result.

Controls:

- JSON Schema validation at every boundary;
- reject unknown required semantics;
- schema version;
- additive-only evolution;
- golden fixtures;
- no partial result publication after validation failure.

### T15: Feedback poisoning

Attack:

- repeated calls, anonymous interactions, or malicious agents create false positive labels.

Controls:

- event dedupe;
- actor and label-source fields;
- changed-target requirement;
- collaborator weighting;
- `inconclusive` preserved;
- polls are not labels;
- training eligibility and consent field;
- Gate outcome correlation;
- anomaly detection by principal/repo.

### T16: Data retention leak

Attack:

- sensitive screenshot remains accessible beyond policy or through logs.

Controls:

- raw artifacts owned by Judgment Engine;
- encrypted object storage;
- signed short-lived refs;
- tiered deletion;
- tombstones after expiry;
- no screenshot data in logs;
- redaction policies;
- customer deletion workflow.

### T17: Denial of wallet

Attack:

- authorized user or compromised agent consumes model/capture spend.

Controls:

- review-unit reservation;
- hard tenant and repo limits;
- no implicit overage;
- concurrency caps;
- anomaly alerts;
- cheaper triage option;
- admin kill switch.

### T18: Client auto-executes metered tools

Attack:

- a host auto-executes metered tools or treats the customer-facing “read-only” posture as meaning no service-side effects.

Controls:

- mark submit/recheck as `readOnlyHint: false`;
- mark cancel as `readOnlyHint: false` and `destructiveHint: true`;
- reserve `readOnlyHint: true` for result retrieval;
- hard budgets independent of host approval;
- custom metered metadata;
- explicit cost language in descriptions;
- narrow tool allowlist guidance;
- per-principal limits;
- optional approval recommendation in install docs.

### T19: Internal privilege misuse

Attack:

- operator or service account reads another tenant's artifacts or changes verification records.

Controls:

- least-privilege service identities;
- tenant-scoped data access;
- break-glass process;
- immutable audit logs;
- separation of domain management and review execution;
- production access review.

### T20: Supply-chain compromise

Attack:

- malicious SDK/package update changes tool behavior or exfiltrates tokens.

Controls:

- lockfiles and provenance;
- dependency review;
- stable SDK rather than alpha;
- minimum `@modelcontextprotocol/sdk 1.26.0`;
- SBOM and vulnerability scanning;
- signed build artifacts;
- minimal runtime dependencies;
- canary deployment and manifest hash monitoring.

### T21: Cross-client protocol-state leakage

Attack:

- a shared SDK server or transport instance routes a response, cancellation, progress event, or session state to the wrong client or tenant.

Controls:

- patched stable SDK at or above `1.26.0`;
- mutable server/transport instances scoped per client connection or request;
- no tenant authorization or product state in SDK instance globals;
- correlation IDs validated against the authenticated principal and product job;
- concurrent two-tenant isolation tests for responses, progress, cancellation, and disconnects;
- fail deployment if a singleton transport/server construction is detected by architecture tests or review.

## 6. Abuse Cases

Required negative tests:

- `https://127.0.0.1`;
- alternate numeric forms of loopback;
- IPv6 loopback and link-local;
- hostname with mixed public/private DNS answers;
- public host redirecting to metadata service;
- `user:pass@host`;
- shared provider wildcard claim;
- Unicode/punycode lookalike host;
- another tenant's job ID;
- another review's finding ID;
- same idempotency key with different URL;
- prompt injection in DOM text;
- prompt injection rendered in screenshot pixels;
- page text asking the agent to read secrets or invoke shell tools;
- repeated unchanged rechecks;
- simultaneous requests exhausting repository concurrency;
- expired evidence ref;
- engine result with unknown element ref;
- engine result with invalid schema;
- tool catalog hash changed outside approved release.
- concurrent clients receiving interleaved results, progress, or cancellation events.

## 7. Security Release Gates

Before external beta:

- auth and tenant-isolation tests pass;
- domain verification and SSRF suite pass;
- no raw access token reaches Judgment Engine or preview;
- prompt-injection canary suppression/fabrication rates meet eval threshold;
- rate and budget limits survive concurrency tests;
- schema fuzzing produces no unsafe partial result;
- dependency and container scans have no unresolved critical findings;
- stable SDK security floor and concurrent transport-isolation tests pass;
- incident runbook exists for token leak, SSRF attempt, cross-tenant access, and runaway spend.

## 8. Open Security Questions

- Which authorization provider best satisfies OAuth metadata and target-client interoperability?
- Does the selected authorization provider safely support Client ID Metadata Documents without introducing a metadata-fetch SSRF path?
- Should scoped bearer tokens be disabled for non-GitHub clients by default?
- Can provider project binding be independently revalidated without storing provider admin tokens?
- Which page subresources require destination pinning versus isolated proxy fetch?
- What screenshot redaction can occur before model inference without hurting judgment quality?
- Should evidence retrieval require a fresh access token or a signed URL alone?
