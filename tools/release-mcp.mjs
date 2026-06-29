#!/usr/bin/env node
// release:mcp — one-step mcp release prep (the /ship ergonomics, repo-shaped).
//
//   node tools/release-mcp.mjs <version>      e.g. 0.9.13   or   0.9.13-rc.2
//
// Bumps apps/mcp/package.json (the npm source of truth), seeds a CHANGELOG
// entry from the commits since the last tag, branches off `staging` (the
// integration branch where RC work accumulates), and opens a PR to the
// channel branch that matches the version shape:
//
//   stable     (0.9.13)      → branch off staging → PR to main    → npm `latest`
//   prerelease (0.9.13-rc.2) → branch off staging → PR to staging → npm `next`
//
// Both cut from staging because that's where work lands. A stable cut therefore
// promotes the whole staging delta to main (not just the bump) — that IS the
// release. (Branching a stable off main would ship a version bump on stale
// code, missing everything staged but not yet promoted.) main is branch-
// protected (PR + green CI required, no direct push); no publish-from-laptop.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const version = process.argv[2];
if (version === undefined || version.length === 0) {
  console.error("usage: node tools/release-mcp.mjs <version>   e.g. 0.9.13 or 0.9.13-rc.2");
  process.exit(2);
}

// npm semver: three numeric parts + optional prerelease. The gstack 4-digit
// format (0.9.13.0) is rejected on purpose — npm will not publish it.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!SEMVER.test(version)) {
  console.error(`✗ "${version}" is not valid npm semver (3 parts + optional -prerelease).`);
  process.exit(2);
}

const isPrerelease = version.includes("-");
// Always branch off staging (where RC work accumulates); `target` is only the
// PR base / channel branch. A stable cut promotes the whole staging delta to main.
const source = "staging";
const target = isPrerelease ? "staging" : "main";
const channel = isPrerelease ? "next" : "latest";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// A release branch must start from a clean tree. We branch off staging; for a
// prerelease the PR diff is just the bump, for a stable cut it's the staging
// delta being promoted to main.
if (git("status", "--porcelain").length > 0) {
  console.error("✗ working tree is not clean. Commit or stash first — a release PR should contain only the bump.");
  process.exit(1);
}

const branch = `release-${version}`;
const branchExists = (() => {
  try {
    git("rev-parse", "--verify", branch);
    return true;
  } catch {
    return false;
  }
})();
if (branchExists) {
  console.error(`✗ branch ${branch} already exists. Delete it or pick another version.`);
  process.exit(1);
}

console.log(`→ ${version}  (${channel}: ${source} → ${target})`);
git("fetch", "origin", source, "--quiet");
git("checkout", "-b", branch, `origin/${source}`);

// 1. Bump the source of truth.
const pkgPath = "apps/mcp/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prev = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// 2. Seed a CHANGELOG entry from commits since the last tag (release.yml tags
//    v<version>). The author tightens the bullets before merge.
let bullets = "- _summarize the changes_\n";
try {
  const lastTag = git("describe", "--tags", "--abbrev=0");
  const log = git("log", `${lastTag}..HEAD`, "--no-merges", "--pretty=%s");
  if (log.length > 0) bullets = `${log.split("\n").map((s) => `- ${s}`).join("\n")}\n`;
} catch {
  /* no tags yet — keep the placeholder */
}
const date = new Date().toISOString().slice(0, 10);
const clPath = "apps/mcp/CHANGELOG.md";
const cl = readFileSync(clPath, "utf8");
const clHeader = "# Changelog — @trusty-squire/mcp\n";
const entry = `## ${version} (${date})\n\n${bullets}\n`;
const rest = cl.startsWith(clHeader) ? cl.slice(clHeader.length).replace(/^\n+/, "") : cl;
writeFileSync(clPath, `${clHeader}\n${entry}${rest}`);

// 3. Commit only the two release files, push, open the PR.
git("add", pkgPath, clPath);
git("commit", "-m", `release(mcp): ${version}`);
git("push", "-u", "origin", branch);

const ghEnv = { ...process.env };
delete ghEnv.GH_TOKEN; // a stale GH_TOKEN env breaks the local gh auth
const prBody =
  `Bumps \`@trusty-squire/mcp\` \`${prev}\` → \`${version}\`.\n\n` +
  `Merging to \`${target}\` publishes the npm \`${channel}\` tag via \`release.yml\`.\n\n` +
  `CHANGELOG bullets were seeded from commits since the last tag — tighten them before merge.`;
try {
  const prUrl = execFileSync(
    "gh",
    ["pr", "create", "--base", target, "--head", branch, "--title", `release(mcp): ${version}`, "--body", prBody],
    { encoding: "utf8", env: ghEnv },
  ).trim();
  console.log(`\n✓ ${prev} → ${version}`);
  console.log(`✓ PR: ${prUrl}`);
  console.log(`\nNext: tighten apps/mcp/CHANGELOG.md, wait for CI green, merge → npm publishes ${channel}.`);
} catch {
  console.log(`\n✓ pushed ${branch}. Open the PR manually:`);
  console.log(`  gh pr create --base ${target} --head ${branch} --title "release(mcp): ${version}"`);
}
