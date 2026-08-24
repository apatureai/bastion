# @apatureai/bastion-types

Boundary contracts for [Apature Bastion](https://github.com/apatureai/bastion), an in-loop design-review MCP server. This package is the single source of truth for the agent-facing surface: the tool envelopes (`Job`, `Budget`, `Critique`, content blocks), the engine wire result and confidence types, the judgment-provenance contract (`model_backed`, `source`, `engine`), the typed `ReviewError` contract, the MCP-Apps panel action/response contract, and the golden engine fixture that stands in for a real critique offline.

It has no runtime dependencies. The types describe what a Bastion server emits and what a coding agent consumes; nothing here makes a network call, spawns a process, or touches a model.

## Install

```bash
npm install @apatureai/bastion-types
```

## Usage

```ts
import type { Critique, JudgmentProvenance } from "@apatureai/bastion-types";
import { loadGoldenEngineResult } from "@apatureai/bastion-types";

// The rule an agent codes against: trust a review only when a model judged it.
function isTrustworthy(review: Critique): boolean {
  return review.provenance.model_backed === true && review.coverage.state !== "nothing";
}
```

The golden fixture (`fixtures/`) is the same offline judgment `@apatureai/bastion` replays when no critique backend is configured; it describes a fictional pricing page and is stamped `model_backed: false`.

## License

MIT. See [LICENSE](LICENSE). Full documentation lives in the [bastion repository](https://github.com/apatureai/bastion#readme).
