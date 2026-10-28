# External application prompts and browser input

Chrome's external-protocol prompt is a tab-modal browser UI, separate from JavaScript alert/confirm/prompt dialogs. While it is open, a CDP mouse click can resolve without delivering any pointer or click events to the document. Page screenshots do not show this browser UI, and `Page.javascriptDialogOpening` does not report it.

## Reproduction rep-tiktok-consent

On the live TikTok consent page, the SDK navigated a child frame to `bytedance://dispatch_message/`. Window capture installed before site scripts recorded no input, even though Squire reported Continue as acted. The same session delivered trusted input on an about:blank button. Navigating that control page to the external protocol suppressed subsequent input too. A plain, self-launched headed Chrome with a fresh profile reproduced the failure without TikTok code or Squire click instrumentation. DOM `.click()` continued to work, explaining why the signing SDK was a misleading lead.

`browser-protocol-policy.ts` prepares Chrome's profile navigation preferences before an owned local launch. It denies URLs by default and exempts Chrome's browser schemes, preserving existing block/allow entries and unrelated preferences. This prevents external-application prompts without synthesizing clicks or changing observations, card masking, browser custody, or service configuration. Preferences are never rewritten while an existing Chrome holds the profile. Remote browser attachments are unchanged.

This deliberately prevents native app handoffs too. A top-level external-app navigation may show Chrome's blocked page; callers should continue through the website's browser path. Existing explicit allowlist entries are retained. Administrator policies can override profile preferences.

## Evidence and verification

- Before: repeated live Squire Continue clicks produced no authorization POST; plain headed Chrome's external-protocol fixture silently lost its next click.
- After applying the built profile preparation to the stopped live profile and restarting the existing OS-managed broker: Squire clicked Continue on a fresh Composio link for account `ca_d3t3fX3X30uX`. The network trace recorded `POST /passport/open/web/auth/v2/` (200) followed by `GET https://usebeeline.app/oauth/tiktok/callback/` with a code (200). No DOM activation fallback was used. The subsequent `beeline://` native handoff was blocked. Composio exchange is handled separately by the commander.
- The regression uses isolated profiles and headed Chrome, compares an unprotected baseline, asserts the protected click is trusted, and verifies HTTPS navigation afterward. It is Linux-specific because unknown external schemes have different OS handler behavior elsewhere.

Run `pnpm --filter @trusty-squire/mcp exec vitest run src/bot/__tests__/browser-external-protocol.test.ts`. The fixture allocates an isolated display if none is available.

Chromium's [external protocol handler](https://github.com/chromium/chromium/blob/148.0.7778.178/chrome/browser/external_protocol/external_protocol_handler.cc) owns the prompt; its [navigation policy integration](https://github.com/chromium/chromium/blob/148.0.7778.178/chrome/browser/chrome_content_browser_client.cc) explains why Fetch/Network URL interception does not reliably prevent it. The obsolete `protocol_handler.excluded_schemes` preference and the suggested `--disable-external-intent-requests` flag are not used.
