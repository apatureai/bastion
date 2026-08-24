#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section for one release version to stdout.
 *
 * Usage: node scripts/changelog-section.mjs 0.1.0
 *
 * Emits the body under the `## [<version>] ...` heading, up to (but not
 * including) the next `## ` heading. Prints nothing and exits 0 when the
 * section is absent, so the release workflow can fall back to auto-generated
 * notes rather than failing the release.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  process.stderr.write("usage: changelog-section.mjs <version>\n");
  process.exit(2);
}

const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const lines = readFileSync(changelogPath, "utf8").split("\n");

const headingFor = (v) => new RegExp(`^##\\s+\\[${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`);
const anyHeading = /^##\s+/;

let start = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (headingFor(version).test(lines[i])) {
    start = i + 1;
    break;
  }
}

if (start === -1) {
  process.exit(0);
}

let end = lines.length;
for (let i = start; i < lines.length; i += 1) {
  if (anyHeading.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start, end).join("\n").trim();
if (body) {
  process.stdout.write(`${body}\n`);
}
