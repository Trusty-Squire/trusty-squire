#!/usr/bin/env node

// Fail-closed validation planner for apps/mcp.
//
// Safety property: a change must never skip a test that could have caught it.
// The expensive failure mode is today's default (full `vitest run`, ~1064s).
// The dangerous failure mode is skipping a test. When this planner cannot
// prove a test irrelevant it falls back to `test:fast` (~119s), the same
// gate CI already trusts on every PR — not to the full suite. Only the
// real-browser / broker / vitest / lockfile cone escalates to a full pass,
// because an import graph cannot see a Unix socket, a spawned daemon, or a
// change to the runner itself.
//
// Do not invert that fallback. Failing closed to the full suite on every
// "not sure" is what took two tasks off the validation pipeline.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  buildImportGraph,
  isTestFile,
  loadRealBrowserFiles,
  selectDirectImportTests,
} from "./related-tests.mjs";

export const PLAN_KIND = Object.freeze({
  DIRECT: "direct",
  TEST_FAST: "test:fast",
  SESSION: "session",
  FULL: "full",
  SKIP_MCP: "skip-mcp",
});

// Session / lifecycle / facade hubs. test:fast currently excludes
// operate-session-flow.test.ts because three cases launch Chromium
// (AGENTS.md §14 whole-file rule). Those 211 tests are the Google-gate
// and finish-consolidation oracle; a session-hub change that only ran
// test:fast would be fail-open for that work.
export const SESSION_HUB_FILES = Object.freeze([
  "src/bot/provision-session.ts",
  "src/bot/session/lifecycle.ts",
  "src/bot/session/model.ts",
  "src/bot/act/act.ts",
  "src/bot/operate-drive.ts",
  "src/bot/oauth-login.ts",
]);

export const SESSION_EXTRA_TESTS = Object.freeze([
  "src/bot/__tests__/operate-session-flow.test.ts",
  "src/bot/__tests__/session-characterization.test.ts",
]);

// A bug in the selector, the tier runner, or the planner skips tests
// rather than failing them. Own-test-only selection is not enough.
const SELECTOR_SELF_FILES = Object.freeze([
  "scripts/related-tests.mjs",
  "scripts/run-related-tests.mjs",
  "scripts/validation-plan.mjs",
  "scripts/run-validation-tests.mjs",
  "scripts/run-test-tier.mjs",
]);

const MCP_WORKSPACE_DEPS = Object.freeze(["packages/skill-schema/", "packages/recipe-schema/"]);

const SESSION_HUB_SET = new Set(SESSION_HUB_FILES);
const SELECTOR_SELF_SET = new Set(SELECTOR_SELF_FILES);

export function toMcpRel(repoPath) {
  const posix = repoPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posix.startsWith("apps/mcp/")) return posix.slice("apps/mcp/".length);
  if (posix.startsWith("fixtures/browser-use/")) return posix;
  return posix;
}

export function isRepoLockfileOrRootConfig(repoPath) {
  const posix = repoPath.replace(/\\/g, "/");
  return posix === "pnpm-lock.yaml" || posix === "package.json";
}

export function isMcpWorkspaceDep(repoPath) {
  const posix = repoPath.replace(/\\/g, "/");
  return MCP_WORKSPACE_DEPS.some((prefix) => posix.startsWith(prefix));
}

/**
 * Why a full pass: the import graph cannot prove a real-browser or runner
 * test irrelevant. Escalating here is the same cost as today (~1064s).
 */
export function isFullSuiteCone(mcpRel) {
  const rel = mcpRel.replace(/\\/g, "/");
  if (rel === "package.json") return true;
  if (/^vitest[.-]/.test(basename(rel)) || rel === "vitest.tiers.ts" || rel === "vitest.shared.ts") {
    return true;
  }
  if (rel === "src/bot/browser.ts" || rel === "src/bot/page-driver.ts") return true;
  if (rel.startsWith("src/bot/broker/")) return true;
  if (rel.startsWith("src/bot/browser-process-")) return true;
  if (rel.startsWith("src/bot/owner-process-reaper")) return true;
  if (rel === "src/tools/inject-card.ts") return true;
  return false;
}

export function isSessionHub(mcpRel) {
  return SESSION_HUB_SET.has(mcpRel.replace(/\\/g, "/"));
}

export function isSelectorSelf(mcpRel) {
  return SELECTOR_SELF_SET.has(mcpRel.replace(/\\/g, "/"));
}

function plan(kind, reason, extra = {}) {
  return { kind, reason, tests: extra.tests ?? [], extras: extra.extras ?? [] };
}

export function chooseValidationPlan({
  changedRepoPaths,
  packageRoot,
  graph,
  realBrowserFiles,
}) {
  const mcpChanges = [];
  let lockfileOrRootConfig = false;
  let workspaceDep = false;

  for (const repoPath of changedRepoPaths) {
    if (isRepoLockfileOrRootConfig(repoPath)) {
      lockfileOrRootConfig = true;
      continue;
    }
    if (isMcpWorkspaceDep(repoPath)) {
      workspaceDep = true;
      continue;
    }
    const posix = repoPath.replace(/\\/g, "/");
    if (posix.startsWith("apps/mcp/") || posix.startsWith("fixtures/browser-use/")) {
      mcpChanges.push(toMcpRel(posix));
    }
  }

  // LOCKFILE_OR_ROOT_CONFIG: Vitest already force-reruns the selected spec
  // list when package.json / vitest config change. A lockfile rewrite can
  // change any resolved dep. Cannot prove any test irrelevant → full pass.
  if (lockfileOrRootConfig) {
    return plan(PLAN_KIND.FULL, "LOCKFILE_OR_ROOT_CONFIG: lockfile or root package.json changed; the runner and every resolved dep may move");
  }

  // BROWSER_BROKER_CONFIG_CONE: Unix sockets, spawned daemons, connectOverCDP,
  // and hosted-field / inject_card writes are not edges in the static graph.
  // Vitest config / tier lists change what "fast" means. Full pass, same as
  // today's default — this is the only cone that still pays ~1064s.
  if (mcpChanges.some((rel) => isFullSuiteCone(rel))) {
    return plan(
      PLAN_KIND.FULL,
      "BROWSER_BROKER_CONFIG_CONE: browser / broker / process / inject_card / vitest config changed; the import graph cannot prove a real-browser test irrelevant",
    );
  }

  if (mcpChanges.length === 0 && workspaceDep) {
    return plan(
      PLAN_KIND.TEST_FAST,
      "WORKSPACE_DEP: skill-schema or recipe-schema changed; mcp imports them and the mapper cannot prove a fast-tier test irrelevant",
    );
  }

  // NO_MCP_CHANGE: an api/web/registry-only diff cannot be caught by an mcp
  // test. Skipping mcp here does not skip a test that could have caught it.
  if (mcpChanges.length === 0) {
    return plan(PLAN_KIND.SKIP_MCP, "NO_MCP_CHANGE: diff has no apps/mcp or serializer-fixture path");
  }

  // SELECTOR_SELF: a bug here skips tests rather than failing them. Own-test
  // selection would green a broken fallback. Pay the 119s PR gate.
  if (mcpChanges.some((rel) => isSelectorSelf(rel))) {
    return plan(
      PLAN_KIND.TEST_FAST,
      "SELECTOR_SELF: the selector, planner, or tier runner changed; a mapper bug ships a skipped test, so fall back to test:fast",
    );
  }

  // SESSION_HUB: test:fast is fail-open for operate-session-flow (real-browser
  // listed because of three launches). Add that file and characterization.
  if (mcpChanges.some((rel) => isSessionHub(rel))) {
    return plan(
      PLAN_KIND.SESSION,
      "SESSION_HUB: session / lifecycle / act / oauth-login changed; test:fast plus operate-session-flow and session-characterization",
      { extras: SESSION_EXTRA_TESTS.filter((file) => existsSync(`${packageRoot}/${file}`)) },
    );
  }

  // BARE_DYNAMIC_IMPORT: `import(variable)` has no static target. Cannot
  // prove a fast-tier test irrelevant → test:fast, not the full suite.
  if (mcpChanges.some((rel) => graph.bareDynamicImporters.has(rel))) {
    return plan(
      PLAN_KIND.TEST_FAST,
      "BARE_DYNAMIC_IMPORT: a changed file calls import(variable); the mapper cannot prove a fast-tier test irrelevant",
    );
  }

  const selected = selectDirectImportTests({
    packageRoot,
    changedFiles: mcpChanges,
    graph,
    realBrowserFiles,
  });

  // EMPTY_DIRECT_SET / UNMAPPED: no own test, no static importer, no one-hop
  // caller. That is "not proven irrelevant", not "no tests needed".
  if (selected.tests.length === 0) {
    return plan(
      PLAN_KIND.TEST_FAST,
      "EMPTY_DIRECT_SET: mapping cannot prove a test irrelevant; fall back to test:fast (119s), never to the full suite",
    );
  }

  // DIRECT_IMPORT: every test that statically sees the file is in the set.
  // Tests that only reach it through a hub wait for a hub change, the
  // session overlay, or the nightly full pass.
  return plan(PLAN_KIND.DIRECT, "DIRECT_IMPORT: own test + direct importers + one hop of non-hub callers", {
    tests: selected.tests,
  });
}

export function buildPlanFromRepoPaths(packageRoot, changedRepoPaths) {
  return chooseValidationPlan({
    changedRepoPaths,
    packageRoot,
    graph: buildImportGraph(packageRoot),
    realBrowserFiles: loadRealBrowserFiles(packageRoot),
  });
}

export function isTestPath(mcpRel) {
  return isTestFile(mcpRel);
}
