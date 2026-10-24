# Google login through the live viewer

## Reproduction google-viewer-popup

A viewer-canvas click on a Google-style button inside a cross-origin iframe
opens an account chooser popup. Before the fix, the popup stays open but
`controller.page === popup` remains false: the viewer streams the original
sign-in page. This proves missing popup adoption on the viewer-input path;
it does not implicate cross-origin input routing or popup blocking.

The fixture uses product.test and identity.test, site isolation, the served
viewer HTML, its canvas pointer handlers, the share WebSocket, and real Chrome.
Selecting the fixture account posts back to the product and closes the popup.
The fixture is explicitly labelled in the screenshots. It is not Google auth.

## Evidence ledger

### Observation 1 — initial live Squire read (2026-10-23)
Source: `operate_start` with the brief's x.com URL.
Result: title `Home / X`, timeline controls and Google login control present.
Conclusion: the shared profile already has an X login; a fresh session is not
an independently logged-out browser profile.

### Observation 2 — live Google transport (2026-10-23)
Source: `operate_navigate` to https://x.com/i/flow/login, followed by
`operate_click` on the observed Continue with Google control.
Result: accounts.google.com/v3/signin/accountchooser, heading `Choose an account`.
Conclusion: the agent path can reach the real Google chooser. No account was
selected and no Google/X account, password or vault entry was changed.
This is evidence about the installed broker, not this branch's fix.

### Observation 3 — before-fix viewer reproduction
Source: `vitest run src/bot/__tests__/operate-live-share.test.ts -t google-viewer-popup`.
Result: the canvas click opens a live identity.test/chooser popup; assertion
`controller.page === popup` fails (`expected false to be true`) after 3000 ms.
Conclusion: the viewer stays on the opener despite successful iframe input.

### Observation 4 — after-fix demonstration
Source: the same fixture, with viewer and agent driver variants.
Result: both pass; `observe` reports the chooser URL. The viewer receives green
chooser pixels, selects the account through its canvas, returns to gray product
pixels with `Signed in`, and ignores a foreign session's later popup.
Screenshots: [chooser](chooser-fixture.png), [returned product](returned-fixture.png).
Conclusion: Reproduction google-viewer-popup passes on this source branch.

### Observation 5 — focused regressions
Source: whole-file runs of operate-live-share, live-share-lifetime,
native-dialogs-browser, new-tab-adoption, and broker-tab-family.
Result: `Test Files 5 passed (5); Tests 45 passed | 1 skipped (46)`.
Conclusion: existing input/dialog/adoption/isolation paths pass alongside the fix.
Build and typecheck also exited 0.

### Observation 6 — real-viewer proof remains blocked
Source: isolated Chrome loading the browser-card share at the proxy hostname
specified by docs/operate-live-share.md, followed by getent and curl.
Result: `net::ERR_NAME_NOT_RESOLVED`; getent returns no address; curl exits 6,
`Could not resolve host: computer.usebeeline.app`.
Conclusion: this route cannot demonstrate the real X viewer flow here. The
updated source is not installed in the shared production broker. Real Google
chooser selection, popup close and completed X sign-in through the updated
shared viewer remain unproven; Ruby was notified. No release was dispatched.

## Test environment

Playwright's bundled browser was absent. Downloads stalled after reporting
completion and were stopped. Browser regressions used the installed Google
Chrome 148.0.7778.178 via temporary executable links under
/tmp/jellybean-system-chrome and PLAYWRIGHT_BROWSERS_PATH. The test setup keeps
HOME, config and browser profiles isolated; no cookies were copied from the
operator profile. The new test also supports the existing Chrome-channel
fallback when the bundled executable is absent.

### Observation 7 — corrected viewer route and authorized fallback
Source: Ruby's follow-up identifies computerSessionUrl() in Beeline's
apps/server/src/computer-session.ts and the active default origin
https://server.usebeeline.app. A fresh Squire session opened X's login route,
and browser_share started a fresh share in this corner.
Result: isolated Chrome gets HTTP 200 from the corrected viewer URL and reads
`Open Beeline and sign in to view this shared browser.` The page has no canvas;
the share's /status endpoint returns HTTP 403.
Conclusion: the obsolete hostname is no longer a blocker. The isolated viewer
requires Beeline sign-in. Per Ruby's explicit follow-up, deliver the PR with
fixture proof and the passing focused regressions. Real Google chooser click,
selection, popup return and completed X sign-in remain an owner check after
release. This is not a claim of real-viewer acceptance or a release dispatch.
The full local MCP suite is still running and is not counted as passing.
