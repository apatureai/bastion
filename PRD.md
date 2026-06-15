# Apature MCP Review - Product Requirements Document

Created: 2026-06-15
Source: extracted from `apature-systems/core` PRD as of 2026-06-15.

## 1. Product Summary

Apature MCP Review exposes the design critique engine to coding agents through MCP tools. It lets an agent check a generated UI, apply fixes itself, then ask Apature to recheck the result.

The product is the in-loop surface for AI-assisted development. It is how Apature becomes the thing agents call before their work reaches CI.

Core promise: the agent is the hands; Apature is the eyes.

## 2. Company Role

MCP Review is distribution and data acquisition, not the primary revenue surface.

It supports the company in three ways:

- It reaches developers at generation time, where AI-codegen users already live.
- It creates dense fix-then-recheck labels for the revealed-preference dataset.
- It defends against coding-agent platforms rebuilding the reviewer themselves by making Apature the neutral tool agents call.

CI remains the revenue surface. MCP is the growth channel and data factory.

## 3. Users And Buyers

Primary users:

- Developers using coding agents inside Cursor, Claude Code, Codex, or similar tools.
- Agentic coding workflows that need visual verification before opening a PR.

Buyer:

- Same team that buys Gate for CI enforcement.
- Metered usage can be sold as an add-on for heavy agent loops.

## 4. Scope

In scope for v1:

- MCP server exposing grounded design review tools.
- `design_review(url, routes?, viewports?)`.
- `design_recheck(url, finding_ids)`.
- `design_direction(url, brief)` after the review rubric stabilizes.
- Ownership-verified preview domains per tenant.
- Per-tenant and per-PR recheck budgets.
- Rate limiting and exponential backoff for retry storms.
- Structured findings with concrete token, class, and element references.
- Before/after annotated pairs for rechecks.
- Feedback event capture for every recheck outcome.

Out of scope:

- Writing code.
- Editing files.
- Opening pull requests.
- Committing fixes.
- Capturing arbitrary public URLs without tenant ownership verification.
- Replacing CI Gate. MCP helps the agent do better work, but Gate remains the enforceable neutral review.

## 5. Tool Contract

### `design_review`

Inputs:

- `url`: preview URL under a verified domain.
- `routes`: optional list of routes.
- `viewports`: optional viewport list.

Output:

- Critique object with grade, findings, not-reviewed list, and annotated screenshot links.

### `design_recheck`

Inputs:

- `url`: preview URL under a verified domain.
- `finding_ids`: findings from a prior critique.

Output:

- Pass/fail per finding.
- New evidence and confidence.
- Before/after annotated screenshot pair.

### `design_direction`

Inputs:

- `url`: preview URL.
- `brief`: high-level desired direction.

Output:

- Grounded recommendations using the repo's tokens, component conventions, brand context, and UI DNA.

This tool ships only after ordinary review quality is stable because ungrounded art direction is the highest-hallucination surface.

## 6. Architecture

MCP Review is a thin product layer over the same backend interface as Gate:

`critique(images, context) -> Findings`

Major components:

- MCP protocol server.
- Tenant and domain verification.
- Capture orchestration using the shared capture pipeline.
- Qwen3-VL critique adapter through the shared model abstraction.
- Recheck optimizer that captures only relevant elements when possible.
- Usage meter and budget enforcer.
- Feedback event writer.

The product must preserve byte-identical repo context blocks where possible so downstream prefix caching and eval comparability remain intact.

## 7. Security

The MCP surface creates two special risks:

- SSRF via arbitrary URLs.
- Cost blowups from recheck loops.

Required controls:

- Reject any URL that is not under a pre-registered, ownership-verified domain.
- Deny internal, metadata, link-local, and rebinding IP targets at capture egress.
- Per-tenant, per-PR, and per-agent-session budgets.
- Exponential backoff after repeated failed rechecks.
- No write credentials of any kind.
- No filesystem access to the customer's repository through this server.

## 8. Success Metrics

Adoption:

- Active MCP tenants.
- Agent sessions invoking Apature tools.
- Ratio of MCP users who also install Gate.

Loop quality:

- Findings fixed and passed on recheck.
- Average rechecks per finding.
- Recheck false-pass and false-fail rate.

Data moat:

- Labeled fix-then-pass examples.
- Time from finding to resolved state.
- Per-team memory improvements from in-loop labels.

Cost:

- Cost per successful recheck.
- Retry storm incidents, target zero.

## 9. Milestones

MVP:

- `design_review` and `design_recheck`.
- Domain verification.
- Rate limits and budget controls.
- Agent-readable structured output.
- Annotated before/after recheck artifact.

Next:

- `design_direction`.
- Deeper integration with UI DNA source-of-truth queries.
- Per-agent usage analytics for teams.

## 10. Open Risks

- MCP monetization is less mature than CI monetization.
- Agent platforms may add their own visual review loops.
- URL verification and SSRF protection must be correct before launch.
- An agent can call the tool repeatedly in a loop unless budgets are enforced.
- Recheck results may be noisy if the target deploy updates mid-loop.

## 11. Repository Boundary

This repo owns the MCP product surface, agent-facing tool contracts, metering policy, and recheck UX. It should not become the implementation home for the whole critique engine.
