import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGoldenEngineResult } from "@apature/mcp-types";
import { afterEach, describe, expect, it } from "vitest";
import { EngineDependencyError } from "../src/engine-http-client.js";
import { EngineResultError } from "../src/engine-result.js";
import { VerdictCliEngineClient, type ProcessRunner } from "../src/verdict-cli-engine.js";
import type { NormalizedReviewRequest } from "../src/normalize.js";

/**
 * The verdict CLI backend, driven through its process seam so no test ever
 * spawns Chromium, calls a model, or needs a verdict checkout on disk.
 *
 * Load-bearing: the command line handed to verdict is asserted field by field
 * (a wrong `--routes` silently reviews the wrong page); a result that is not the
 * `EngineReviewResult` contract is rejected at the boundary instead of reaching
 * the critique mapper; and a run without a live model carries the disclosure
 * that nothing judged the page into the result itself.
 */

const request: NormalizedReviewRequest = {
  url: "https://preview.example.com/pricing?x=1",
  routes: ["/pricing", "/checkout"],
  viewports: ["mobile", "desktop"],
  depth: "deep",
  expected_revision: null,
  response_mode: "compact",
  client_request_id: "cli/req 0001",
};

const dirs: string[] = [];

async function outRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastion-verdict-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A runner that writes `body` into the `--out` directory and exits `code`. */
function fakeRunner(
  body: string | null,
  code = 0,
  extra: Partial<{ stderr: string; timedOut: boolean }> = {},
): { run: ProcessRunner; args: string[][] } {
  const args: string[][] = [];
  const run: ProcessRunner = async (spec) => {
    args.push([...spec.args]);
    const outDir = spec.args[spec.args.indexOf("--out") + 1] as string;
    if (body !== null) await writeFile(join(outDir, "review.json"), body);
    return { code, stdout: "", stderr: extra.stderr ?? "", timedOut: extra.timedOut ?? false };
  };
  return { run, args };
}

describe("VerdictCliEngineClient", () => {
  it("builds the verdict command line from the normalized request", async () => {
    const golden = loadGoldenEngineResult();
    const { run, args } = fakeRunner(JSON.stringify(golden));
    const client = new VerdictCliEngineClient({
      entry: "/verdict/packages/cli/dist/main.js",
      model: "live",
      contextDir: "/repo",
      outRoot: await outRoot(),
      nodePath: "/usr/bin/node",
      run,
    });

    const result = await client.review(request);

    const argv = args[0] as string[];
    expect(argv[0]).toBe("/verdict/packages/cli/dist/main.js");
    // The origin is the base; the routes travel separately, so the target's own
    // path is never appended twice.
    expect(argv[argv.indexOf("--url") + 1]).toBe("https://preview.example.com");
    expect(argv[argv.indexOf("--routes") + 1]).toBe("/pricing,/checkout");
    expect(argv[argv.indexOf("--viewports") + 1]).toBe("mobile,desktop");
    expect(argv[argv.indexOf("--model") + 1]).toBe("live");
    expect(argv[argv.indexOf("--context-dir") + 1]).toBe("/repo");
    // A live run is the engine's result verbatim, except for Bastion's own
    // provenance stamp: no engine field is added, removed, or rewritten.
    const { provenance, ...engineFields } = result;
    expect(engineFields).toEqual(golden);
    expect(provenance).toEqual({
      model_backed: true,
      source: "model",
      engine: "verdict-cli",
      model: "qwen3-vl",
      detail:
        "verdict ran with --model live: Chromium captured the target and a vision model judged the capture",
    });
  });

  it("stamps its own provenance over anything the CLI claims about itself", async () => {
    // A backend that writes a `provenance` into review.json must not be able to
    // certify itself as model-backed: the parser drops what arrived on the wire
    // and the adapter's own stamp is the only one that survives.
    const forged = {
      ...loadGoldenEngineResult(),
      provenance: {
        model_backed: true,
        source: "model",
        engine: "totally-legit",
        model: "gpt-imaginary",
        detail: "trust me",
      },
    };
    const { run } = fakeRunner(JSON.stringify(forged));
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "canned",
      outRoot: await outRoot(),
      run,
    });

    const result = await client.review(request);
    expect(result.provenance?.model_backed).toBe(false);
    expect(result.provenance?.source).toBe("canned");
    expect(result.provenance?.engine).toBe("verdict-cli");
  });

  it("writes artifacts into a per-review directory named for the request", async () => {
    const root = await outRoot();
    const { run, args } = fakeRunner(JSON.stringify(loadGoldenEngineResult()));
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: root,
      run,
    });
    await client.review(request);

    const dir = (args[0] as string[])[(args[0] as string[]).indexOf("--out") + 1] as string;
    expect(dir.startsWith(root)).toBe(true);
    // The id is sanitized, so a client_request_id with a slash cannot escape the root.
    expect(dir).toMatch(/cli_req_0001$/);
    await expect(readFile(join(dir, "review.json"), "utf8")).resolves.toContain("findings");
  });

  it("discloses in the result itself when no model judged the page", async () => {
    const { run } = fakeRunner(JSON.stringify(loadGoldenEngineResult()));
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "canned",
      outRoot: await outRoot(),
      run,
    });

    const result = await client.review(request);
    expect(result.notReviewed[0]).toContain("[bastion] no model judged this page");
    expect(result.notReviewed[0]).toContain("--model canned");
    // The engine's own not-reviewed entries survive underneath the disclosure.
    expect(result.notReviewed.slice(1)).toEqual(loadGoldenEngineResult().notReviewed);
  });

  it("fails with the child's output when the CLI exits non-zero", async () => {
    const { run } = fakeRunner(null, 1, { stderr: "Executable doesn't exist at .../chromium" });
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: await outRoot(),
      run,
    });
    await expect(client.review(request)).rejects.toThrow(EngineDependencyError);
    await expect(client.review(request)).rejects.toThrow(/exited 1.*chromium/s);
  });

  it("fails when the CLI times out", async () => {
    const { run } = fakeRunner(null, null, { timedOut: true });
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: await outRoot(),
      timeoutMs: 1_000,
      run,
    });
    await expect(client.review(request)).rejects.toThrow(/did not finish within 1000ms/);
  });

  it("fails when the CLI exits clean but writes no result", async () => {
    const { run } = fakeRunner(null, 0);
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: await outRoot(),
      run,
    });
    await expect(client.review(request)).rejects.toThrow(/wrote no .*review\.json/);
  });

  it("rejects a result that is not the engine contract", async () => {
    const broken = { ...loadGoldenEngineResult(), grade: "great" };
    const { run } = fakeRunner(JSON.stringify(broken));
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: await outRoot(),
      run,
    });
    await expect(client.review(request)).rejects.toThrow(EngineResultError);
  });

  it("rejects unparseable output rather than guessing", async () => {
    const { run } = fakeRunner("<html>502 Bad Gateway</html>");
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: await outRoot(),
      run,
    });
    await expect(client.review(request)).rejects.toThrow(/not valid JSON/);
  });

  it("refuses to recheck rather than inventing per-finding outcomes", async () => {
    const { run } = fakeRunner(JSON.stringify(loadGoldenEngineResult()));
    const client = new VerdictCliEngineClient({
      entry: "/verdict/main.js",
      model: "live",
      outRoot: await outRoot(),
      run,
    });
    await expect(
      client.recheck({
        reviewId: "rev_1",
        url: request.url,
        beforeFingerprint: "a",
        afterFingerprint: "b",
        findings: [{ findingId: "f_001", route: "/pricing", element: null }],
      }),
    ).rejects.toThrow(/exposes no recheck surface/);
  });
});
