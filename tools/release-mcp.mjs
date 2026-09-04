#!/usr/bin/env node
// release:mcp — one-step mcp release prep (the /ship ergonomics, repo-shaped).
//
//   node tools/release-mcp.mjs next-rc        auto-increment staging's RC
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
// Always branch off staging (where RC work accumulates); `target` is only the
// PR base / channel branch. A stable cut promotes the whole staging delta to main.
const source = "staging";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// A release branch must start from a clean tree. We branch off staging; for a
// prerelease the PR diff is just the bump, for a stable cut it's the staging
// delta being promoted to main.
if (git("status", "--porcelain").length > 0) {
  console.error(
    "✗ working tree is not clean. Commit or stash first — a release PR should contain only the bump.",
  );
  process.exit(1);
}

git("fetch", "origin", source, "--quiet");

let version = requestedVersion;
if (requestedVersion === "next-rc") {
  const stagingPackage = JSON.parse(git("show", `origin/${source}:apps/mcp/package.json`));
  const current = stagingPackage.version;
  const rc = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/.exec(current);
  const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (rc !== null) {
    version = `${rc[1]}.${rc[2]}.${rc[3]}-rc.${Number(rc[4]) + 1}`;
  } else if (stable !== null) {
    version = `${stable[1]}.${stable[2]}.${Number(stable[3]) + 1}-rc.1`;
  } else {
    console.error(`✗ cannot derive the next RC from staging version "${current}".`);
    process.exit(2);
  }
  console.log(`→ next-rc resolved from staging: ${current} → ${version}`);
}

if (!SEMVER.test(version)) {
  console.error(`✗ "${version}" is not valid npm semver (3 parts + optional -prerelease).`);
  process.exit(2);
}

const isPrerelease = version.includes("-");
const target = isPrerelease ? "staging" : "main";
const channel = isPrerelease ? "next" : "latest";

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

// 1b. On a STABLE cut, also strip the -rc suffix off bundled workspace
//     packages that have their own main=stable / staging=prerelease release
//     guard. A stable cut promotes the whole staging delta to main, which
//     carries staging's PRERELEASE versions onto main — and their release
//     workflow then fails ("main requires a stable version"). De-prerelease
//     them here so e.g. skill-schema 0.1.3-rc.1 → 0.1.3 lands stable on main.
//     (Idempotent at publish time: if that stable version is already on npm,
//     the workflow skips with a notice instead of republishing.)
const promotedWorkspacePkgs = [];
if (!isPrerelease) {
  const promoted = []; // { name, oldVersion } — drives the repin pass below
  for (const wsPath of [
    "packages/skill-schema/package.json",
    "packages/recipe-schema/package.json",
  ]) {
    const wsPkg = JSON.parse(readFileSync(wsPath, "utf8"));
    if (wsPkg.version.includes("-")) {
      const oldVersion = wsPkg.version;
      wsPkg.version = wsPkg.version.replace(/-.*$/, "");
      writeFileSync(wsPath, `${JSON.stringify(wsPkg, null, 2)}\n`);
      promotedWorkspacePkgs.push(wsPath);
      promoted.push({ name: wsPkg.name, oldVersion });
      console.log(`  also promoting ${wsPkg.name} → ${wsPkg.version} (stable cut)`);
    }
  }

  // 1c. A dependent that pins one of the packages just promoted to an EXACT
  //     workspace version (`workspace:0.1.6-rc.1`, as opposed to a
  //     self-resolving `workspace:*`) now points at a version that no longer
  //     exists — pnpm treats that as "must literally match" and install/pack
  //     breaks. Repin every such dependent to `workspace:*`, matching how
  //     every other reference to these packages in the repo already resolves
  //     them, so this class of staleness can't recur.
  const lockRewrites = []; // { name, oldSpecifier, newSpecifier } — mirrored into pnpm-lock.yaml below
  if (promoted.length > 0) {
    const allPkgJsonPaths = git(
      "ls-files",
      "apps/*/package.json",
      "packages/*/package.json",
      "tools/*/package.json",
    )
      .split("\n")
      .filter(Boolean);
    for (const depPath of allPkgJsonPaths) {
      if (promotedWorkspacePkgs.includes(depPath)) continue; // already rewritten above
      const depPkg = JSON.parse(readFileSync(depPath, "utf8"));
      let changed = false;
      for (const depField of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const deps = depPkg[depField];
        if (deps === undefined) continue;
        for (const { name, oldVersion } of promoted) {
          const oldSpecifier = `workspace:${oldVersion}`;
          if (deps[name] === oldSpecifier) {
            deps[name] = "workspace:*";
            changed = true;
            lockRewrites.push({ name, oldSpecifier, newSpecifier: "workspace:*" });
            console.log(`  also repinning ${depPath}: ${name} ${oldSpecifier} → workspace:*`);
          }
        }
      }
      if (changed) {
        writeFileSync(depPath, `${JSON.stringify(depPkg, null, 2)}\n`);
        promotedWorkspacePkgs.push(depPath);
      }
    }
  }

  // 1d. pnpm-lock.yaml's per-importer `specifier:` must mirror package.json's
  //     dependency string verbatim, or `pnpm install --frozen-lockfile` (what
  //     CI runs) rejects the lockfile as stale. Patch the matching specifier
  //     lines in place — a surgical text sync, not a full re-resolve, so it
  //     can't drag in unrelated dependency churn.
  const lockPath = "pnpm-lock.yaml";
  if (lockRewrites.length > 0) {
    let lock = readFileSync(lockPath, "utf8");
    let lockChanged = false;
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");
    for (const { name, oldSpecifier, newSpecifier } of lockRewrites) {
      const pattern = new RegExp(
        `('${escapeRe(name)}':\\n\\s*specifier: )${escapeRe(oldSpecifier)}\\n`,
        "g",
      );
      const next = lock.replace(pattern, `$1${newSpecifier}\n`);
      if (next !== lock) {
        lock = next;
        lockChanged = true;
      }
    }
    if (lockChanged) {
      writeFileSync(lockPath, lock);
      promotedWorkspacePkgs.push(lockPath);
    }
  }
}

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
const mergeReminder = isPrerelease
  ? ""
  : `\n\n**Merge with "Create a merge commit" — NOT squash.** A squash merge severs ` +
    `\`main\`'s ancestry from \`staging\`, so the *next* stable cut false-conflicts on files ` +
    `that are actually identical and can also delay/skip PR-triggered CI on this PR (GitHub's ` +
    `mergeability check can stall on a diverged, conflicting diff). Regular merge commits are the ` +
    `established convention for PRs into \`main\` in this repo's history — see CLAUDE.md's release SOP.`;
const prBody =
  `Bumps \`@trusty-squire/mcp\` \`${prev}\` → \`${version}\`.\n\n` +
  `Merging to \`${target}\` publishes the npm \`${channel}\` tag via \`release.yml\`.\n\n` +
  `CHANGELOG bullets were seeded from commits since the last tag — tighten them before merge.${mergeReminder}`;
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
