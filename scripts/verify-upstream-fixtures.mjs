#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The real cross-repo fixture check.
 *
 * `packages/mcp-types/fixtures/` holds Bastion's copy of the engine result
 * contract that `apatureai/verdict` produces and `apatureai/gate` consumes. All
 * three must be byte-identical: the fixture IS the contract, and a copy that
 * drifts is a mock that no longer matches the engine it stands in for.
 *
 * Nothing inside this repository can verify that. A test here can only hash this
 * repository's own files, and a test that hashes its own file against a literal
 * it also ships is a tautology: it stays green while the upstream file changes
 * underneath it, which is exactly what happened. `test/golden.test.ts` is
 * therefore named for what it can actually check, and this script is what does
 * the comparison, from somewhere that has both repositories: CI checks out
 * verdict beside this repo and runs it.
 *
 * Usage:
 *   node scripts/verify-upstream-fixtures.mjs <path to an apatureai/verdict checkout>
 *   VERDICT_REPO=<path> node scripts/verify-upstream-fixtures.mjs
 *
 * Exits 0 when every fixture matches upstream byte for byte, 1 when any differs,
 * and 2 when it could not look (no checkout, missing file). Exit 2 is a failure
 * to check, never a pass: an unreachable upstream must not read as agreement.
 */

const FIXTURE_DIR = fileURLToPath(new URL("../packages/mcp-types/fixtures/", import.meta.url));
const MANIFEST_PATH = join(FIXTURE_DIR, "UPSTREAM.json");

/** git's own object id for a file's bytes, so ids are comparable with `git hash-object`. */
function blobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const repo = process.argv[2] ?? process.env.VERDICT_REPO ?? "";
if (repo.trim().length === 0) {
  fail(
    2,
    "verify-upstream-fixtures: no verdict checkout given, so nothing was verified.\n" +
      "  Pass the path to an apatureai/verdict checkout, or set VERDICT_REPO.\n" +
      "  This is a failure to check, not a pass.",
  );
}
const root = resolve(repo);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const problems = [];
const checked = [];

for (const fixture of manifest.fixtures) {
  const localPath = join(FIXTURE_DIR, fixture.local);
  const upstreamPath = join(root, fixture.upstreamPath);

  let local;
  let upstream;
  try {
    local = readFileSync(localPath);
  } catch {
    fail(2, `verify-upstream-fixtures: cannot read this repo's ${localPath}; nothing was verified.`);
  }
  try {
    upstream = readFileSync(upstreamPath);
  } catch {
    fail(
      2,
      `verify-upstream-fixtures: ${upstreamPath} does not exist in the checkout at ${root}.\n` +
        "  Either the path moved upstream or this is not a verdict checkout. Nothing was verified.",
    );
  }

  const localBlob = blobId(local);
  const upstreamBlob = blobId(upstream);
  checked.push(fixture.local);

  if (!local.equals(upstream)) {
    problems.push(
      `${fixture.local} differs from ${fixture.upstreamPath}\n` +
        `    here:     ${localBlob}\n` +
        `    upstream: ${upstreamBlob}\n` +
        "    Copy the upstream file over this one and update the recorded blob in UPSTREAM.json.",
    );
    continue;
  }
  // The bytes agree; now check that the manifest is telling the truth about
  // which upstream bytes they are, so the offline test's pin means something.
  if (fixture.blob !== upstreamBlob) {
    problems.push(
      `${fixture.local} matches upstream, but UPSTREAM.json records blob ${fixture.blob}\n` +
        `    and upstream is actually ${upstreamBlob}. Update the manifest.`,
    );
  }
}

if (problems.length > 0) {
  fail(
    1,
    `verify-upstream-fixtures: ${problems.length} problem(s) against ${root}\n  - ${problems.join("\n  - ")}`,
  );
}

process.stdout.write(
  `verify-upstream-fixtures: ${checked.length} fixture(s) byte-identical to ${root}: ${checked.join(", ")}\n`,
);
