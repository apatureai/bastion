# Apature MCP Review

In-loop, read-only design review for coding agents.

Apature MCP Review lets Codex, Claude Code, Cursor, VS Code, GitHub Copilot, and other MCP clients ask Apature to inspect a verified preview, return grounded findings, and recheck the agent's fix before CI.

The product boundary is deliberate:

- Apature is the eyes; the customer's agent is the hands.
- MCP Review judges, explains, and verifies. It never edits code, commits, pushes, opens pull requests, or drives the customer's application.
- MCP is the distribution and fix-loop data surface. [Apature Gate](https://github.com/apatureai/gate) remains the enforceable CI and revenue surface.

## Recommended Product Shape

MCP Review is a remote Streamable HTTP MCP server backed by explicit asynchronous review jobs.

The stable v1 tool set is intentionally small:

- `design_review`: submit a review of a verified preview.
- `design_review_get`: poll status or retrieve compact, paginated, or focused result views.
- `design_recheck`: re-evaluate findings from a prior review after the customer's agent changes the UI.
- `design_review_cancel`: best-effort cancellation of queued or running work.

`design_direction` remains deferred until ordinary review quality clears its evaluation bar.

The server returns observations, evidence, repair constraints, and code-location hints. It does not return a patch or claim that a code change was applied.

## Why Asynchronous Jobs

Capture and multimodal judgment routinely exceed interactive MCP client timeouts. Codex documents a default 60-second tool timeout, while a multi-route review can take longer. A submit-and-poll contract:

- survives client disconnects and transport-session loss;
- avoids holding an MCP request open through capture and inference;
- supports cancellation, idempotency, budgets, and re-use;
- remains compatible with clients that do not implement MCP Tasks;
- maps cleanly to the asynchronous job API already specified between Gate and Judgment Engine.

MCP Tasks can become an optional adapter after client support is proven. Application job IDs remain canonical.

## Documentation

- [RESEARCH.md](RESEARCH.md): primary-source research, alternatives, client compatibility, and market implications.
- [PRD.md](PRD.md): product requirements, users, metrics, pricing posture, and sequencing.
- [TRD.md](TRD.md): tool behavior, lifecycle, auth, domain verification, budgets, errors, feedback, and acceptance criteria.
- [ARCHITECTURE.md](ARCHITECTURE.md): system boundaries, Mermaid diagrams, failure modes, and cross-repo ownership.
- [CONTRACTS.md](CONTRACTS.md): detailed tool, evidence, engine, UI Graph, UI DNA, and feedback contracts.
- [ADRS.md](ADRS.md): architecture decisions and rejected alternatives.
- [THREAT_MODEL.md](THREAT_MODEL.md): assets, trust boundaries, threats, and required controls.
- [EVAL_PLAN.md](EVAL_PLAN.md): protocol, client, quality, security, cost, and agent-loop evaluations.
- [schemas/mcp-tools.json](schemas/mcp-tools.json): machine-readable MCP tool definitions.
- [schemas/review-error.schema.json](schemas/review-error.schema.json): typed tool-execution error contract.
- [schemas/feedback-event.schema.json](schemas/feedback-event.schema.json): feedback event JSON Schema.

## Repository Boundary

This repository owns:

- agent-facing MCP tools and server instructions;
- review job and recheck UX;
- MCP authentication and client compatibility policy;
- verified-preview authorization policy;
- usage quoting, budgets, and agent-loop controls;
- compact result views, evidence presentation, and feedback event semantics.

This repository does not own:

- browser capture, model inference, validation, or artifact storage (`apatureai/judgment-engine`);
- the canonical UI DNA schema or extraction (`apatureai/ui-dna`);
- UI Graph construction or prompt-view semantics (`apatureai/ui-graph`);
- GitHub comments, Check Runs, PR enforcement, or billing UX (`apatureai/gate`);
- upstream UI-standard lookup (`apatureai/source-of-truth`);
- live localhost sessions or overlays (`apatureai/pointer`);
- code edits, patches, commits, or pull requests (the customer's agent).

## Protocol Baseline

As of June 19, 2026:

- the latest final MCP specification is `2025-11-25`;
- `2026-07-28` is a release candidate, not a final specification;
- the release candidate makes the core protocol stateless and moves long-running Tasks into an extension;
- the official TypeScript SDK v1 line is the production baseline; v2 remains prerelease;
- `@modelcontextprotocol/sdk` must be at least `1.26.0` because earlier releases have published high-severity transport-isolation, DNS-rebinding, and URI-template advisories.

The implementation phase should support the final `2025-11-25` protocol first, avoid business state tied to `MCP-Session-Id`, never share SDK server or transport instances across clients, and keep transport code isolated so the stateless final specification can be adopted after client and SDK support stabilize.

“Read-only” describes the customer boundary, not every MCP annotation. Submit and recheck create metered Apature jobs, and cancel terminates one, so only `design_review_get` uses `readOnlyHint: true`.
