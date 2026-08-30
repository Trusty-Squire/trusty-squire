// Runtime/pool settings shared by the complete, required, and slow configs.
export const MCP_TEST_RUNTIME = {
  // Real Chromium fixtures compete for the same CPU/CDP resources when Vitest
  // fans them out across workers. Keep them serial inside each tier process.
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
};
