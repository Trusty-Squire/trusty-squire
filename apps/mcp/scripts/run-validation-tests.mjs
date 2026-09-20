#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_KIND, buildPlanFromRepoPaths } from "./validation-plan.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

function parseArgs(argv) {
  const files = [];
  let fromGit = false;
  let printOnly = false;
  for (const arg of argv) {
    if (arg === "--from-git") fromGit = true;
    else if (arg === "--print") printOnly = true;
    else if (arg === "--files") continue;
    else if (arg.startsWith("-")) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    } else {
      files.push(arg);
    }
  }
  return { files, fromGit, printOnly };
}

export function listChangedFilesFromGit(cwd, base = process.env.RELATED_TESTS_BASE || "origin/main") {
  let mergeBase;
  try {
    mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    mergeBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  }
  const names = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${mergeBase}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  return names.split("\n").map((line) => line.trim()).filter(Boolean);
}

function run(command, args) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) console.error(`${command} terminated by ${signal}`);
      resolveExit(code ?? 1);
    });
  });
}

async function executePlan(plan) {
  if (plan.kind === PLAN_KIND.SKIP_MCP) return 0;
  if (plan.kind === PLAN_KIND.FULL) return run("pnpm", ["exec", "vitest", "run"]);
  if (plan.kind === PLAN_KIND.TEST_FAST) return run("pnpm", ["test:fast"]);
  if (plan.kind === PLAN_KIND.SESSION) {
    const fast = await run("pnpm", ["test:fast"]);
    if (fast !== 0) return fast;
    if (plan.extras.length === 0) return 0;
    return run("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts", ...plan.extras]);
  }
  if (plan.kind === PLAN_KIND.DIRECT) {
    return run("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts", ...plan.tests]);
  }
  console.error(`unknown plan kind: ${plan.kind}`);
  return 2;
}

const { files, fromGit, printOnly } = parseArgs(process.argv.slice(2));
if (!fromGit && files.length === 0) {
  console.error("usage: node scripts/run-validation-tests.mjs [--print] (--from-git | <repo-relative-paths...>)");
  process.exit(2);
}

const changed = fromGit ? listChangedFilesFromGit(repoRoot) : files;
// An empty git diff means we do not know what changed (missing base, or
// HEAD...HEAD fallback). That is unprovable, not "skip mcp".
const plan =
  fromGit && changed.length === 0
    ? {
        kind: PLAN_KIND.TEST_FAST,
        reason:
          "EMPTY_DIFF: git produced no changed paths; fail closed to test:fast, not skip and not the full suite",
        tests: [],
        extras: [],
      }
    : buildPlanFromRepoPaths(packageRoot, changed);
console.log(JSON.stringify({ changed, ...plan }, null, 2));

if (printOnly) process.exit(0);
process.exitCode = await executePlan(plan);
