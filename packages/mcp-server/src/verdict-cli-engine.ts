import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EngineRecheckResult, EngineReviewResult } from "@apature/mcp-types";
import type { EngineClient, EngineRecheckRequest } from "./engine-client.js";
import { EngineDependencyError } from "./engine-http-client.js";
import { parseEngineReviewResult } from "./engine-result.js";
import type { NormalizedReviewRequest } from "./normalize.js";

/**
 * Critique backend #1: a local `apatureai/verdict` checkout, driven through its
 * CLI.
 *
 * This is the seam that makes a judgment real. `MockEngineClient` replays a
 * golden fixture about a fictional pricing page; this implements the same
 * `EngineClient` interface by running verdict's `packages/cli/dist/main.js`,
 * which launches Chromium, captures the target, measures the DOM, runs the
 * grounded critique, and writes an `EngineReviewResult` to `review.json`. That
 * file is the exact contract in `@apature/mcp-types`, so nothing here reshapes
 * a judgment; it validates the payload and hands it to the same mapper the
 * fixture path uses.
 *
 * Why the CLI and not verdict's HTTP job API: both are wired (see
 * `verdict-job-engine.ts`), but verdict's long-running service requires a
 * `CAPTURE_ENDPOINT` capture fleet that repository does not implement, while
 * its CLI captures in-process. The CLI is therefore the backend a stranger can
 * actually stand up today, with no database, no object store, and no fleet.
 *
 * What this adapter does NOT do:
 *   - it never edits code or drives the UI; it runs a read-only reviewer;
 *   - it does not forward `depth`. Verdict's CLI has no depth flag and always
 *     runs its triage plus deep pass, so a `triage` request is served by the
 *     deep path rather than silently mislabelled as cheaper;
 *   - it does not implement `recheck`. Verdict exposes no per-finding recheck,
 *     and inventing pass/fail by matching finding titles across two model runs
 *     would be a guess presented as a verdict. `design_recheck` therefore fails
 *     with a precise reason against this backend.
 */

/** The verdict model client this run asks for. `auto` is resolved before here. */
export type VerdictModelChoice = "mock" | "canned" | "live";

/** One child-process run, as this adapter needs it. A seam, so tests never spawn. */
export type ProcessRunner = (spec: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Called per line of child stderr, so a multi-minute capture is not silent. */
  onLog?: (line: string) => void;
}) => Promise<ProcessResult>;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface VerdictCliEngineOptions {
  /** Absolute path to verdict's built CLI entry (`packages/cli/dist/main.js`). */
  entry: string;
  /** Which verdict model client to run. Only `live` means a model saw the page. */
  model: VerdictModelChoice;
  /** Directory holding tokens.json / .designreview.yml / package.json for grounding. */
  contextDir?: string;
  /** Where per-review artifact directories are created. Default `<cwd>/out/verdict`. */
  outRoot?: string;
  /** Hard ceiling on one review. Default 15 minutes; capture plus two passes is slow. */
  timeoutMs?: number;
  /** Node binary used to run the CLI. Default this process's own. */
  nodePath?: string;
  /** Environment handed to the child; `MODEL_BASE_URL`/`MODEL_API_KEY` flow through it. */
  env?: NodeJS.ProcessEnv;
  /** Progress sink. Default: nothing. `local-stdio.ts` points this at stderr. */
  log?: (line: string) => void;
  run?: ProcessRunner;
}

/**
 * The disclosure this adapter adds to `notReviewed` when verdict ran without a
 * live model. Verdict's own terminal report refuses to print a grade in that
 * state, because `review.json` still carries a `grade` field that nothing
 * judged. Bastion's agent-facing surface has no such refusal, so the fact
 * travels with the result instead: an agent reading `not_reviewed` sees, in the
 * payload itself, that no model looked at this page. It is prefixed so it is
 * unmistakably added by this adapter and not by the engine.
 */
export function noModelDisclosure(model: VerdictModelChoice): string {
  return (
    `[bastion] no model judged this page: verdict ran with --model ${model}. ` +
    `The grade and any findings in this result are not a judgment of the target. ` +
    `Set MODEL_BASE_URL and MODEL_API_KEY and run with VERDICT_MODEL=live for a real critique.`
  );
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Keep the tail of child output; a failed capture can print a lot. */
function tail(text: string, limit = 2_000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `...${trimmed.slice(-limit)}`;
}

/** A filesystem-safe directory name for one review's artifacts. */
function artifactSlug(clientRequestId: string, startedAt: number): string {
  const safe = clientRequestId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "review";
  return `${startedAt}-${safe}`;
}

/** Default runner: spawn the CLI, stream its stderr to `onLog`, enforce the timeout. */
export const spawnProcessRunner: ProcessRunner = (spec) =>
  new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command, [...spec.args], {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Verdict writes its progress report to stdout; forward it line by line so a
    // long capture shows movement rather than looking hung.
    let pending = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) spec.onLog?.(line);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pending.length > 0) spec.onLog?.(pending);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });

export class VerdictCliEngineClient implements EngineClient {
  private readonly run: ProcessRunner;
  private readonly timeoutMs: number;
  private readonly nodePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly outRoot: string;
  private readonly log: (line: string) => void;

  constructor(private readonly options: VerdictCliEngineOptions) {
    this.run = options.run ?? spawnProcessRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nodePath = options.nodePath ?? process.execPath;
    this.env = options.env ?? process.env;
    this.outRoot = options.outRoot ?? resolve(process.cwd(), "out", "verdict");
    this.log = options.log ?? ((): void => undefined);
  }

  async review(request: NormalizedReviewRequest): Promise<EngineReviewResult> {
    // Verdict takes a base URL plus root-relative routes. Bastion's normalized
    // request already carries routes separately, so the target's own path is not
    // appended twice; the origin is the base.
    const base = new URL(request.url).origin;
    const outDir = join(this.outRoot, artifactSlug(request.client_request_id, Date.now()));
    await mkdir(outDir, { recursive: true });

    const args = [
      this.options.entry,
      "--url",
      base,
      "--routes",
      request.routes.join(","),
      "--viewports",
      request.viewports.join(","),
      "--out",
      outDir,
      "--model",
      this.options.model,
      ...(this.options.contextDir ? ["--context-dir", this.options.contextDir] : []),
    ];

    this.log(`verdict: reviewing ${base} (${request.routes.join(", ")}) -> ${outDir}`);
    let result: ProcessResult;
    try {
      result = await this.run({
        command: this.nodePath,
        args,
        env: this.env,
        timeoutMs: this.timeoutMs,
        onLog: (line) => this.log(`verdict| ${line}`),
      });
    } catch (error) {
      throw new EngineDependencyError(
        `could not run the verdict CLI at ${this.options.entry}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (result.timedOut) {
      throw new EngineDependencyError(
        `the verdict CLI did not finish within ${this.timeoutMs}ms; artifacts (if any) are in ${outDir}`,
      );
    }
    if (result.code !== 0) {
      throw new EngineDependencyError(
        `the verdict CLI exited ${String(result.code)}: ${tail(result.stderr || result.stdout)}`,
      );
    }

    const resultPath = join(outDir, "review.json");
    let raw: string;
    try {
      raw = await readFile(resultPath, "utf8");
    } catch {
      throw new EngineDependencyError(
        `the verdict CLI exited 0 but wrote no ${resultPath}; nothing was judged`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new EngineDependencyError(
        `${resultPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const reviewResult = parseEngineReviewResult(parsed, resultPath);
    if (this.options.model === "live") return reviewResult;
    return {
      ...reviewResult,
      notReviewed: [noModelDisclosure(this.options.model), ...reviewResult.notReviewed],
    };
  }

  /**
   * Not available from this backend. Verdict's CLI reviews a target; it has no
   * per-finding recheck, and deriving one by re-reviewing and matching titles
   * across two model runs would be a guess dressed as a verdict. Failing here
   * keeps `design_recheck` honest: it reports that the configured engine cannot
   * recheck, rather than returning a fabricated outcome.
   */
  async recheck(_request: EngineRecheckRequest): Promise<EngineRecheckResult> {
    throw new EngineDependencyError(
      "the verdict CLI backend cannot recheck individual findings: verdict exposes no recheck " +
        "surface. Submit a new design_review against the changed target instead.",
    );
  }
}
