// Local vitest config so vitest doesn't walk up to the repo-root
// vite.config.ts (which belongs to an unrelated sibling project and
// has a `root:` that breaks when resolved from this package).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Real Chromium fixtures compete for the same CPU/CDP resources when
    // Vitest fans them out across workers. Keep those files in one serial
    // fork while the unit-test threads continue to run in parallel.
    poolMatchGlobs: [
      ["src/bot/__tests__/autocomplete-commit-confirm.test.ts", "forks"],
      ["src/bot/__tests__/browser-decoupled-3ds.test.ts", "forks"],
      ["src/bot/__tests__/browser-frame-support.test.ts", "forks"],
      ["src/bot/__tests__/browser-payment.test.ts", "forks"],
      ["src/bot/__tests__/browser-screenshot.test.ts", "forks"],
      ["src/bot/__tests__/checkout-operator-fixes.test.ts", "forks"],
      ["src/bot/__tests__/locator-fallback.test.ts", "forks"],
      ["src/bot/__tests__/modal-overlay-inert.test.ts", "forks"],
      ["src/bot/__tests__/oauth-lifecycle.test.ts", "forks"],
      ["src/bot/__tests__/observe-jp-mojibake.test.ts", "forks"],
      ["src/bot/__tests__/phone-country-widget.test.ts", "forks"],
      ["src/bot/__tests__/shadow-dom-topmost.test.ts", "forks"],
      ["src/bot/__tests__/widget-corpus-eval.test.ts", "forks"],
      ["src/eval/replay-harness/__tests__/replay-harness.test.ts", "forks"],
    ],
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // TEMP quarantine - pre-existing unbounded cross-file memory leak
    // crashes a vitest worker, NOT a functional failure; tracked in
    // operator-mandate-web-seam-test-oom, un-quarantine after fix.
    exclude: ["src/bot/__tests__/pay-mandate-web-seam.test.ts"],
  },
});
