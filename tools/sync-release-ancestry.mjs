#!/usr/bin/env node
// After a stable release commit lands on main, record that commit as an
// ancestor of staging without copying main's stable package versions onto the
// prerelease branch. This is the git equivalent of `merge -s ours main`.

import { execFileSync, spawnSync } from "node:child_process";

const inputCommit = process.argv[2];
if (inputCommit === undefined || !/^[0-9a-f]{40}$/.test(inputCommit)) {
  console.error("usage: node tools/sync-release-ancestry.mjs <40-character stable commit SHA>");
  process.exit(2);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "github-actions[bot]",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "github-actions[bot]",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com",
};
const git = (...args) => execFileSync("git", args, { encoding: "utf8", env: gitEnv }).trim();

const fetchBranches = () =>
  git(
    "fetch",
    "origin",
    "--quiet",
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/heads/staging:refs/remotes/origin/staging",
  );

const isAncestor = (ancestor, descendant) => {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8",
    env: gitEnv,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr || `git merge-base exited ${result.status}`);
};

fetchBranches();
const stableCommit = git("rev-parse", "--verify", `${inputCommit}^{commit}`);
if (!isAncestor(stableCommit, "origin/main")) {
  console.error(`✗ ${stableCommit} is not contained in origin/main`);
  process.exit(1);
}

const mcpPackage = JSON.parse(git("show", `${stableCommit}:apps/mcp/package.json`));
if (mcpPackage.version.includes("-")) {
  console.error(`✗ ${stableCommit} contains prerelease MCP version ${mcpPackage.version}`);
  process.exit(1);
}

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const stagingCommit = git("rev-parse", "origin/staging");
  if (isAncestor(stableCommit, stagingCommit)) {
    console.log(`✓ staging already records stable promotion ${mcpPackage.version}`);
    process.exit(0);
  }

  // commit-tree avoids checking out staging in the release runner, whose
  // publish steps intentionally leave rebuilt/untracked artifacts behind.
  // Parent 1 is the current staging tip, so the new commit is a fast-forward;
  // its tree is byte-identical to staging and keeps prerelease versions valid.
  const stagingTree = git("rev-parse", `${stagingCommit}^{tree}`);
  const message = `sync(release): record ${mcpPackage.version} promotion [skip ci]\n`;
  const syncCommit = execFileSync(
    "git",
    ["commit-tree", stagingTree, "-p", stagingCommit, "-p", stableCommit],
    { encoding: "utf8", env: gitEnv, input: message },
  ).trim();

  try {
    git("push", "origin", `${syncCommit}:refs/heads/staging`);
    console.log(`✓ recorded stable promotion ${mcpPackage.version} on staging without changing its tree`);
    process.exit(0);
  } catch (error) {
    if (attempt === 3) throw error;
    console.warn(`staging advanced during sync; retrying (${attempt}/3)`);
    fetchBranches();
  }
}
