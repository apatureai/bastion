# bastion

[![CI](https://img.shields.io/github/actions/workflow/status/apatureai/bastion/ci.yml?branch=main&label=CI)](https://github.com/apatureai/bastion/actions/workflows/ci.yml) [![license](https://img.shields.io/github/license/apatureai/bastion)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org/en/download)

**A remote MCP server for in-loop design review, and a worked reference for OAuth 2.1 auth, SSRF-safe URL handling, and long-running jobs over MCP.**

A coding agent changes a UI, deploys a preview, and has no way to see whether the result looks right. `bastion` is the MCP server on the other end of that loop: the agent submits a preview URL, gets back structured findings (route, viewport, element ref, suggested fix), applies the fixes itself, then asks the server to recheck them. The server judges and verifies; it never edits code.

It is also, deliberately, a reference implementation. Most public MCP servers are stdio, unauthenticated, single-tenant, and return in milliseconds. This one carries the other shape: a Streamable HTTP edge with OAuth 2.1 resource-server auth, per-tenant Postgres state, submit-and-poll jobs that outlive the transport session, and a hardened boundary around the one thing an agent-supplied URL always is, which is an SSRF primitive.

Everything below runs offline with no credentials, and with nothing configured the judgments come from a fixture. They do not have to stay that way. [Getting real judgments](#getting-real-judgments) is one clone and one environment variable: the critique backend, [apatureai/verdict](https://github.com/apatureai/verdict), is public and MIT, screenshots the page with headless Chromium, and returns the exact result contract this server consumes. A fixture judgment cannot be mistaken for a model's, and not because of anything printed at startup: the distinction is inside the result. Every review carries a `provenance` object with `model_backed`, and when that is `false` the grade is the literal string `"unjudged"`, the narrative says so instead of describing a page nothing looked at, and `not_reviewed[0]` begins `[bastion] no model judged this page`. Every review also carries `coverage`, because a model can be called and still judge nothing, and a run whose `coverage.routes_reviewed` is empty is graded `"nothing_reviewed"` rather than the `ship` such a result carries by construction. See [Provenance: did anything judge this page?](#provenance-did-anything-judge-this-page) and [Coverage: what did it actually look at?](#coverage-what-did-it-actually-look-at).

## Quickstart

Node 24+ and pnpm 9.15.0 (`corepack enable` installs pnpm from the `packageManager` field). Nothing else: no API key, no database, no Docker. `pnpm install` needs the npm registry once; after that nothing here opens a connection.

```bash
git clone https://github.com/apatureai/bastion.git
cd bastion
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

`pnpm demo` is a real MCP client.

> The server still identifies itself on the wire as `apature-mcp-review`. That name is part of the
> MCP handshake and any client configuration that already references it, so the repository rename to
> `bastion` deliberately left it alone. It spawns the server as a child process over stdio, completes a handshake, submits a review, reads it back four ways, acts on a finding, rechecks it, and gets denied on an unauthorized host:

```console
$ pnpm demo

mcp-review local server ready on stdio
  engine: FIXTURE engine: no critique backend configured. Findings are replayed from the golden fixture and describe a fictional pricing page, NOT the URL you pass. Set VERDICT_CLI (a built verdict checkout) for real judgments.
  authorized hosts: preview.example.com
connected to apature-mcp-review v1.3.0 over stdio

[1] tools/list
    design_review                metered
    design_review_get            free
    design_recheck               metered
    design_review_cancel         free
    design_review_panel_action   free

[2] design_review  https://preview.example.com/pricing
    job job_f3484b5d-c440-4bbe-82ed-3089899f691c -> completed, 1 unit(s)

[3] design_review_get  view=status
    status=completed, review body present: false

[4] design_review_get  view=summary
    review rev_60ed3a95-21cd-4188-8660-51a5727bf1fa -> grade unjudged
    provenance: model_backed=false source=fixture engine=bastion-fixture
    Coverage: 1 of 2 route(s) reviewed; reviewed /pricing; skipped /checkout; viewports skipped: tablet.
    No model judged this page, so there is no assessment of it: the offline fixture engine replayed the golden result in @apature/mcp-types; it describes a fictional pricing page and not the target that was requested. Any findings below are not observations of the target.
    f_001  should_fix [unjudged] Primary CTA uses an off-brand color on mobile
             /pricing (mobile) button[data-testid='cta-primary']
             fix: Apply the `--color-accent` token (or the `btn-primary` class) so the CTA matches the brand accent used elsewhere.
    f_002  should_fix [unjudged] Pricing card grid overflows the mobile viewport
             /pricing (mobile) .pricing-grid
             fix: Switch the grid to a single column under the `sm` breakpoint.
    f_003  nit        [unjudged] Inconsistent vertical rhythm between feature rows
             /pricing (desktop) .feature-row
             fix: Use a single spacing token for consistent vertical rhythm.
    not reviewed: [bastion] no model judged this page: the offline fixture engine replayed the golden result in @apature/mcp-types; it describes a fictional pricing page and not the target that was requested. The grade is reported as "unjudged" and nothing in this result is a judgment of the target. See the README section "Getting real judgments" to configure a critique backend.
    not reviewed: route /checkout (no preview deployment matched the head SHA)
    not reviewed: viewport tablet (not configured)

[5] design_review_get  view=focus  (nits dropped)
    2 actionable of 3 findings

[6] design_review_get  view=evidence  (multimedia + MCP-Apps panel)
    content blocks: resource, text, text, text, image, text, image, text, text
    panel=true multimedia=true withheld=[]
    wrote out/review.json and out/panel.html

[7] design_review_panel_action  apply_fix  (eyes, not hands)
    f_001 -> unjudged
    nothing to hand over: no model judged this review, so its fix text is fixture text

[8] design_recheck  after the agent claims a fix
    provenance: model_backed=false source=fixture engine=bastion-fixture
    f_001  unjudged     confidence=null
    f_002  unjudged     confidence=null
    f_003  unjudged     confidence=null
    reason on every outcome: [bastion] no model judged this page: the offline fixture engine derived each outcome from a hash of the finding id; nothing captured, compared or observed the target before or after the change. The outcome is reported as "unjudged": whether this finding is resolved at the target is unknown, and nothing here is an observation of it. See the README section "Getting real judgments" to configure a critique backend.

[9] design_review  https://evil.example.org/  (SSRF boundary)
    rejected: DOMAIN_UNVERIFIED (next_action: verify_domain)

Done. 3 findings, 3 recheck outcomes.
Open out/panel.html in a browser to see the review panel.
```

**Success looks like** nine numbered steps, `3 findings, 3 recheck outcomes`, and two new files. `out/review.json` is the agent-facing `Critique`; `out/panel.html` is the review panel:

```bash
open out/panel.html      # macOS; use xdg-open on Linux
```

The panel is self-contained HTML with no scripts, no external requests, and evidence embedded as `data:` URIs. The `job_*` and `rev_*` ids are freshly generated, so yours will differ from the transcript.

If `pnpm demo` reports `Cannot find module`, `pnpm build` has not been run. If step 2 comes back `DNS_TARGET_PROHIBITED` instead of a job, something changed `LOCAL_RESOLVED_ADDRESS` in `packages/mcp-server/src/local-server.ts` to a non-public address, and that rejection is the SSRF guard working.

### Provenance: did anything judge this page?

The consumer of a review here is usually a coding agent, not a person. It never sees the startup banner or the terminal above; it sees one JSON payload and acts on it. So "which engine is running" has to be answerable from that payload alone, and it is: every `Critique` carries a `provenance` object, on every backend, including the offline fixture path.

```json
"grade": "unjudged",
"confidence": null,
"provenance": {
  "model_backed": false,
  "source": "fixture",
  "engine": "bastion-fixture",
  "model": null,
  "detail": "the offline fixture engine replayed the golden result in @apature/mcp-types; it describes a fictional pricing page and not the target that was requested"
}
```

The rule an agent can code against: **trust the result only when `provenance.model_backed === true` and `coverage.state` is not `"nothing"`.** Two conditions, because they are two different questions and neither answers the other. See [Coverage](#coverage-what-did-it-actually-look-at) below for the second one.

| `model_backed` | when | what the payload does |
| --- | --- | --- |
| `false` | the fixture engine; verdict run with `--model mock` or `--model canned` | `grade` is `"unjudged"`, `confidence` is `null`, `overall` says no model judged the page instead of describing one, `not_reviewed[0]` starts `[bastion] no model judged this page`, and every finding carries `"unjudged": true` |
| `true` | verdict run with `--model live`: Chromium captured your target and a vision model judged the capture | the engine's grade, narrative, confidence and findings pass through untouched, and `provenance.model` names the judge |
| `null` | a remote verdict deployment over its job API | the grade passes through, because a real judgment may well be behind it, but this process cannot see how that deployment's model is configured and does not claim to |

### Coverage: what did it actually look at?

`provenance` answers whether a model judged the page. It does not answer what the model judged, and those come apart. Verdict's triage pass can conclude that a deep review is needed and then name no route to run it on. A model really was called, so `model_backed` is truthfully `true`; no page was ever judged. A result with no surviving findings grades `ship` by construction, because verdict floors the grade to what the findings support and nothing supports better than `ship`. Field for field, that run is indistinguishable from a clean page:

```json
"grade": "ship", "findings": [], "provenance": { "model_backed": true, ... }
```

So every `Critique` also carries `coverage`, which is verdict's `coverage` block (`routesRequested` / `routesReviewed` and the viewport pair) in this surface's own casing, plus the classification:

```json
"grade": "nothing_reviewed",
"coverage": {
  "state": "nothing",
  "routes_requested": ["/", "/pricing"],
  "routes_reviewed": [],
  "routes_skipped": ["/", "/pricing"],
  "viewports_requested": ["mobile", "tablet", "desktop"],
  "viewports_reviewed": [],
  "viewports_skipped": ["mobile", "tablet", "desktop"]
}
```

| `coverage.state` | what it means | what the payload does |
| --- | --- | --- |
| `full` | every requested route and viewport was reviewed | nothing is suppressed |
| `partial` | something was reviewed, but not everything asked for | nothing is suppressed: a partial review is a real verdict about a smaller surface, and `routes_skipped` names what it missed |
| `nothing` | the run judged no route at all | `grade` is `"nothing_reviewed"`, `confidence` is `null`, `overall` is replaced with a statement that nothing was reviewed, every finding carries `"unjudged": true`, and a `not_reviewed` entry starts `[bastion] nothing was reviewed` |
| `unstated` | the engine did not report coverage | nothing is suppressed, and the payload says so rather than implying a completeness it cannot verify. Absence is never read as "everything was reviewed" |

`nothing_reviewed` wins over `unjudged` when both apply: an operator whose run judged no page is not helped by being told the judgment stamp was missing too, and both facts are still in the payload (`provenance`, and both disclosure lines in `not_reviewed`, the no-model one first). This is the same rule and the same vocabulary [apatureai/gate](https://github.com/apatureai/gate) uses for its Check Run, so the two surfaces cannot tell different stories about one run.

#### Grounding: findings the engine deleted

`hallucination_drops` is how many model findings verdict's grounding gate deleted for citing a route or an element the capture never produced. "The page is clean" and "the model produced four findings and not one of them could be pointed at" both arrive as an empty `findings` array under a `ship` grade, and only the engine knows which happened.

It does **not** suppress the grade. The routes were judged, and deleting ungroundable findings is the grounding gate working as intended. It is reported so an empty finding list is not read as a clean page. `null` and `0` are different answers: `0` means the gate ran and deleted nothing, `null` means the engine reported no grounding gate.

#### Measurements: the half an agent can act on unconditionally

Every rule above tells an agent to check something before believing the payload, and every one of
those rules is right, because everything they guard is downstream of a model having run: the grade,
the narrative, every finding. `measurements` is the exception, and it is on every `Critique`:

```json
"measurements": {
  "state": "reported",
  "checks_run": ["contrast", "overflow", "touch_target"],
  "violations": [
    {
      "kind": "contrast",
      "route": "/",
      "viewports": ["desktop"],
      "element_ref": "#hero-subtitle",
      "detail": "text contrast 3.23:1 is below WCAG AA 4.5:1",
      "block_eligible": true
    }
  ]
}
```

These are computed by verdict from the captured DOM with **no model involved**: a `getComputedStyle`
call, a scroll width, a rectangle. So the instruction is different, and it is in the tool description
as well as here: **act on `measurements.violations` unconditionally**, and act on `findings` only
when `provenance.model_backed === true` and `coverage.state` is `full` or `partial`. Gating a
measurement behind a model stamp would discard the only trustworthy thing in an unjudged payload.

They are carried unchanged on every path, including the ones that replace the grade with `unjudged`
or `nothing_reviewed` and rewrite the narrative, and they are **never** stamped with the per-item
`unjudged` marker that findings carry: that marker means "do not act on this as an observation", and
a measurement is an observation whatever the judge did.

A measurement is never a finding. It has no severity, no confidence and no dimension, it never enters
`findings[]`, and it never changes the grade. `block_eligible` is the ENGINE's claim that a
measurement is precise enough to gate a merge on; `false` does not mean it is wrong, only that acting
on it automatically would be, because it may be intentional (a deliberate scroll container, a desktop
pointer target) or in a known false-positive class (text over a background image). Bastion never
computes or overrides it.

`state` is `"reported"` when the engine sent a report and `"unstated"` when it did not, and it is
never synthesized. `"unstated"` means "this engine does not report measurements" and must never be
read as "the page measured clean"; that positive statement is `"reported"` with a non-empty
`checks_run` and an empty `violations`.

#### Every payload an agent acts on, not only the review

A stamp on the review body alone is not enough, because the review body is not the only thing an agent reads and acts on. Three other payloads carry it, each for its own reason.

**The recheck.** `design_recheck` is the payload an agent reads to decide its fix landed and it can stop working, which makes it the most consequential one in the surface. Against the fixture engine nothing captures, compares, or observes anything: each outcome comes from a hash of the finding id. So the recheck is stamped like the review, and on an unjudged path the outcome is `"unjudged"`, the confidence is `null`, and the reason is replaced rather than annotated:

```json
"outcomes": [
  {
    "finding_id": "f_001",
    "outcome": "unjudged",
    "confidence": null,
    "reason": "[bastion] no model judged this page: the offline fixture engine derived each outcome from a hash of the finding id; nothing captured, compared or observed the target before or after the change. ..."
  }
],
"provenance": { "model_backed": false, "source": "fixture", "engine": "bastion-fixture", "model": null, "detail": "..." }
```

`"unjudged"` is deliberately not `"inconclusive"`. Inconclusive means something looked at the target and could not tell, which is a real observation and a far stronger claim than the truth here.

**The panel action.** `design_review_panel_action` returns a `fix` string the caller is expected to hand to a coding agent. When nothing judged the review that string is invented, so it is not returned at all: the response is `{ "type": "unjudged", "finding_id": "..." }` and the payload carries the review's `provenance` alongside it. It is not `human_only` either, because there is no advisory judgment to refer to a person.

**Each finding.** An agent iterating `findings[]` and applying each `suggestion` never reads the envelope; it holds one array element at a time. Every finding in an unjudged payload therefore carries `"unjudged": true` itself. The field is absent otherwise, so its absence claims nothing and `provenance` stays the authority.

**Each content block.** `structuredContent` is not the only rendering of a result. The `evidence` view also returns MCP `content[]` blocks, and a client that renders those instead of reading the JSON sees them one at a time. So the same marker, in the same vocabulary, is on each block, and the panel tags each card the same way:

```text
1 text  "Design review (unjudged): No model judged this page, so there is no assessment of it: ..."
2 text  "[should_fix] [unjudged] Primary CTA uses an off-brand color on mobile @ /pricing (mobile, `button[data-testid='cta-primary']`). Fix: Apply the `--color-accent` token ... Nothing judged this page, so this is not an observation of the target."
3 image _meta { "com.apature/unjudged": true, "com.apature/unjudged_disclosure": "Nothing judged this page, so this is not an observation of the target." }
```

Before this, blocks like block 2 were bare: confident, specific advice about a page nothing had looked at, with the disclosure only in the envelope block above it and in the JSON beside it.

An image block is the case a sentence cannot solve, and it was the last one left. It has no prose to disclose in, and a host that renders pictures prominently could show what looks like an annotated screenshot of your page with the disclosure only in a neighbouring text block. So the marker rides in `_meta`, which MCP puts on every content block for exactly this, under the same two namespaced keys on the image and on the text block it illustrates, from one function so the pair cannot drift. A judged block carries no `_meta` at all, so the marker's absence claims nothing on its own and `provenance` stays the authority.

Four details that make the claim checkable rather than decorative:

- **`unjudged` is not an engine value.** No backend emits it. Bastion substitutes it, and only when `model_backed` is `false`. It is an explicit value rather than a null or a dropped key because a missing field reads as an older payload and invites a default, and because it sits outside the `ship`..`blocked` ordering, so a consumer comparing against a threshold gets no answer instead of a flattering one.
- **The narrative is replaced, not annotated.** The fixture's prose is about a pricing page that does not exist. Presenting it as a description of your page would be the same lie as the grade, just in longer form, so on an unjudged path it does not appear at all.
- **A backend cannot certify itself.** `provenance` is Bastion's statement, not the engine's. `parseEngineReviewResult` strips any `provenance` that arrives on the wire, and the adapter that fetched the result stamps its own immediately afterwards.
- **The contract is enforced by a validator, not by a key check.** `packages/mcp-server/test/schema-conformance.test.ts` validates every tool call and every tool result, on both the judged and the unjudged path, against the schemas `tools/list` actually advertises, with Ajv in Draft 2020-12 mode. A presence check cannot see a field the payload emits and the schema does not declare; a validator can, and every output schema in the catalog sets `additionalProperties: false`. Validating the calls too is what catches the opposite failure, a published schema that rejects a call the server accepts.

Where to verify each of these in the source: the stamps are minted in `packages/mcp-server/src/provenance.ts`, applied by `MockEngineClient` (`engine-client.ts`), `VerdictCliEngineClient` (`verdict-cli-engine.ts`), `VerdictJobEngineClient` (`verdict-job-engine.ts`) and `JudgmentEngineHttpClient` (`engine-http-client.ts`); the suppression rule is enforced in one place per payload, `mapEngineResultToCritique` (`critique-map.ts`) for reviews and `mapEngineRecheckToRecheck` (`recheck-map.ts`) for rechecks, through which every path into a `Critique` or a `Recheck` runs, plus `handlePanelAction` (`panel-interaction.ts`) for the routed fix; the wire strip is in `parseEngineReviewResult` (`engine-result.ts`); the field is required by `schemas/mcp-tools.json`; and `packages/mcp-server/test/provenance.test.ts` asserts, over the real MCP transport and against the round-tripped JSON only, that a fixture-path payload is distinguishable from a model-backed one.

### Connect your own MCP client

The local server speaks MCP over stdio, which is what Claude Code, Cursor, Codex, and VS Code use for a local server:

```json
{
  "mcpServers": {
    "apature-review-local": {
      "command": "node",
      "args": ["/absolute/path/to/bastion/packages/mcp-server/dist/local-stdio.js"]
    }
  }
}
```

`pnpm demo` spawns exactly that command and completes a real handshake against it, so the command is verified here; registration differs per client.

The only host the local server authorizes is `preview.example.com`; every other host is rejected as `DOMAIN_UNVERIFIED`. Add your own, and the critique backend, through the environment, with no code change and no rebuild:

```json
{
  "mcpServers": {
    "apature-review": {
      "command": "node",
      "args": ["/absolute/path/to/bastion/packages/mcp-server/dist/local-stdio.js"],
      "env": {
        "BASTION_ALLOWED_HOSTS": "preview.mycompany.com",
        "VERDICT_CLI": "/absolute/path/to/verdict",
        "MODEL_BASE_URL": "https://your-openai-compatible-endpoint/v1",
        "MODEL_API_KEY": "..."
      }
    }
  }
}
```

Without `VERDICT_CLI` the target is authorized for real and then judged from a fixture, which tells you nothing about your page. The next section is how to set it up.

## Getting real judgments

With nothing configured, the findings are a fixture about a fictional pricing page. This section replaces that with a real critique of a real page. It needs no credentials from this project, no database, and no hosted service.

The backend is [apatureai/verdict](https://github.com/apatureai/verdict), which is public and MIT. It launches headless Chromium, captures each route at each viewport, measures the DOM, critiques the render against your repository's own design system, deletes every finding it cannot point at, and writes an `EngineReviewResult`. That is the exact contract `packages/mcp-types/src/engine.ts` declares and this server consumes, so connecting them is configuration rather than code.

### 1. Build verdict

```bash
git clone https://github.com/apatureai/verdict.git
cd verdict
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm browser:install     # Chromium for playwright-core, roughly 275 MB downloaded
```

### 2. Point bastion at it

```bash
export VERDICT_CLI=/absolute/path/to/verdict
export MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
export MODEL_API_KEY=<your-key>
```

`VERDICT_CLI` selects the backend. `MODEL_BASE_URL` and `MODEL_API_KEY` are verdict's own variables and are passed straight through to it, so any OpenAI-compatible chat-completions endpoint that accepts images works: DashScope compatible mode, a self-hosted vLLM or SGLang server, anything speaking that wire format. The endpoint is never guessed, and a key without a base URL is a startup error rather than a silent fallback.

With a key set, verdict runs `--model live` and a model looks at your screenshots. Without one it runs `--model canned`, which captures and measures your page for real but judges nothing. Both states are announced, and the second one is announced loudly.

### 3. Review a URL

```bash
pnpm review https://preview.mycompany.com/pricing --routes /pricing --viewports desktop
```

`pnpm review` is the same MCP client `pnpm demo` uses, pointed at a target you choose: it spawns the local stdio server exactly as a coding agent would, so there is no private path here that your own MCP client does not get. The host you name on the command line is authorized for that run, and the CLI says so before it starts.

Here is a complete run against a public page, with `VERDICT_MODEL=mock` so it needs no key. Capture, measurement, and the artifacts are real; only the critique is not, which is what every line about it says:

```console
$ VERDICT_CLI=~/src/verdict VERDICT_MODEL=mock pnpm review https://example.com/ --viewports desktop

bastion: reviewing https://example.com/
  engine: VERDICT CLI engine: /Users/you/src/verdict/packages/cli/dist/main.js, --model mock. Capture and measurement are real, but NO MODEL JUDGES THE PAGE (no VERDICT_CONTEXT_DIR: the critique is not grounded in a design system); the grade and findings are verdict's mock client. Set MODEL_BASE_URL and MODEL_API_KEY for a real critique.
  authorizing example.com for this run because you named it on the command line
mcp-review local server ready on stdio
  engine: VERDICT CLI engine: /Users/you/src/verdict/packages/cli/dist/main.js, --model mock. ...
  authorized hosts: preview.example.com, example.com
verdict: reviewing https://example.com (/) -> /Users/you/src/bastion/out/verdict/1786369474801-cli-1786369474771
verdict| judgment-engine — reviewing https://example.com
verdict|   MOCK model client — deterministic, empty critique. No network call.
verdict|   launching Chromium…
verdict|   capturing 1 route(s) × 1 viewport(s)…
verdict|   running triage + deep pass…
verdict|
verdict| Capture
verdict|   1 screenshot(s) written to out/verdict/1786369474801-cli-1786369474771/screenshots
verdict|   2 DOM element(s) recorded in the geometry map
verdict|   page health: clean
verdict|
verdict| Measured facts  (computed from the captured DOM, no model involved)
verdict|   1 measurement(s) (touch_target 1) over 1 distinct element(s)
verdict|
verdict|    1. [touch_target] / body > div > p:nth-of-type(2) > a (desktop)
verdict|       touch target 82x18px is below 44x44px
verdict|
verdict| Done in 1.5s.

Review rev_c9c18398-faba-41c5-8361-b8b63d54453e  grade unjudged
  judged by: verdict-cli (source canned, model_backed false)
  No model judged this page, so there is no assessment of it: verdict ran with --model mock: capture and measurement were real, but the grade, the narrative and any findings came from verdict's stand-in client rather than from a model. Any findings below are not observations of the target.

  no findings

  not reviewed: [bastion] no model judged this page: verdict ran with --model mock: capture and measurement were real, but the grade, the narrative and any findings came from verdict's stand-in client rather than from a model. The grade is reported as "unjudged" and nothing in this result is a judgment of the target. See the README section "Getting real judgments" to configure a critique backend.

Wrote /Users/you/src/bastion/out/review.json
Wrote /Users/you/src/bastion/out/panel.html

NOTHING ABOVE JUDGED YOUR PAGE. VERDICT CLI engine: ... --model mock. ...
The same fact is in the JSON: provenance.model_backed is false and grade is "unjudged".
See the README section "Getting real judgments" to configure a critique backend.
```

**Success looks like** verdict's own capture report streaming past, a screenshot count that matches your routes times viewports, and a `Review` block. Swap `VERDICT_MODEL=mock` for a real `MODEL_API_KEY` and the closing warning disappears, `provenance.model_backed` becomes `true`, a real grade is printed in place of `unjudged`, and the findings are about your page. The per-run artifact directory under `out/verdict/` keeps the screenshots, the DOM geometry map, the measured facts, and the resolved system prompt, so a finding can be checked against what the model was actually shown.

The SSRF boundary is not relaxed for local use. A host that resolves to a private or loopback address is refused before verdict is even started:

```console
$ pnpm review https://localtest.me/

rejected: DNS_TARGET_PROHIBITED
  host localtest.me resolves to a prohibited (loopback) address
```

That is also why there is no way to review `http://localhost:3000` through this server: targets must be https, must not be IP literals, and must resolve to public addresses. Point it at a preview deployment. To review a local dev server, use verdict's own CLI directly, which has no such boundary because it has no tenants.

### What each mode gives you

| | fixture (default) | verdict CLI, no key | verdict CLI, live model |
|---|---|---|---|
| Configuration | none | `VERDICT_CLI` | `VERDICT_CLI` + `MODEL_BASE_URL` + `MODEL_API_KEY` |
| Screenshots of your page | no | yes | yes |
| DOM measurements of your page | no | yes | yes |
| Findings about your page | no | no | yes |
| Grade in the payload | `"unjudged"` | `"unjudged"` | the engine's grade |
| `provenance.model_backed` | `false` | `false` | `true` |
| Cost | none | none | your endpoint's per-call price |
| `design_recheck` | yes, but every outcome is `"unjudged"` | no, see below | no, see below |

### Configuring the backend

| Variable | Effect |
|---|---|
| `BASTION_ENGINE` | `auto` (default), `fixture`, `verdict-cli`, `verdict-http`. `auto` picks the CLI backend when `VERDICT_CLI` is set, then the job API when `ENGINE_BASE_URL` is set, then the fixture |
| `VERDICT_CLI` | Path to a built verdict checkout, or directly to its `packages/cli/dist/main.js`. Selects the CLI backend |
| `VERDICT_MODEL` | `auto` (default), `mock`, `canned`, `live`. `auto` is live when `MODEL_API_KEY` is set, canned otherwise, which is verdict's own rule |
| `VERDICT_CONTEXT_DIR` | Directory holding `tokens.json`, `.designreview.yml` and `package.json`, which is what grounds the critique in your design system. Without it the critique is ungrounded, not broken |
| `VERDICT_OUT_DIR` | Where per-review artifact directories are written. Default `out/verdict` under the working directory |
| `VERDICT_TIMEOUT_MS` | Ceiling on one review. Default 900000, fifteen minutes |
| `MODEL_BASE_URL`, `MODEL_API_KEY` | Verdict's variables, passed through unchanged |
| `BASTION_ALLOWED_HOSTS` | Comma-separated hosts to authorize besides the demo host. `pnpm review` adds the host you name on the command line |
| `ENGINE_BASE_URL`, `ENGINE_HMAC_SECRET`, `ENGINE_INSTALLATION_ID` | A running verdict job API instead of the CLI. See below |

Half-configured states fail at startup rather than degrading to fixtures: a base URL with no signing secret, a live model with no endpoint, an unbuilt verdict checkout, and an unknown mode name each stop the server with the reason.

### What is not wired yet

**`design_recheck` reports `"unjudged"` on the fixture path, and does not work against either verdict backend.** The fixture engine derives each outcome from a hash of the finding id, so the recheck payload says so: `outcome` is `"unjudged"`, `confidence` is `null`, and `provenance.model_backed` is `false`. It exercises the recheck protocol, the budgets and the rate limits; it tells you nothing about your page.

**`design_recheck` does not work against either verdict backend.** Verdict exposes no per-finding recheck, over the CLI or over its job API. Bastion could re-review the target and guess which findings matched, but a guess presented as a per-finding verdict is worse than an error, so both adapters refuse with that reason and `design_recheck` stays usable only against the fixture engine. The seam to fill is `EngineClient.recheck` in `src/engine-client.ts`, and the honest implementation needs a recheck surface upstream.

**The verdict job API backend has never been run against a real verdict deployment.** `src/verdict-job-engine.ts` speaks the documented contract (`POST /jobs`, `GET /jobs/:id`, `DELETE /jobs/:id`, the same `x-gate-signature` / `x-gate-installation` / `x-gate-timestamp` signing over the same canonical string, the same `x-schema-version` gate) and is tested against a stub, but verdict's long-running service additionally requires a `CAPTURE_ENDPOINT` capture fleet that verdict does not implement. Until that exists the CLI backend is the one that produces judgments, which is why `auto` prefers it.

**The live model path has not been exercised from this repository.** Everything up to and including the `--model live` command line is under test, and `MODEL_BASE_URL` / `MODEL_API_KEY` reach verdict unchanged, but the end-to-end runs recorded here used verdict's mock client, because this repository has no endpoint credentials. The live client itself is verdict's code and is covered by verdict's tests.

**Reviews block for as long as capture takes.** The local server runs the backend synchronously inside the `design_review` tool call, so a deep review of several routes can hold that call open for minutes. The durable submit-and-poll path that solves this exists in `review-service.ts` and is used by the HTTP composition root; the local server does not use it.

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
- Authorizes every target before it would ever be fetched: HTTPS-only canonicalization, an ownership-verified host allowlist, and full IP-range egress classification with DNS-rebind rejection.
- Carries the Streamable HTTP edge for the same tools: OAuth 2.1 resource-server auth, per-client transport isolation, and a Postgres application plane. The suite exercises that edge end to end over real HTTP and, with `MCP_TEST_DATABASE_URL`, real Postgres.

## What it deliberately does not do

- **It never edits code.** No patching, committing, pushing, opening pull requests, or driving a browser. It returns judgments and evidence; the agent on the other end does the work. The server is the eyes, the agent is the hands.
- **It does not screenshot anything itself and it does not call a model itself.** Capture and inference sit behind the engine boundary, in the public sibling [apatureai/verdict](https://github.com/apatureai/verdict): it drives headless Chromium for real captures and calls an OpenAI-compatible endpoint configured with `MODEL_BASE_URL` / `MODEL_API_KEY`. This server now runs that engine when you configure it and consumes its result; it does not reimplement either half. See [Getting real judgments](#getting-real-judgments).
- **It does not judge the URL you pass until you configure a backend.** With nothing set, the findings come from a golden fixture describing a fictional pricing page, and every entry point says so before it prints them.

## Why this is technically interesting

Most MCP servers are thin wrappers: one tool call maps to one function call, returns in milliseconds, and trusts its arguments. A design reviewer breaks all three assumptions, and most of the interesting code is the consequence.

**Long work behind a short-timeout protocol.** Browser capture across several routes and viewports plus multimodal inference routinely takes minutes. MCP clients do not wait that long (Codex documents a 60-second default tool timeout) and Streamable HTTP sessions drop. So the tool surface is a submit-and-poll job API rather than a blocking call. Job state lives in Postgres, keyed by tenant, entirely independent of the MCP session: a client can disconnect, reconnect against a different replica, and recover its job by id. Tool calls are idempotent on a caller-supplied `client_request_id`, enforced by a `(tenant_id, client_request_id)` unique constraint, so a retried submit after a dropped connection returns the original job (`reused: true`) instead of billing a second review. Reusing that key with different arguments is an explicit `IDEMPOTENCY_CONFLICT`, never a silent overwrite.

**"Fetch this URL for me" is an SSRF primitive.** A tool that accepts a URL from an agent and loads it server-side is a confused deputy. `target-auth.ts` and `egress.ts` are the defense, in layers: the URL is canonicalized (HTTPS only, no userinfo, no fragment, IDNA-normalized host, default port dropped, raw IP literals rejected); the host must appear in the tenant's ownership-verified registry, so a valid token cannot capture a host the tenant does not own; every address the host resolves to is classified against a denylist (loopback, RFC 1918, link-local, the `169.254.169.254` cloud-metadata address, multicast, reserved, NAT64-embedded IPv4, 6to4, CGNAT); and a mixed answer set (some public, some private) is rejected as a DNS-rebind attempt rather than partially allowed. Failures collapse to a single `DNS_TARGET_PROHIBITED` code, so the response never tells the caller which internal address resolved. `egress.ts` is pure and dependency-free by design: it never touches the network, it only classifies addresses a resolver already produced, which makes it exhaustively testable.

**Page content is data, never instruction.** The server reads a preview an attacker may control. Nothing captured from the page becomes server instructions, a tool description, an authorization decision, or a new tool call. In the review panel every page-derived string is HTML-escaped and evidence is embedded as a `data:` URI, so the panel fetches nothing.

**Per-client protocol isolation.** MCP SDK server and transport instances are mutable and are never shared across clients or tenants. Each connection gets its own short-lived adapter pair over one shared, protocol-neutral application store, so a transport-layer bug cannot leak state between tenants. The HTTP edge enforces its own limits before the SDK sees a request: declared and streamed body size, body-read timeout, media type, and in-flight requests per principal, each with a distinct counted rejection reason.

**Cancellation that cannot be raced.** A review job has two identities: the MCP-facing product job id and the engine's own job id. The application record stores both, and cancel/poll calls use the engine id. Completion and cancellation share a single store transaction as their linearization point, so a result arriving after a cancellation wins cannot overwrite it.

**Migrations that survive concurrent replicas.** Every boot opens one transaction, takes a product-scoped Postgres advisory lock, and only then reads migration state; the lock, the pending DDL, and the tracking inserts all share that transaction, so racing replicas serialize and a killed runner rolls back cleanly. Applied migrations are pinned by SHA-256: historical files are immutable after first adoption, and a mismatch fails startup. An older image tolerates an unknown newer checksum-pinned id, which is what makes rolling rollback safe. Tables are tenant-keyed with RLS; the adapter binds `app.tenant_id` inside every transaction and the role must not hold `BYPASSRLS`.

**Multimodal results with an honest downgrade.** A design review's most useful output is a picture. `multimedia-content.ts` shapes a critique into ordered MCP content blocks: the interactive panel first where the host supports MCP-Apps, then per-finding text, then annotated crops as image blocks. A host that cannot render images gets the identical text and structured findings plus an explicit `images_withheld` list of the evidence it is not seeing, never a broken block and never a silent drop. Image blocks are only emitted for evidence that actually exists with a real `image/*` MIME type; evidence is never fabricated to fill a slot.

**One published contract, served verbatim.** `tools/list` advertises `schemas/mcp-tools.json` itself: the catalog's own `inputSchema` and `outputSchema` per tool, read from that file and handed to the client unchanged. Previously the SDK derived a laxer input schema from the Zod shapes and advertised no output schema at all, so there were two published contracts and a client could not validate structured content for itself. Now the Zod shapes are only what the server *parses*, the catalog is only what a client is *told*, and `schema-conformance.test.ts` drives real calls through both and fails if they disagree. A test also performs a `tools/list` against a real server instance over an in-process transport and compares it to the catalog and to the `directory/server.json` registry listing, failing the build if any of the three disagree, including the version string.

## Tool surface

| Tool | Metered | What it does |
|---|---|---|
| `design_review` | yes | Submit an async review of an authorized HTTPS preview (routes, viewports, `triage`/`deep` depth). Returns a job. |
| `design_review_get` | no | Poll job status or read the result in one of five views. |
| `design_recheck` | yes | Re-judge 1 to 20 findings from a completed review after the agent changed the UI. Rejects a host change or an unchanged target. Runs against the fixture engine only, where every outcome comes back `"unjudged"`; see [What is not wired yet](#what-is-not-wired-yet). |
| `design_review_cancel` | no | Best-effort cancel of a queued or running job; requires the `reviews:cancel` scope. |
| `design_review_panel_action` | no | Route a review-panel interaction: return a grounded finding's fix for the agent, or the refs to re-verify. Returns `unjudged`, and no fix, when nothing judged the review. |

MCP annotations are set from the truth rather than from the marketing: only `design_review_get` and `design_review_panel_action` carry `readOnlyHint: true`, because submit and recheck create metered jobs and cancel terminates one. "Read-only" describes the customer's code, not every tool.

### `design_review_get` views

| `view` | Returns |
|---|---|
| `status` | The job envelope only. No result body, so it stays cheap while a job is still running. |
| `summary` (default) | Job plus the full `Critique`, including its `provenance`. |
| `findings` | Same body as `summary`; the `Critique` already carries every finding inline. |
| `focus` | Job plus the `Critique` narrowed to actionable findings: `blocker` and `should_fix`, with nits dropped. |
| `evidence` | Job, `Critique`, MCP content blocks (panel, text, images), and a `presentation` object naming what the host could not render. `presentation` is declared in the catalog's output schema, so a strict client validating against it accepts this view. |

### The eyes-not-hands boundary, in code

`design_review_panel_action` is where the product boundary is easiest to violate and easiest to test. A reviewer clicks "apply fix" on a finding; the server:

1. reads the completed `Critique` for that job;
2. projects it into fix items (`reviewFixItemsFromCritique`), where a finding is **grounded** only if it is localizable (`element_ref`) *and* carries a concrete repair constraint (`suggestion`); anything else is **advisory**;
3. runs the pure reducer (`handlePanelAction`).

A grounded finding comes back as `{ "type": "fix", "fix": "..." }`, and that fix is *for the host to hand to the coding agent*. An advisory finding comes back `{ "type": "human_only" }`, never an auto-fix. A finding from a review nothing judged comes back `{ "type": "unjudged" }` with no fix string in the payload at all, because on that path the instruction is fixture text and handing fixture text to a coding agent is precisely the failure this boundary exists to prevent. "Resolved" is a recheck verdict the service earns, not a status the panel can set.

## How it works

A `design_review` call in production mode:

```
HTTP edge (TLS, Host allowlist, body + in-flight limits)
  -> bearer JWT verified against the issuer's JWKS -> tenant + scopes
  -> per-client MCP adapter (never shared between clients)
  -> request normalization + idempotency fingerprint
  -> target authorization: canonicalize -> verified-host lookup -> DNS -> egress classification
  -> unit reservation -> durable job row
  -> HMAC-signed submit to the judgment engine
```

The client gets a `job_id` and a `poll_after_ms`, and polls `design_review_get`, which refreshes from the engine when a refresh is due and returns the completed `Critique`. Locally the same path runs against an in-memory store, synchronously: the job is already `completed` when submit returns. What answers there is the fixture engine by default, or a verdict backend when one is configured, behind the same `EngineClient` port.

A recheck adds: the prior review must exist and be completed; every requested finding id must belong to it; the target host must be unchanged; and the target fingerprint (URL plus `expected_revision`) must actually have changed, or it is rejected as `TARGET_UNCHANGED` without running judgment. Rejections and throttles both happen before any unit is reserved, so they cost nothing.

### What is real and what is synthetic offline

This is the unconfigured server, the one `pnpm demo` drives. [Getting real judgments](#getting-real-judgments) replaces the fixture findings and the withheld panel fix; the rows below say what each part does until then, and which of them a verdict backend does not change.

| Part | Offline behaviour |
|---|---|
| MCP protocol, tools, input validation, error taxonomy | Real |
| Target authorization, egress classification, DNS-rebind rejection | Real (runs on every submit) |
| Job lifecycle, idempotency, budgets, recheck rejection and throttling | Real |
| Views, content blocks, panel projection and reducer | Real |
| The findings themselves | **Fixture, and the payload says so.** A golden engine result about a fictional pricing page, not a judgment of the URL you passed: `provenance.model_backed` is `false`, the grade is `"unjudged"`, every finding carries `"unjudged": true`, and `not_reviewed[0]` discloses it. Set `VERDICT_CLI` and they are a real critique of your page. See [Provenance](#provenance-did-anything-judge-this-page) |
| What the run covered | **Real, and carried from the engine.** `coverage` and `hallucination_drops` are verdict's own fields, passed through rather than computed here. Against the fixture they describe the golden run's honest partial (`/pricing` reviewed, `/checkout` skipped). An engine that does not report coverage yields `state: "unstated"`, which is never read as "everything was reviewed". See [Coverage](#coverage-what-did-it-actually-look-at) |
| Recheck outcomes | **Fixture, and the payload says so.** Derived from a hash of the finding id, so every outcome is `"unjudged"` with a `null` confidence and a reason that claims no observation of your target. Not available against a verdict backend at all; see [What is not wired yet](#what-is-not-wired-yet) |
| A routed panel fix | **Withheld.** `design_review_panel_action` returns `unjudged` rather than handing fixture text to a coding agent |
| DNS | **Stub for the demo host only.** `preview.example.com` is answered from a constant so the demo makes no network call; every other host, including any you add, goes to the system resolver and is then classified for real |
| Evidence crops | **Placeholder.** Deterministic generated PNGs where the engine's annotated screenshots would be. Verdict's own screenshots are written to `out/verdict/<run>/screenshots` when a backend is configured |

## Running the HTTP server

`Dockerfile` builds the workspace and runs `packages/mcp-server/dist/boot.js`, the production composition root: Streamable HTTP transport, bearer JWT verification against an issuer's JWKS, a Postgres application plane, and a signed client for the judgment engine. It fails closed with a readable message when configuration is missing.

It boots, authenticates, persists, and migrates. It cannot complete a review until `ENGINE_BASE_URL` points at a judgment engine that speaks the `EngineJobClient` protocol (see [Status and roadmap](#status-and-roadmap)). The production root deliberately has no mock fallback: a server that answers with fixture judgments must be the local one, explicitly, never a misconfigured production one.

**There is no hosted endpoint, and no URL here to point a client at.** Nobody operates a public instance of this server, so `directory/server.json` declares no `remotes` at all rather than publishing a host that would not answer. If you deploy it, take the `ai.apature/self_hosted_remote_template` block out of that file's `_meta`, put your own host in it, and move it up into a real `remotes` array before submitting the listing anywhere. A test enforces that the checked-in listing stays remote-free while that is the truth.

### Configuration

Every variable below is read by the code. None are needed by the local server, the quickstart, or the test suite. The critique-backend variables are listed separately under [Configuring the backend](#configuring-the-backend); `ENGINE_BASE_URL` and `ENGINE_HMAC_SECRET` are shared by both surfaces.

| Variable | Required | Default | Effect |
|---|---|---|---|
| `MCP_RESOURCE_URL` | yes (HTTP mode) | none | This server's public resource id, the expected token `aud` |
| `MCP_AUTHORIZATION_SERVERS` | yes (HTTP mode) | none | Comma-separated issuer URLs published in RFC 9728 discovery |
| `MCP_JWKS_URL` | yes (HTTP mode) | none | Issuer JWKS endpoint used to verify token signatures |
| `MCP_TOKEN_ISSUER` | yes (HTTP mode) | none | Expected token `iss` |
| `DATABASE_URL` | yes (HTTP mode) | none | Postgres for durable jobs and the verified-target registry; migrations run at boot |
| `ENGINE_BASE_URL` | yes (HTTP mode) | none | Judgment engine async job API origin |
| `ENGINE_HMAC_SECRET` | yes (HTTP mode) | none | Shared secret signing service-to-service calls |
| `PORT` | no | `8080` | Listener port |
| `MCP_PATH` | no | `/mcp` | MCP endpoint path |
| `MCP_ALLOWED_HOSTS` | no | host of `MCP_RESOURCE_URL` | Permitted `Host` headers (DNS-rebinding defense) |
| `MCP_MAX_BODY_BYTES` | no | `262144` | Request body ceiling; hard maximum 1 MiB |
| `MCP_BODY_TIMEOUT_MS` | no | `30000` | Body-read timeout |
| `MCP_MAX_IN_FLIGHT_PER_PRINCIPAL` | no | `8` | Concurrent authenticated requests per principal; hard maximum 64 |
| `MCP_TEST_DATABASE_URL` | no | none | Test-only. When set, runs the Postgres migration test instead of skipping it |

## Repository map

```
packages/mcp-types/                boundary contracts, no runtime dependencies
  src/critique.ts                  agent-facing envelopes (Job, Budget, Critique, content blocks)
  src/engine.ts                    engine wire result + confidence/calibration types
  src/provenance.ts                the judgment-provenance contract (model_backed, source, engine)
  src/error.ts                     typed ReviewError contract (code, retriable, next_action)
  src/panel.ts                     MCP-Apps panel action/response contract
  fixtures/                        golden engine result, the offline judgment

packages/mcp-server/
  src/tools.ts                     Zod input schemas: what the server parses
  src/tool-catalog.ts              schemas/mcp-tools.json served verbatim: what tools/list advertises
  src/server.ts                    the five MCP tools, views, and typed error mapping
  src/local-server.ts              local composition root (fixture engine unless one is configured)
  src/local-stdio.ts               `mcp-review-local` process entrypoint (stdio transport)
  src/demo.ts                      the quickstart client: spawns the server, drives the loop
  src/review-cli.ts                `pnpm review <url>`: the same client, pointed at your target
  src/engine-runtime.ts            which critique backend this process runs, read from the env
  src/verdict-cli-engine.ts        backend: a local verdict checkout, driven through its CLI
  src/verdict-job-engine.ts        backend: a running verdict deployment, over its signed job API
  src/engine-result.ts             structural validation of a result that came from another program
  src/review-service.ts            job lifecycle, idempotency, budgets, recheck semantics
  src/normalize.ts                 request normalization and the idempotency fingerprint
  src/target-auth.ts               canonicalization, verified-host check, rebind rejection
  src/egress.ts                    pure IP classification (private/loopback/metadata/reserved)
  src/rate-limit.ts                recheck budgets, per-finding windows, backoff
  src/critique-map.ts              engine result -> agent-facing Critique, and the unjudged rule
  src/recheck-map.ts               engine recheck -> agent-facing Recheck, same unjudged rule
  src/provenance.ts                where every provenance stamp is minted, one module
  src/multimedia-content.ts        content-block shaping with capability downgrade
  src/panel-html.ts                the MCP-Apps panel document (escaped, self-contained)
  src/panel-findings.ts            Critique -> fix items -> PanelFindings
  src/panel-interaction.ts         the pure panel reducer (grounded -> agent, advisory -> human, unjudged -> nobody)
  src/evidence.ts                  EvidenceProvider seam, where annotated crops come from
  src/synthetic-evidence.ts        deterministic placeholder PNG encoder (offline evidence)
  src/http-server.ts               Streamable HTTP edge: PRM discovery, auth, limits, health
  src/auth.ts                      principal/scope derivation, RFC 9728 metadata
  src/jwt-verifier.ts              JWKS-backed JWT verification (jose)
  src/application-store.ts         ReviewApplicationStore port + in-memory adapter
  src/postgres-store.ts            tenant-scoped Postgres adapter
  src/pg.ts                        advisory-locked, checksum-pinned migration runner
  src/engine-client.ts             engine port + the deterministic fixture mock
  src/engine-http-client.ts        HMAC-signed async client for the judgment engine
  src/engine-cancel.ts             engine status -> MCP status, cancellation arbitration
  src/production*.ts, main.ts, boot.ts   composition root and HTTP entrypoint
  migrations/                      001_review_application.sql, 002_review_targets.sql (RLS)

schemas/                           machine-readable tool catalog, error and feedback schemas
directory/server.json              the MCP registry listing
```

Some source comments cite design documents by shorthand (`TRD §4.1`, `THREAT_MODEL T1`) and issue numbers from a private tracker. Those documents are not in this repository; the citations are left in place as provenance for the decisions they explain.

## Development

```console
$ pnpm test

 RUN  v4.1.10

 Test Files  35 passed | 1 skipped (36)
      Tests  337 passed | 2 skipped (339)
```

```bash
pnpm lint                                                  # eslint, warnings fail the build
pnpm typecheck                                             # tsc -b across project references
pnpm test packages/mcp-server/test/local-server.test.ts    # one file
pnpm demo                                                  # the fixture-backed protocol walkthrough
pnpm review <https url>                                    # one review through the configured backend
pnpm clean                                                 # remove build output
```

The skipped file is `packages/mcp-server/test/production-postgres.test.ts`, which exercises migration arbitration against a real database and only runs when `MCP_TEST_DATABASE_URL` is set. With one supplied the suite is 36 files / 330 tests, all passing:

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcp_review_test postgres:17-alpine

MCP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mcp_review_test pnpm test
```

That suite creates and drops its own schemas, so point it at a scratch database only.

Nothing in the suite touches a model, a browser, a subprocess, or the network: the engine is a fixture mock, the verdict backends are driven through their process and transport seams, DNS is stubbed or answered from a constant, and the Postgres application plane runs in-process against [PGlite](https://pglite.dev). `vitest.config.ts` raises the timeouts to 30s because a cold first run instantiates PGlite (WASM Postgres) inside a hook.

Both workspace packages are `private`; there is no published npm package yet. See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and how changes get reviewed.

## Status and roadmap

Working today, covered by the suite:

| Component | Notes |
|---|---|
| Local MCP server (stdio, offline) | `pnpm demo`, `pnpm start:local` |
| Real critique backend over a local verdict checkout | `pnpm review <url>`; see [Getting real judgments](#getting-real-judgments) |
| All five tools, five views, panel round trip | End to end in the quickstart |
| Target authorization + egress classification | Enforced by the local server too |
| Job lifecycle, idempotency, recheck semantics, budgets | Including zero-charge rejection paths |
| Streamable HTTP edge: OAuth 2.1 auth, limits, per-client isolation | Tested over real HTTP |
| Postgres application plane, RLS, migration arbitration | Tested against PGlite and real Postgres |

Known gaps, in rough priority order. Each names the seam to work against, and each is a reasonable first contribution.

**1. Finish the critique backend.** The main gap in earlier releases was that judgments were fixtures with no way to make them real. That is closed for reviews: `VERDICT_CLI` points this server at a local [apatureai/verdict](https://github.com/apatureai/verdict) checkout, verdict captures and critiques the page, and its `EngineReviewResult` flows through the same `EngineClient` port the fixture mock uses. See [Getting real judgments](#getting-real-judgments). Three pieces of that work are genuinely unfinished, and each is a good contribution:

- **`design_recheck` against a verdict backend.** Verdict has no per-finding recheck surface, over its CLI or its job API, so both adapters refuse rather than synthesizing outcomes. The seam is `EngineClient.recheck`; the honest fix starts upstream, with a recheck endpoint that re-captures the flagged elements.
- **Run the job API backend against a real verdict deployment.** `src/verdict-job-engine.ts` speaks the contract and is tested against a stub, but verdict's long-running service needs a `CAPTURE_ENDPOINT` capture fleet that verdict does not implement, so the two programs have never met over HTTP. Reporting where the shapes disagree, once one exists, is exactly the useful bug report.
- **Verify the live model path from here.** The `--model live` command line is under test and the endpoint variables are passed through unchanged, but the end-to-end runs recorded in this README used verdict's mock client, because this repository has no endpoint credentials.

**2. Screenshot capture.** Not implemented here, and still not planned to live here: capture belongs behind the engine boundary above, and it is already written there. `verdict` drives headless Chromium through playwright-core and produces deterministic screenshots plus a DOM geometry map, and with `VERDICT_CLI` set those screenshots land in `out/verdict/<run>/screenshots` on every review. What this repository still lacks is a way to serve them back through the MCP evidence view, which is item 3.

**3. Real evidence images.** `EvidenceProvider` in `src/evidence.ts` is the seam and it is documented; the only implementation is `SyntheticEvidenceProvider`, which emits deterministic placeholder PNGs (real bytes, no pixels of your page). This one got easier: with `VERDICT_CLI` configured, verdict writes the real screenshots to `out/verdict/<run>/screenshots` and stamps each finding's `screenshotId` with the key it wrote them under, so a provider that reads that directory is a self-contained, testable change that would put your own page into the evidence view and the panel.

**4. Move the recheck index and unit ledger into the store.** Job records persist to Postgres, but the recheck index and the tenant unit counter (a flat 1000 per `ReviewService`) live in memory on an instance constructed per MCP connection, so a recheck only resolves a review submitted on the same connection. The fix is to read the review back from `ReviewApplicationStore` and move the ledger into it. Well-scoped and high value for anyone actually deploying this.

**5. Domain-ownership verification.** `target-auth.ts` enforces the verified-host list and `002_review_targets.sql` stores it, but nothing here issues or checks the DNS / well-known / deployment proofs that put a row in that table; rows are expected pre-verified. A proof issuer is a clean standalone module.

**6. Engine-side view projections.** `design_review_get`'s `focus` and `evidence` views are projections of the local `Critique`. The original design also specified coverage counts, a paginated finding index, and `patchContext` for selected element refs, which were computed upstream. They could be computed here instead.

**7. Feedback events.** `schemas/feedback-event.schema.json` defines the contract; there is no writer in `src/`. Wiring one up is how the review loop learns which findings a team actually accepts.

**8. Metering beyond a single replica.** Units are reserved and consumed on job records. There is no payment integration and no cross-replica ledger.

**9. Stateless transport adapter.** The protocol baseline is `2025-11-25`. The design reserved room for a stateless `2026-07-28` adapter; it does not exist yet.

**10. MCP Tasks adapter.** `execution.taskSupport` is `forbidden` in the catalog, because application job ids were always the canonical handle. Exposing jobs as MCP Tasks as well is a compatible addition.

**11. `design_direction` tool.** Specified, deliberately deferred, still unimplemented.

**12. Track down one flaky run.** A single unidentified test failure appeared once in roughly 43 consecutive full-suite runs and has not reproduced since. If you see a red run on an unchanged commit, re-run before treating it as a regression, and if you can reproduce it, that is a genuinely useful bug report.

Two honesty notes that are not roadmap items so much as things to know.

**There are still no published quality numbers, so assume no measured accuracy claims.** The harness to produce them is no longer missing, though: it lives in [apatureai/verdict](https://github.com/apatureai/verdict) under `packages/eval`, which carries the canaries, the golden-set tooling, and the precision, recall and human-agreement metrics, and it declares the bars it grades against as `DEFAULT_QUALITY_BARS` in `packages/eval/src/quality-gate.ts`. What has not happened is a promoted candidate run, so neither repo publishes a results table. With `VERDICT_CLI` configured the judgments you get here are verdict's, which means any number measured there would describe them; there is simply no such number yet.

**The auth path has not had an external security review.** The OAuth 2.1 resource-server code, the token verifier and the SSRF boundary are covered by this repo's own tests and nothing more. See [SECURITY.md](SECURITY.md).

Some modules are exported from `packages/mcp-server/src/index.ts` and not yet reachable from either composition root (the HTTP evidence path, for instance). They are exported on purpose so a fork can compose them, and they are covered by unit tests, but treat "exported" as "available", not "wired".

## Contributing

Contributions are welcome, including small ones. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the test and lint commands, the conventions that matter (the eyes-not-hands boundary, the contract-tested tool catalog, golden fixtures), and how pull requests get reviewed. The roadmap items above are the best place to start; open an issue first if a change is large.

## Security

Report vulnerabilities privately through GitHub's private vulnerability reporting on the repository's Security tab. [SECURITY.md](SECURITY.md) describes supported versions, what a reporter can expect, and what to check before running this against a network you care about.

## License

MIT. See [LICENSE](LICENSE).
