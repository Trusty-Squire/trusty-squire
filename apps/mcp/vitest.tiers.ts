// Static release-test manifest. Keep the required/slow boundary reviewable in
// source: no generated test-name filters and no runtime tier inference.

export const MCP_TEST_INCLUDE_GLOBS = ["src/**/*.test.ts", "scripts/**/*.test.mjs"];

// These long browser/corpus/integration files run after every relevant merge
// and in the complete nightly suite. Unit and logic tests not listed here stay
// in the required fast-core glob.
export const SLOW_POST_MERGE_FILES = [
  "src/__tests__/bin-smoke.test.ts",
  "src/bot/__tests__/autocomplete-commit-confirm.test.ts",
  "src/bot/__tests__/browser-frame-support.test.ts",
  "src/bot/__tests__/google-login.test.ts",
  "src/bot/__tests__/locator-fallback.test.ts",
  "src/bot/__tests__/modal-overlay-inert.test.ts",
  "src/bot/__tests__/oauth-lifecycle.test.ts",
  "src/bot/__tests__/observe-delta.test.ts",
  "src/bot/__tests__/observe-jp-mojibake.test.ts",
  "src/bot/__tests__/operate-session-flow.test.ts",
  "src/bot/__tests__/phone-country-widget.test.ts",
  "src/bot/__tests__/widget-corpus-eval.test.ts",
  "src/eval/replay-harness/__tests__/replay-harness.test.ts",
];

// Every file here gates every release. Run whole files: never select or shard
// individual test names. This makes card sealing, approval, 3DS, credential
// dispatch, and payment outcome coverage obvious and fail-closed.
export const REQUIRED_PAYMENT_SAFETY_FILES = [
  "src/__tests__/tools.test.ts",
  "src/bot/__tests__/browser-decoupled-3ds.test.ts",
  "src/bot/__tests__/browser-payment.test.ts",
  "src/bot/__tests__/browser-screenshot.test.ts",
  "src/bot/__tests__/checkout-operator-fixes.test.ts",
  "src/bot/__tests__/credential-shape.test.ts",
  "src/bot/__tests__/manual-card-entry-guard.test.ts",
  "src/bot/__tests__/pay-operator.test.ts",
  "src/tools/__tests__/credential-tools.test.ts",
];

// Pre-existing quarantine owned by vitest.config.ts. It is intentionally not
// silently promoted into either release tier until its tracked OOM is fixed.
export const QUARANTINED_FILES = ["src/bot/__tests__/pay-mandate-web-seam.test.ts"];
