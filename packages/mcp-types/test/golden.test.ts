import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coverageState,
  GOLDEN_ENGINE_RESULT_PATH,
  hasDisplayableEngineConfidence,
  loadGoldenEngineResult,
  loadPreCalibrationEngineResult,
  PRE_CALIBRATION_ENGINE_RESULT_PATH,
  suppressesGradeForCoverage,
} from "../src/index.js";
import type {
  EngineFinding,
  EngineGrade,
  EngineReviewResult,
  EngineSeverity,
} from "../src/index.js";

const GRADES: EngineGrade[] = ["ship", "ship_with_nits", "needs_work", "blocked"];
const SEVERITIES: EngineSeverity[] = ["nit", "minor", "major", "blocker"];

/**
 * The upstream manifest: which `apatureai/verdict` file each fixture is a copy
 * of, and the git blob id of the upstream bytes it was synced to.
 *
 * WHAT THIS FILE CAN AND CANNOT CHECK. It used to carry a test named "is
 * byte-identical to the pinned Verdict fixtures" that hashed THIS repository's
 * own copies and compared them to two literals sitting three lines above. That
 * is a tautology: it can only fail if someone edits a fixture and forgets to
 * edit the literal, and it stayed green for as long as the upstream file drifted
 * away underneath it, which is what happened. The golden fixture upstream gained
 * a `coverage` block and a `provenance` block; this repository's copy did not;
 * the test named for a cross-repo comparison reported success the whole time.
 *
 * A test in this process cannot compare against verdict, because verdict is not
 * on disk here and a test must not reach the network. So the check is split, and
 * each half is named for exactly what it does:
 *
 *   - here, offline: this repository's copies still hash to the blob ids
 *     `UPSTREAM.json` records as upstream. A local edit that silently changes
 *     the shared contract fails. This is a drift alarm, NOT a comparison.
 *   - `scripts/verify-upstream-fixtures.mjs`, given a verdict checkout: the real
 *     byte comparison, plus a check that the manifest's recorded ids are true.
 *     CI checks verdict out beside this repo and runs it on every push, and the
 *     test below runs it too whenever `VERDICT_REPO` names a checkout.
 */
const FIXTURE_DIR = dirname(GOLDEN_ENGINE_RESULT_PATH);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-upstream-fixtures.mjs");

type UpstreamManifest = {
  fixtures: Array<{ local: string; upstreamPath: string; blob: string }>;
};

const manifest = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "UPSTREAM.json"), "utf8"),
) as UpstreamManifest;

/** git's own object id for a file's bytes, comparable with `git hash-object`. */
function blobId(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

describe("golden EngineReviewResult fixture", () => {
  // Compile-time guarantee: the loader's return type IS EngineReviewResult.
  const golden: EngineReviewResult = loadGoldenEngineResult();

  it("has a valid grade", () => {
    expect(GRADES).toContain(golden.grade);
  });

  it("has a non-empty overall summary", () => {
    expect(typeof golden.overall).toBe("string");
    expect(golden.overall.length).toBeGreaterThan(0);
  });

  it("names every fixture in this directory in UPSTREAM.json", () => {
    // The manifest is only as good as its coverage: a fixture nobody recorded is
    // a fixture the cross-repo script never compares. Both loaders' files must
    // appear, by name, so adding a third copy without recording where it came
    // from fails here rather than going unchecked forever.
    const recorded = new Set(manifest.fixtures.map((f) => f.local));
    for (const path of [GOLDEN_ENGINE_RESULT_PATH, PRE_CALIBRATION_ENGINE_RESULT_PATH]) {
      expect(recorded, `${path} is not recorded in UPSTREAM.json`).toContain(
        path.slice(path.lastIndexOf("/") + 1),
      );
    }
  });

  it("this repo's copies still hash to the upstream blob ids UPSTREAM.json records", () => {
    // NOT a cross-repo comparison, and the name says so. Verdict is not on disk
    // in this process. What this proves is that nobody has edited Bastion's copy
    // of the shared contract since it was synced. The comparison against verdict
    // itself is `scripts/verify-upstream-fixtures.mjs`, run by CI against a real
    // checkout and by the test below when VERDICT_REPO points at one.
    for (const fixture of manifest.fixtures) {
      expect(blobId(join(FIXTURE_DIR, fixture.local)), `${fixture.local} drifted locally`).toBe(
        fixture.blob,
      );
    }
  });

  // The real thing, when a verdict checkout is reachable. `skipIf` reports as
  // SKIPPED in the test output rather than as a pass, which is the point: a
  // check that did not run must never look like a check that agreed.
  it.skipIf(!process.env.VERDICT_REPO || !existsSync(process.env.VERDICT_REPO))(
    "is byte-identical to the verdict checkout at VERDICT_REPO",
    () => {
      const output = execFileSync(process.execPath, [VERIFY_SCRIPT, process.env.VERDICT_REPO!], {
        encoding: "utf8",
      });
      expect(output).toContain("byte-identical");
    },
  );

  it("authorizes only complete report-backed confidence", () => {
    expect(golden.calibration?.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(golden.blockingEnabled).toBe(true);
    expect(hasDisplayableEngineConfidence(golden)).toBe(true);

    const historical = loadPreCalibrationEngineResult();
    expect(typeof historical.confidence).toBe("number");
    expect(historical.calibration).toBeUndefined();
    expect(hasDisplayableEngineConfidence(historical)).toBe(false);
  });

  it("has structurally valid findings", () => {
    expect(Array.isArray(golden.findings)).toBe(true);
    for (const f of golden.findings as EngineFinding[]) {
      expect(typeof f.id).toBe("string");
      expect(SEVERITIES).toContain(f.severity);
      expect(typeof f.title).toBe("string");
      expect(typeof f.description).toBe("string");
      expect(typeof f.route).toBe("string");
      expect(["mobile", "tablet", "desktop"]).toContain(f.viewport);
      expect(f.element === null || typeof f.element === "string").toBe(true);
      expect(f.screenshotId === null || typeof f.screenshotId === "string").toBe(true);
      expect(f.suggestion === null || typeof f.suggestion === "string").toBe(true);
    }
  });

  it("exposes notReviewed as an array of strings", () => {
    expect(Array.isArray(golden.notReviewed)).toBe(true);
    for (const n of golden.notReviewed) expect(typeof n).toBe("string");
  });

  it("carries the engine's coverage, and it is the honest-partial counterexample", () => {
    // This is why "zero findings plus a non-empty notReviewed is not a pass" is
    // the wrong rule, and why coverage has to be read from the contract instead.
    // The golden run skipped /checkout and the tablet viewport and still carries
    // real findings on what it did review: an honest partial, not an empty run.
    const coverage = golden.coverage;
    expect(coverage, "the shared contract must state coverage").toBeDefined();
    expect(coverage!.routesRequested).toEqual(["/pricing", "/checkout"]);
    expect(coverage!.routesReviewed).toEqual(["/pricing"]);
    expect(coverage!.viewportsRequested).toEqual(["mobile", "tablet", "desktop"]);
    expect(coverage!.viewportsReviewed).toEqual(["mobile", "desktop"]);
    expect(coverageState(golden)).toBe("partial");
    expect(suppressesGradeForCoverage(coverageState(golden))).toBe(false);
    expect(golden.findings.length).toBeGreaterThan(0);

    // The pre-calibration counterexample predates the field entirely, which is
    // the `unstated` case: absent coverage is never read as "everything".
    expect(loadPreCalibrationEngineResult().coverage).toBeUndefined();
    expect(coverageState(loadPreCalibrationEngineResult())).toBe("unstated");
    expect(suppressesGradeForCoverage("unstated")).toBe(false);
  });

  it("annotated screenshots reference real findings", () => {
    const findingIds = new Set(golden.findings.map((f) => f.id));
    for (const shot of golden.artifacts.annotatedScreenshots) {
      expect(findingIds.has(shot.findingId)).toBe(true);
      expect(typeof shot.url).toBe("string");
    }
  });

  it("metadata is engine-neutral and traceable (no model hard-coding)", () => {
    const { metadata } = golden;
    expect(typeof metadata.engineVersion).toBe("string");
    expect(typeof metadata.model).toBe("string");
    expect(typeof metadata.promptVersion).toBe("string");
    expect(typeof metadata.captureVersion).toBe("string");
    expect(metadata.uiDnaVersion === null || typeof metadata.uiDnaVersion === "string").toBe(true);

    // Bastion must never hard-code Claude as the judge in the boundary.
    const serialized = JSON.stringify(golden).toLowerCase();
    expect(serialized).not.toContain("claude");
    expect(serialized).not.toContain("anthropic");
  });
});
