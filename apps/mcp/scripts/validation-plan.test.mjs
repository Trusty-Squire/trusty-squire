import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportGraph, loadRealBrowserFiles } from "./related-tests.mjs";
import {
  PLAN_KIND,
  SESSION_EXTRA_TESTS,
  chooseValidationPlan,
  isFullSuiteCone,
  isSelectorSelf,
  isSessionHub,
} from "./validation-plan.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const graph = buildImportGraph(packageRoot);
const realBrowserFiles = loadRealBrowserFiles(packageRoot);

function plan(changedRepoPaths) {
  return chooseValidationPlan({
    changedRepoPaths,
    packageRoot,
    graph,
    realBrowserFiles,
  });
}

describe("fail-closed validation plan", () => {
  it("runs a typical leaf through the direct-import set, not test:fast or the full suite", () => {
    const result = plan(["apps/mcp/src/bot/card-secret-tokens.ts"]);
    expect(result.kind).toBe(PLAN_KIND.DIRECT);
    expect(result.reason.startsWith("DIRECT_IMPORT:")).toBe(true);
    expect(result.tests).toEqual([
      "src/bot/__tests__/card-secret-tokens.test.ts",
      "src/tools/__tests__/inject-card-result.test.ts",
    ]);
  });

  it("falls back to test:fast when the map cannot prove a test irrelevant", () => {
    const result = plan(["apps/mcp/src/does-not-exist.ts"]);
    expect(result.kind).toBe(PLAN_KIND.TEST_FAST);
    expect(result.reason.startsWith("EMPTY_DIRECT_SET:")).toBe(true);
  });

  it("falls back to test:fast for selector/planner/tier-runner edits", () => {
    const result = plan(["apps/mcp/scripts/validation-plan.mjs"]);
    expect(result.kind).toBe(PLAN_KIND.TEST_FAST);
    expect(result.reason.startsWith("SELECTOR_SELF:")).toBe(true);
    expect(isSelectorSelf("scripts/run-test-tier.mjs")).toBe(true);
  });

  it("adds operate-session-flow when a session hub changes, instead of skipping it with test:fast", () => {
    const result = plan(["apps/mcp/src/bot/session/lifecycle.ts"]);
    expect(result.kind).toBe(PLAN_KIND.SESSION);
    expect(result.reason.startsWith("SESSION_HUB:")).toBe(true);
    expect(result.extras).toEqual([...SESSION_EXTRA_TESTS]);
    expect(isSessionHub("src/bot/oauth-login.ts")).toBe(true);
  });

  it("pays the full suite only for the browser/broker/config/lockfile cone", () => {
    expect(plan(["apps/mcp/src/bot/browser.ts"]).kind).toBe(PLAN_KIND.FULL);
    expect(plan(["apps/mcp/src/bot/broker/daemon.ts"]).kind).toBe(PLAN_KIND.FULL);
    expect(plan(["apps/mcp/vitest.tiers.ts"]).kind).toBe(PLAN_KIND.FULL);
    expect(plan(["pnpm-lock.yaml"]).kind).toBe(PLAN_KIND.FULL);
    expect(plan(["package.json"]).kind).toBe(PLAN_KIND.FULL);
    expect(plan(["apps/mcp/src/tools/inject-card.ts"]).kind).toBe(PLAN_KIND.FULL);
    expect(plan(["apps/mcp/src/bot/browser.ts"]).reason.startsWith("BROWSER_BROKER_CONFIG_CONE:")).toBe(
      true,
    );
    expect(plan(["pnpm-lock.yaml"]).reason.startsWith("LOCKFILE_OR_ROOT_CONFIG:")).toBe(true);
    expect(isFullSuiteCone("src/bot/card-secret-tokens.ts")).toBe(false);
  });

  it("does not escalate an api-only diff to mcp tests", () => {
    const result = plan(["apps/api/src/server.ts"]);
    expect(result.kind).toBe(PLAN_KIND.SKIP_MCP);
    expect(result.reason.startsWith("NO_MCP_CHANGE:")).toBe(true);
  });

  it("falls back to test:fast for an mcp workspace dependency, not the full suite", () => {
    const result = plan(["packages/skill-schema/src/index.ts"]);
    expect(result.kind).toBe(PLAN_KIND.TEST_FAST);
    expect(result.reason.startsWith("WORKSPACE_DEP:")).toBe(true);
  });

  it("never chooses the full suite for an unmapped leaf", () => {
    const kinds = [
      plan(["apps/mcp/src/bot/card-secret-tokens.ts"]).kind,
      plan(["apps/mcp/src/does-not-exist.ts"]).kind,
      plan(["apps/mcp/scripts/validation-plan.mjs"]).kind,
      plan(["packages/skill-schema/src/index.ts"]).kind,
      plan(["apps/api/src/server.ts"]).kind,
    ];
    expect(kinds).not.toContain(PLAN_KIND.FULL);
  });
});
