import { defineConfig } from "vitest/config";
import { excludingRealBrowser, REQUIRED_PAYMENT_SAFETY_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

// Non-browser half of the required payment-safety tier (gates PRs and
// prereleases via test:fast). The real-browser half (browser-inject-card,
// browser-screenshot) runs in vitest.real-browser.config.ts.
export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: excludingRealBrowser(REQUIRED_PAYMENT_SAFETY_FILES),
  },
});
