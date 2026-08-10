import { describe, expect, it } from "vitest";
import { MockEngineClient } from "../src/engine-client.js";
import {
  EngineConfigError,
  resolveEngineRuntime,
  resolveVerdictCliEntry,
  resolveVerdictModel,
} from "../src/engine-runtime.js";
import { VerdictCliEngineClient } from "../src/verdict-cli-engine.js";
import { VerdictJobEngineClient } from "../src/verdict-job-engine.js";

/**
 * Which critique backend the process runs, resolved from the environment.
 *
 * This is the module that decides whether a user is about to read a judgment or
 * a fixture, so the tests are about exactly two things: the default is offline
 * and needs nothing, and every half-configured state fails loudly instead of
 * quietly degrading to fixture judgments while looking configured.
 */

const exists = (): boolean => true;
const missing = (): boolean => false;

describe("resolveEngineRuntime", () => {
  it("defaults to the fixture engine with an empty environment", () => {
    const runtime = resolveEngineRuntime({}, { fileExists: exists });
    expect(runtime.mode).toBe("fixture");
    expect(runtime.modelBacked).toBe(false);
    expect(runtime.create()).toBeInstanceOf(MockEngineClient);
    // The description has to say so without being read carefully.
    expect(runtime.description).toContain("FIXTURE engine");
    expect(runtime.description).toContain("NOT the URL you pass");
  });

  it("selects the verdict CLI backend when VERDICT_CLI is set", () => {
    const runtime = resolveEngineRuntime(
      { VERDICT_CLI: "/verdict", MODEL_API_KEY: "k", MODEL_BASE_URL: "https://api.example/v1" },
      { fileExists: exists },
    );
    expect(runtime.mode).toBe("verdict_cli");
    expect(runtime.modelBacked).toBe(true);
    expect(runtime.create()).toBeInstanceOf(VerdictCliEngineClient);
    expect(runtime.description).toContain("--model live");
    expect(runtime.description).toContain("https://api.example/v1");
  });

  it("says loudly when the CLI backend will run without a model", () => {
    const runtime = resolveEngineRuntime({ VERDICT_CLI: "/verdict" }, { fileExists: exists });
    expect(runtime.modelBacked).toBe(false);
    expect(runtime.description).toContain("--model canned");
    expect(runtime.description).toContain("NO MODEL JUDGES THE PAGE");
  });

  it("selects the verdict job API when only ENGINE_BASE_URL is configured", () => {
    const runtime = resolveEngineRuntime(
      { ENGINE_BASE_URL: "https://engine.example", ENGINE_HMAC_SECRET: "s" },
      { fileExists: exists },
    );
    expect(runtime.mode).toBe("verdict_http");
    // A remote deployment's model configuration is not visible from here, and
    // claiming it is live would be inventing a fact about someone else's process.
    expect(runtime.modelBacked).toBeNull();
    expect(runtime.create()).toBeInstanceOf(VerdictJobEngineClient);
  });

  it("prefers the CLI backend when both are configured", () => {
    const runtime = resolveEngineRuntime(
      { VERDICT_CLI: "/verdict", ENGINE_BASE_URL: "https://engine.example", ENGINE_HMAC_SECRET: "s" },
      { fileExists: exists },
    );
    expect(runtime.mode).toBe("verdict_cli");
  });

  it("honours an explicit BASTION_ENGINE=fixture over a configured backend", () => {
    const runtime = resolveEngineRuntime(
      { BASTION_ENGINE: "fixture", VERDICT_CLI: "/verdict" },
      { fileExists: exists },
    );
    expect(runtime.mode).toBe("fixture");
  });

  it("rejects an unknown BASTION_ENGINE", () => {
    expect(() => resolveEngineRuntime({ BASTION_ENGINE: "verdict" })).toThrow(EngineConfigError);
    expect(() => resolveEngineRuntime({ BASTION_ENGINE: "verdict" })).toThrow(
      /auto, fixture, verdict-cli, verdict-http/,
    );
  });

  it("refuses an unsigned job API rather than failing on the first submit", () => {
    expect(() => resolveEngineRuntime({ ENGINE_BASE_URL: "https://engine.example" })).toThrow(
      /ENGINE_HMAC_SECRET/,
    );
  });

  it("refuses a job API base that is not a URL", () => {
    expect(() =>
      resolveEngineRuntime({ ENGINE_BASE_URL: "engine.example", ENGINE_HMAC_SECRET: "s" }),
    ).toThrow(/not a valid absolute URL/);
  });

  it("requires VERDICT_CLI when the CLI backend is asked for explicitly", () => {
    expect(() => resolveEngineRuntime({ BASTION_ENGINE: "verdict-cli" })).toThrow(/VERDICT_CLI/);
  });

  it("rejects a non-positive VERDICT_TIMEOUT_MS", () => {
    expect(() =>
      resolveEngineRuntime({ VERDICT_CLI: "/verdict", VERDICT_TIMEOUT_MS: "0" }, { fileExists: exists }),
    ).toThrow(/positive integer/);
  });
});

describe("resolveVerdictCliEntry", () => {
  it("accepts a checkout root and points at its built CLI", () => {
    expect(resolveVerdictCliEntry("/verdict", exists)).toBe("/verdict/packages/cli/dist/main.js");
  });

  it("accepts the entry file directly", () => {
    expect(resolveVerdictCliEntry("/verdict/packages/cli/dist/main.js", exists)).toBe(
      "/verdict/packages/cli/dist/main.js",
    );
  });

  it("tells you to build verdict when the entry is missing", () => {
    expect(() => resolveVerdictCliEntry("/verdict", missing)).toThrow(EngineConfigError);
    expect(() => resolveVerdictCliEntry("/verdict", missing)).toThrow(/pnpm build/);
  });
});

describe("resolveVerdictModel", () => {
  it("applies verdict's own auto rule: live with a key, canned without", () => {
    expect(resolveVerdictModel({})).toBe("canned");
    expect(resolveVerdictModel({ MODEL_API_KEY: "   " })).toBe("canned");
    expect(resolveVerdictModel({ MODEL_API_KEY: "k", MODEL_BASE_URL: "https://api/v1" })).toBe("live");
  });

  it("never guesses the endpoint", () => {
    expect(() => resolveVerdictModel({ MODEL_API_KEY: "k" })).toThrow(/MODEL_BASE_URL/);
    expect(() => resolveVerdictModel({ VERDICT_MODEL: "live" })).toThrow(/MODEL_BASE_URL/);
  });

  it("honours an explicit choice", () => {
    expect(resolveVerdictModel({ VERDICT_MODEL: "mock", MODEL_API_KEY: "k" })).toBe("mock");
    expect(() => resolveVerdictModel({ VERDICT_MODEL: "fast" })).toThrow(
      /auto, mock, canned, live/,
    );
  });
});
