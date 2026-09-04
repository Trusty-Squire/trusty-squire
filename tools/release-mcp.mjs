#!/usr/bin/env node
// release:mcp — one-step mcp release prep (the /ship ergonomics, repo-shaped).
//
//   node tools/release-mcp.mjs next-rc        auto-increment main's RC
//   node tools/release-mcp.mjs <version>      e.g. 0.9.13-rc.2
//
// Bumps apps/mcp/package.json (the npm source of truth), seeds a CHANGELOG
// entry from the commits since the last tag, branches off `main` (the single
// integration + release branch), and opens a prerelease PR back to `main`:
//
//   prerelease (0.9.13-rc.2) → branch off main → PR to main → npm `next`
//
// main is branch-protected (PR + green CI required, no direct push); no
// publish-from-laptop.
//
// A STABLE cut is not done through this script — it's an explicit
// `workflow_dispatch` of the "Release mcp" GitHub Action against `main` HEAD,
// which publishes npm `latest` without a commit. See docs/single-main-migration.md.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requestedVersion = process.argv[2];
if (requestedVersion === undefined || requestedVersion.length === 0) {
  console.error(
    "usage: node tools/release-mcp.mjs <next-rc|version>   e.g. next-rc, 0.9.13, or 0.9.13-rc.2",
  );
  process.exit(2);
}

// npm semver: three numeric parts + optional prerelease. The gstack 4-digit
// format (0.9.13.0) is rejected on purpose — npm will not publish it.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Always branch off main (the single integration + release branch).
const source = "main";
const target = "main";
const channel = "next";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// A release branch must start from a clean tree.
if (git("status", "--porcelain").length > 0) {
  console.error(
    "✗ working tree is not clean. Commit or stash first — a release PR should contain only the bump.",
  );
  process.exit(1);
}

git("fetch", "origin", source, "--quiet");

let version = requestedVersion;
if (requestedVersion === "next-rc") {
  const mainPackage = JSON.parse(git("show", `origin/${source}:apps/mcp/package.json`));
  const current = mainPackage.version;
  const rc = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/.exec(current);
  const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (rc !== null) {
    version = `${rc[1]}.${rc[2]}.${rc[3]}-rc.${Number(rc[4]) + 1}`;
  } else if (stable !== null) {
    version = `${stable[1]}.${stable[2]}.${Number(stable[3]) + 1}-rc.1`;
  } else {
    console.error(`✗ cannot derive the next RC from main version "${current}".`);
    process.exit(2);
  }
  console.log(`→ next-rc resolved from main: ${current} → ${version}`);
}

if (!SEMVER.test(version)) {
  console.error(`✗ "${version}" is not valid npm semver (3 parts + optional -prerelease).`);
  process.exit(2);
}

const isPrerelease = version.includes("-");
if (!isPrerelease) {
  console.error(
    `✗ "${version}" is a stable version. This script only cuts prereleases (npm \`next\`).\n` +
      `  A stable cut is a "Release mcp" workflow_dispatch against main HEAD — see ` +
      `docs/single-main-migration.md#how-to-cut-a-stable-release-now.`,
  );
  process.exit(2);
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
git("checkout", "-b", branch, `origin/${source}`);

// 1. Bump the source of truth.
const pkgPath = "apps/mcp/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prev = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const promotedWorkspacePkgs = [];

// 2. Seed a CHANGELOG entry from commits since the last tag (release.yml tags
//    v<version>). The author tightens the bullets before merge.
let bullets = "- _summarize the changes_\n";
try {
  const lastTag = git("describe", "--tags", "--abbrev=0");
  const log = git("log", `${lastTag}..HEAD`, "--no-merges", "--pretty=%s");
  if (log.length > 0)
    bullets = `${log
      .split("\n")
      .map((s) => `- ${s}`)
      .join("\n")}\n`;
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

// 3. Commit the release files (+ any workspace pkgs promoted to stable), push,
//    open the PR.
git("add", pkgPath, clPath, ...promotedWorkspacePkgs);
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
    [
      "pr",
      "create",
      "--base",
      target,
      "--head",
      branch,
      "--title",
      `release(mcp): ${version}`,
      "--body",
      prBody,
    ],
    { encoding: "utf8", env: ghEnv },
  ).trim();
  console.log(`\n✓ ${prev} → ${version}`);
  console.log(`✓ PR: ${prUrl}`);
  console.log(`\nNext: merge the green PR → release.yml publishes npm ${channel} automatically.`);
} catch {
  console.log(`\n✓ pushed ${branch}. Open the PR manually:`);
  console.log(
    `  gh pr create --base ${target} --head ${branch} --title "release(mcp): ${version}"`,
  );
}
