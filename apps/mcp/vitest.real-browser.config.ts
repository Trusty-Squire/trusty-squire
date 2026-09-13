import { defineConfig } from "vitest/config";
import { REAL_BROWSER_FILES, SLOW_POST_MERGE_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

// Real-browser tier: every test file that launches Chromium/Chrome. Runs
// post-merge (mcp-slow-tests.yml) and gates a stable/`latest` release
// (release.yml). Never runs on PRs or prerelease publishes — see
// REAL_BROWSER_FILES in vitest.tiers.ts.
export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: REAL_BROWSER_FILES,
    // Defensive: the two real-browser slow files stay in the slow tier only,
    // so a release run of this tier doesn't re-run them.
    exclude: SLOW_POST_MERGE_FILES,
  },
});
