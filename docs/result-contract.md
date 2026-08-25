Part of [bastion](../README.md). Moved from the README on 2026-08-24; anchors preserved.

This file holds the full result-contract detail that used to sit under Provenance and Coverage in the README: how grounding, measurements, and every agent-read payload carry the provenance marker. The condensed [Provenance](../README.md#provenance-did-anything-judge-this-page) and [Coverage](../README.md#coverage-what-did-it-actually-look-at) sections stay in the README.

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
- **The contract is enforced by a validator, not by a key check.** `packages/mcp-server/test/schema-conformance.test.ts` validates every tool call and every tool result, on both the judged and the unjudged path, against the schemas `tools/list` actually advertises, with Ajv in Draft 2020-12 mode. A presence check cannot see a field the payload emits and the schema does not declare; a validator can, and every output schema in the catalog sets `additionalProperties: false`. Validating the calls too is what catches the opposite failure, a published schema that rejects a call the server accepts. That still only checks calls this repository writes, so `schema-permissiveness.test.ts` covers the remaining direction: it generates a matrix of inputs from the advertised `inputSchema` itself, using the schema's own enum members and its declared length and item bounds, and fails if the server's parser rejects any of them. A catalog that promises more than the code honours is the failure a client hits and the repository never would.

Where to verify each of these in the source: the stamps are minted in `packages/mcp-server/src/provenance.ts`, applied by `MockEngineClient` (`engine-client.ts`), `VerdictCliEngineClient` (`verdict-cli-engine.ts`), `VerdictJobEngineClient` (`verdict-job-engine.ts`) and `JudgmentEngineHttpClient` (`engine-http-client.ts`); the suppression rule is enforced in one place per payload, `mapEngineResultToCritique` (`critique-map.ts`) for reviews and `mapEngineRecheckToRecheck` (`recheck-map.ts`) for rechecks, through which every path into a `Critique` or a `Recheck` runs, plus `handlePanelAction` (`panel-interaction.ts`) for the routed fix; the wire strip is in `parseEngineReviewResult` (`engine-result.ts`); the field is required by `schemas/mcp-tools.json`; and `packages/mcp-server/test/provenance.test.ts` asserts, over the real MCP transport and against the round-tripped JSON only, that a fixture-path payload is distinguishable from a model-backed one.
