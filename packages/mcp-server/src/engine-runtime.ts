import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { JudgmentProvenance } from "@apature/mcp-types";
import type { EngineClient } from "./engine-client.js";
import { MockEngineClient } from "./engine-client.js";
import { JudgmentEngineHttpClient } from "./engine-http-client.js";
import { VerdictCliEngineClient, type VerdictModelChoice } from "./verdict-cli-engine.js";
import { VerdictJobEngineClient } from "./verdict-job-engine.js";
import { FIXTURE_PROVENANCE, verdictCliProvenance, verdictHttpProvenance } from "./provenance.js";

/**
 * Which critique backend this process is running, resolved from the
 * environment.
 *
 * This mirrors `verdict`'s own `resolveModelRuntime`, on purpose: one function
 * reads the environment, refuses to guess anything it was not told, returns a
 * client plus a one-line description of what that client is, and every entry
 * point prints that description before doing any work. Verdict does it so you
 * can never mistake a canned critique for a model's; this does it so you can
 * never mistake a fixture judgment for a review of your page.
 *
 * The default is the offline fixture engine, so `pnpm demo` and the test suite
 * keep running with no configuration, no credentials and no network.
 */

export type EngineMode = "fixture" | "verdict_cli" | "verdict_http";

/** Raised when the environment is configured in a way that cannot be honoured. */
export class EngineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineConfigError";
  }
}

export interface EngineRuntime {
  mode: EngineMode;
  /**
   * The stamp this backend will attach to every result it produces. Holding it
   * here is what keeps the banner printed at startup and the `provenance` in
   * the payload from ever disagreeing: they are the same object.
   */
  provenance: JudgmentProvenance;
  /**
   * Whether a model that actually looked at the target produced the findings.
   * `false` for the fixture engine and for verdict's mock/canned clients;
   * `null` for a remote verdict deployment, whose model configuration this
   * process cannot see and must not claim to know. Always
   * `provenance.model_backed`, never computed separately.
   */
  modelBacked: boolean | null;
  /** One line, printed at startup. Says which client is live, always. */
  description: string;
  /** Build the client. Deferred so resolution can be inspected without side effects. */
  create(): EngineClient;
}

export interface ResolveEngineRuntimeOptions {
  /** Progress sink handed to the backend (verdict's capture takes minutes). */
  log?: (line: string) => void;
  /** Existence check seam, so tests do not need a verdict checkout on disk. */
  fileExists?: (path: string) => boolean;
}

const MODES: readonly string[] = ["auto", "fixture", "verdict-cli", "verdict-http"];
const MODEL_CHOICES: readonly string[] = ["auto", "mock", "canned", "live"];

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Resolve `VERDICT_CLI` to verdict's built CLI entry. It accepts either the
 * entry file itself or a verdict checkout root, because both are things a
 * person naturally has to hand, and it verifies the file exists: a missing
 * `dist/` means verdict was cloned but never built, and saying so at startup is
 * far better than failing inside the first review.
 */
export function resolveVerdictCliEntry(
  raw: string,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const base = isAbsolute(raw) ? raw : resolve(raw);
  const entry = base.endsWith(".js") ? base : join(base, "packages", "cli", "dist", "main.js");
  if (!fileExists(entry)) {
    throw new EngineConfigError(
      `VERDICT_CLI does not point at a built verdict CLI: ${entry} does not exist. ` +
        `Clone https://github.com/apatureai/verdict, run "pnpm install && pnpm build && pnpm browser:install" ` +
        `there, and set VERDICT_CLI to that checkout.`,
    );
  }
  return entry;
}

/**
 * Resolve which verdict model client a CLI-backed review will use, applying
 * verdict's own `auto` rule (live when `MODEL_API_KEY` is set, canned
 * otherwise) so the two programs never disagree about what is about to run.
 */
export function resolveVerdictModel(env: NodeJS.ProcessEnv): VerdictModelChoice {
  const requested = trimmed(env.VERDICT_MODEL) || "auto";
  if (!MODEL_CHOICES.includes(requested)) {
    throw new EngineConfigError(
      `VERDICT_MODEL must be one of ${MODEL_CHOICES.join(", ")} (got "${requested}")`,
    );
  }
  const choice = requested === "auto" ? (blank(env.MODEL_API_KEY) ? "canned" : "live") : requested;
  if (choice === "live" && blank(env.MODEL_BASE_URL)) {
    throw new EngineConfigError(
      "a live verdict review needs MODEL_BASE_URL as well as MODEL_API_KEY. " +
        "The endpoint is never guessed; set MODEL_BASE_URL to your OpenAI-compatible endpoint, " +
        "or set VERDICT_MODEL=canned to run the pipeline without a model.",
    );
  }
  return choice as VerdictModelChoice;
}

function fixtureRuntime(): EngineRuntime {
  return {
    mode: "fixture",
    provenance: FIXTURE_PROVENANCE,
    modelBacked: FIXTURE_PROVENANCE.model_backed,
    description:
      "FIXTURE engine: no critique backend configured. Findings are replayed from the golden " +
      "fixture and describe a fictional pricing page, NOT the URL you pass. Set VERDICT_CLI " +
      "(a built verdict checkout) for real judgments.",
    create: () => new MockEngineClient(),
  };
}

function verdictCliRuntime(
  env: NodeJS.ProcessEnv,
  options: ResolveEngineRuntimeOptions,
): EngineRuntime {
  const raw = trimmed(env.VERDICT_CLI);
  if (raw.length === 0) {
    throw new EngineConfigError(
      "BASTION_ENGINE=verdict-cli requires VERDICT_CLI, the path to a built verdict checkout " +
        "(or directly to its packages/cli/dist/main.js).",
    );
  }
  const entry = resolveVerdictCliEntry(raw, options.fileExists);
  const model = resolveVerdictModel(env);
  const contextDir = trimmed(env.VERDICT_CONTEXT_DIR);
  const outRoot = trimmed(env.VERDICT_OUT_DIR);
  const timeoutMs = positiveInt(env, "VERDICT_TIMEOUT_MS");

  const grounding = contextDir
    ? `, grounded against ${contextDir}`
    : " (no VERDICT_CONTEXT_DIR: the critique is not grounded in a design system)";
  const description =
    model === "live"
      ? `VERDICT CLI engine: ${entry}, --model live against ${trimmed(env.MODEL_BASE_URL)}. ` +
        `Real Chromium capture and a real model call${grounding}. Calls are billed to the owner of MODEL_API_KEY.`
      : `VERDICT CLI engine: ${entry}, --model ${model}. Capture and measurement are real, but NO ` +
        `MODEL JUDGES THE PAGE${grounding}; the grade and findings are verdict's ${model} client. ` +
        `Set MODEL_BASE_URL and MODEL_API_KEY for a real critique.`;

  const provenance = verdictCliProvenance(model);
  return {
    mode: "verdict_cli",
    provenance,
    modelBacked: provenance.model_backed,
    description,
    create: () =>
      new VerdictCliEngineClient({
        entry,
        model,
        env,
        ...(contextDir ? { contextDir } : {}),
        ...(outRoot ? { outRoot } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(options.log ? { log: options.log } : {}),
      }),
  };
}

function verdictHttpRuntime(
  env: NodeJS.ProcessEnv,
  options: ResolveEngineRuntimeOptions,
): EngineRuntime {
  const baseUrl = trimmed(env.ENGINE_BASE_URL);
  if (baseUrl.length === 0) {
    throw new EngineConfigError(
      "BASTION_ENGINE=verdict-http requires ENGINE_BASE_URL, the origin of a running verdict job API.",
    );
  }
  const secret = trimmed(env.ENGINE_HMAC_SECRET);
  if (secret.length === 0) {
    // Verdict verifies the signature on every request before doing any work, so
    // an unsigned client gets 401 on the first submit. Fail at startup instead.
    throw new EngineConfigError(
      "ENGINE_BASE_URL is set but ENGINE_HMAC_SECRET is not. Verdict rejects unsigned requests, " +
        "so set the shared secret, or unset ENGINE_BASE_URL to run the offline fixture engine.",
    );
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new EngineConfigError(`ENGINE_BASE_URL is not a valid absolute URL: ${baseUrl}`);
  }
  const installationId = trimmed(env.ENGINE_INSTALLATION_ID) || "local";
  const timeoutMs = positiveInt(env, "VERDICT_TIMEOUT_MS");

  const provenance = verdictHttpProvenance(baseUrl);
  return {
    mode: "verdict_http",
    provenance,
    // The deployment's model configuration is not visible from here, and
    // claiming it is live would be inventing a fact about someone else's
    // process.
    modelBacked: provenance.model_backed,
    description:
      `VERDICT SERVICE engine: HMAC-signed job API at ${baseUrl} as installation ${installationId}. ` +
      `Judgments come from that deployment; this process cannot see how its model is configured.`,
    create: () =>
      new VerdictJobEngineClient({
        jobs: new JudgmentEngineHttpClient({ baseUrl, hmacSecret: secret }),
        installationId,
        describeAs: baseUrl,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(options.log ? { log: options.log } : {}),
      }),
  };
}

function positiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = trimmed(env[key]);
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EngineConfigError(`${key} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/**
 * Read the environment and decide which critique backend to run.
 *
 * `BASTION_ENGINE` selects explicitly (`fixture`, `verdict-cli`,
 * `verdict-http`); the default `auto` picks the CLI backend when `VERDICT_CLI`
 * is set, then the job API when `ENGINE_BASE_URL` is set, and otherwise falls
 * back to the fixture engine. Half-configured states throw rather than
 * degrading quietly to fixtures: a run that was meant to be real and silently
 * was not is the exact failure this whole module exists to prevent.
 */
export function resolveEngineRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveEngineRuntimeOptions = {},
): EngineRuntime {
  const requested = trimmed(env.BASTION_ENGINE) || "auto";
  if (!MODES.includes(requested)) {
    throw new EngineConfigError(
      `BASTION_ENGINE must be one of ${MODES.join(", ")} (got "${requested}")`,
    );
  }
  if (requested === "fixture") return fixtureRuntime();
  if (requested === "verdict-cli") return verdictCliRuntime(env, options);
  if (requested === "verdict-http") return verdictHttpRuntime(env, options);

  if (!blank(env.VERDICT_CLI)) return verdictCliRuntime(env, options);
  if (!blank(env.ENGINE_BASE_URL)) return verdictHttpRuntime(env, options);
  return fixtureRuntime();
}
