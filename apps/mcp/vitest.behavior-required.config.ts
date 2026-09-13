import { defineConfig } from "vitest/config";
import { excludingRealBrowser, REQUIRED_BEHAVIOR_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

// Non-browser half of the required operator behavior tier (gates PRs and
// prereleases via test:fast). The real-browser half runs in
// vitest.real-browser.config.ts.
export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: excludingRealBrowser(REQUIRED_BEHAVIOR_FILES),
  },
});
