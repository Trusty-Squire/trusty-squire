// Static release-test manifest. Keep the required/slow boundary reviewable in
// source: no generated test-name filters and no runtime tier inference.

export const MCP_TEST_INCLUDE_GLOBS = ["src/**/*.test.ts", "scripts/**/*.test.mjs"];

// These long browser/corpus/integration files run after every relevant merge
// and in the complete nightly suite. Unit and logic tests not listed here stay
// in the required fast-core glob. Genuinely slow NON-behavioral files only:
// operator fail-closed/OAuth/payment/observation behavior files live in
// REQUIRED_BEHAVIOR_FILES below (its non-browser half gates every pull
// request; its real-browser half runs in REAL_BROWSER_FILES' tier).
export const SLOW_POST_MERGE_FILES = [
  "src/__tests__/bin-smoke.test.ts",
  "src/bot/__tests__/widget-corpus-eval.test.ts",
];

// Test files that launch a real browser (Chromium via playwright/patchright
// directly, or real Chrome through the broker/self-launch child processes).
// They are the slowest, flakiest part of the suite, so they do NOT gate pull
// requests or prerelease publishes: they run post-merge (mcp-slow-tests.yml)
// and gate only a stable/`latest` release (release.yml's real-browser tier).
// Disjoint from SLOW_POST_MERGE_FILES (widget-corpus-eval is also real-browser
// but stays in the slow tier; the full `vitest run` nightly suite covers
// everything regardless).
// Keep in sync with reality: every file here must launch a browser, and every
// browser-launching test file must be listed here (grep for
// `chromium.launch|patchrightChromium.launch|connectOverCDP|launchPersistentContext`
// plus broker tests driving real Chrome via UNIVERSAL_BOT_CHROME_BINARY).
export const REAL_BROWSER_FILES = [
  "src/__tests__/broker-default-start.test.ts",
  "src/__tests__/capture-postaction-e2e.test.ts",
  "src/bot/__tests__/action-compact-browser.test.ts",
  "src/bot/__tests__/browser-ax-faithful-controls.test.ts",
  "src/bot/__tests__/autocomplete-commit-confirm.test.ts",
  "src/bot/__tests__/broker-routing.test.ts",
  "src/bot/__tests__/broker-shared-browser-wire.test.ts",
  "src/bot/__tests__/broker-stdio-restart.test.ts",
  "src/bot/__tests__/broker-tab-family.test.ts",
  "src/bot/__tests__/browser-close-cookie.test.ts",
  "src/bot/__tests__/browser-document-identity.test.ts",
  "src/bot/__tests__/browser-frame-binding.test.ts",
  "src/bot/__tests__/browser-frame-support.test.ts",
  "src/bot/__tests__/browser-gmail-inbox-read.test.ts",
  "src/bot/__tests__/browser-hosted-field-remount.test.ts",
  "src/bot/__tests__/browser-inject-card.test.ts",
  "src/bot/__tests__/browser-oopif-observation.test.ts",
  "src/bot/__tests__/browser-screenshot.test.ts",
  "src/bot/__tests__/browser-three-ds-method.test.ts",
  "src/bot/__tests__/browser-three-ds-notify.test.ts",
  "src/bot/__tests__/browser-unrestricted-egress.test.ts",
  "src/bot/__tests__/captcha-solve-token-signal.test.ts",
  "src/bot/__tests__/click-actionability-bound.test.ts",
  "src/bot/capture/__tests__/credential-capture-browser.test.ts",
  "src/bot/__tests__/hcaptcha-inject-coresident.test.ts",
  "src/bot/__tests__/recaptcha-checkbox-frame-click.test.ts",
  "src/bot/__tests__/locator-fallback.test.ts",
  "src/bot/__tests__/modal-overlay-inert.test.ts",
  "src/bot/__tests__/mutation-checkpoint-boundaries.test.ts",
  "src/bot/__tests__/new-tab-adoption.test.ts",
  "src/bot/__tests__/oauth-login.test.ts",
  "src/bot/__tests__/observation-dom-correctness.test.ts",
  "src/bot/__tests__/observation-prose.test.ts",
  "src/bot/__tests__/observe-jp-mojibake.test.ts",
  "src/bot/__tests__/operate-session-flow.test.ts",
  "src/bot/__tests__/operate-drive-fixture.test.ts",
  "src/bot/__tests__/operate-drive-matrix.test.ts",
  "src/bot/__tests__/operator-click-fallback.test.ts",
  "src/bot/__tests__/operator-login-read-browser.test.ts",
  "src/bot/__tests__/operator-ref-recovery-flow.test.ts",
  "src/bot/__tests__/phone-country-widget.test.ts",
  "src/bot/__tests__/picker-window.test.ts",
  "src/bot/__tests__/screenshot-click.test.ts",
  "src/bot/__tests__/screenshot-target-diagnostic.test.ts",
  "src/bot/__tests__/select-option-ambiguity.test.ts",
  "src/bot/__tests__/shadow-dom-topmost.test.ts",
];

// Tier helpers: the behavior/payment lists below document FULL coverage;
// the fast tiers run their non-browser halves only.
export function excludingRealBrowser(files: string[]): string[] {
  return files.filter((f) => !REAL_BROWSER_FILES.includes(f));
}

// Operator behavior suites. These exercise the operator's fail-closed
// session/OAuth/observation surfaces. The non-browser half gates every pull
// request (via test:fast, alongside REQUIRED_PAYMENT_SAFETY_FILES' non-browser
// half); the real-browser half runs in the real-browser tier (post-merge and
// stable release). They run whole files — never select or shard individual
// test names — same contract as REQUIRED_PAYMENT_SAFETY_FILES. The nightly
// full suite still covers everything as a drift backstop.
export const REQUIRED_BEHAVIOR_FILES = [
  "src/bot/__tests__/browser-display-geometry.test.ts",
  "src/__tests__/broker-default-start.test.ts",
  "src/bot/__tests__/broker-discovery.test.ts",
  "src/bot/__tests__/broker-daemon.test.ts",
  "src/bot/__tests__/broker-runtime.test.ts",
  "src/bot/__tests__/broker-forwarder.test.ts",
  "src/bot/__tests__/broker-maintenance.test.ts",
  "src/bot/__tests__/broker-authority.test.ts",
  "src/bot/__tests__/broker-prior-contract-reclaim.test.ts",
  "src/bot/__tests__/broker-stdio-restart.test.ts",
  "src/bot/__tests__/broker-transport.test.ts",
  "src/bot/__tests__/broker-wire-protocol.test.ts",
  "src/bot/__tests__/broker-shared-browser-wire.test.ts",
  "src/bot/__tests__/broker-routing.test.ts",
  "src/bot/__tests__/captcha-autosolve-lifecycle.test.ts",
  "src/bot/__tests__/autocomplete-commit-confirm.test.ts",
  "src/bot/__tests__/browser-document-identity.test.ts",
  "src/bot/__tests__/browser-process-page-boundary.test.ts",
  "src/bot/__tests__/browser-frame-support.test.ts",
  "src/bot/__tests__/google-login.test.ts",
  "src/bot/__tests__/identity-runtime.test.ts",
  "src/bot/__tests__/locator-fallback.test.ts",
  "src/bot/__tests__/modal-overlay-inert.test.ts",
  "src/bot/__tests__/broker-tab-family.test.ts",
  "src/bot/__tests__/new-tab-adoption.test.ts",
  "src/bot/__tests__/oauth-login.test.ts",
  "src/bot/__tests__/observation-dom-correctness.test.ts",
  "src/bot/__tests__/observe-delta.test.ts",
  "src/bot/__tests__/observe-jp-mojibake.test.ts",
  "src/bot/__tests__/operate-session-flow.test.ts",
  "src/bot/__tests__/operator-click-fallback.test.ts",
  "src/bot/__tests__/operator-ref-recovery-flow.test.ts",
  "src/bot/__tests__/phone-country-widget.test.ts",
  "src/bot/__tests__/screenshot-click.test.ts",
  "src/bot/__tests__/screenshot-target-diagnostic.test.ts",
  "src/bot/__tests__/three-ds-detection.test.ts",
];

// Every file here gates every stable release (its non-browser half also gates
// every PR and prerelease). Run whole files: never select or shard individual
// test names. This keeps the narrow released-card output mask, single purchase
// approval, targeted injection, and credential dispatch in the required tier.
export const REQUIRED_PAYMENT_SAFETY_FILES = [
  "src/__tests__/tools.test.ts",
  "src/bot/__tests__/card-value-output-mask.test.ts",
  "src/bot/__tests__/browser-inject-card.test.ts",
  "src/bot/__tests__/operator-evidence.test.ts",
  "src/bot/__tests__/browser-screenshot.test.ts",
  "src/bot/__tests__/card-release-approval.test.ts",
  "src/tools/__tests__/inject-card-result.test.ts",
  "src/bot/__tests__/browser-three-ds-notify.test.ts",
  "src/bot/__tests__/credential-shape.test.ts",
  "src/tools/__tests__/credential-tools.test.ts",
];

// Pre-existing quarantine owned by vitest.config.ts. It is intentionally not
// silently promoted into either release tier until its tracked OOM is fixed.
export const QUARANTINED_FILES: string[] = [];
