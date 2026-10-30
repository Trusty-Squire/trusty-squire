# Investigation evidence — 2026-10-30

- Live Squire tools: Kling /app → Sign In shows Continue with Google in pixels and full text but no actionable control ref. Fresh screenshot clicks twice returned stale_screenshot with dispatch:not_dispatched. Session was closed without selecting an account.
- pnpm install --frozen-lockfile --ignore-scripts succeeded; sdk and skill-schema builds succeeded.
- Browser installer downloaded Chromium but stalled extracting. Manual unzip succeeded. Matching Chrome for Testing executable: /tmp/emberus-chrome147/chrome-linux64/chrome.
- Baseline with system Chrome: oauth-login, picker-window, new-tab-adoption, browser-oopif-observation passed; screenshot-click failed. Combined result: 149 passed, 11 failed, with timing failures during concurrent diagnostic work.
- Isolated screenshot suite against matching Chrome: 37 passed, 9 failed. See screenshot-baseline.log. Failures include child-frame points resolving to the parent frame and moved/replaced child targets unexpectedly dispatching.
- The existing separate-renderer screenshot test passes after adding an explicit iframe Target.getTargets assertion. Thus a general claim that OOPIF screenshots always fail is not supported.
- Isolated live Kling trials with system and matching Chrome reached only loading-shell text. Sign In locator timed out after 30000ms. See kling-isolated.log. No Google account chooser reached.
- Patchright dependency enables Target.setAutoAttach with waitForDebuggerOnStart, with matching runIfWaitingForDebugger paths. Its Debugger.enable occurrence is in JS coverage. Neither proves the live pause source.

At this earlier checkpoint no production fix existed. The later evidence below supersedes that status; draft PR #1120 now carries the investigation and GSI capture fix.

## Local fixture and alternate GSI target (2026-10-30)

Reproduction GSI-2: self-launched Chrome with a temporary profile, Patchright
connectOverCDP, a 127.0.0.1 parent and localhost iframe, and a popup sharing the
iframe origin. Explicit debugger statements run in the iframe, its click handler
and popup. The iframe is asserted to be a separate CDP target. Canonical capture
finds its button; BrowserController adopts the popup and reads its button; a
trusted click sets the popup's observed DOM state. This path passes unchanged.
`local-cdp-evidence.json` summarizes DEBUG=pw:protocol output: waiting iframe and
popup targets receive runIfWaitingForDebugger on their own sessions; no
Debugger.enable command or Debugger.paused event appears. This rules out both
proposed causes in this fixture, not in the historical Kling incident.

Next tested: Pinterest /login has a real accounts.google.com/gsi/button iframe.
Canonical observe exposes its Continue with Google ref with x=x. operate_drive
omits that same button. Source confirms drive only captures payment, covering,
or captcha frames. The patch includes GSI button frames without requiring those
conditions. A regression exercises a low-confidence drive handoff and clicks its
returned cross-origin ref. Live Pinterest clicks left the login page unchanged;
no account chooser, consent, or account creation was claimed. The session closed.

## Validation ledger (2026-10-30, current patch)

- Source: `pnpm --filter @trusty-squire/mcp build`; exit 0. Production build passes.
- Source: whole `operate-drive-fixture.test.ts` with matching Chromium; 124 passed, 1 skipped. GSI-3 stand-in returns the cross-origin button and clicking its ref changes the iframe DOM as expected.
- Source: `iframe-popup-cdp`, `new-tab-adoption`, `picker-window`, `google-login`, `oauth-login` whole-file run; 170 passed, 6 failed. New popup fixture, new-tab and picker files pass. Google failures include missing better-sqlite3 native bindings after ignore-scripts install; OAuth failures concern tight callback deadlines. Installed the native prebuild and reran both login files; outcome recorded below when complete.
- Source: Prettier check and git diff --check; pass.

Exact protocol excerpt for GSI-2 (other setup messages omitted):
```
2026-10-30T15:48:58.343Z pw:protocol ◀ RECV {"method":"Target.attachedToTarget","params":{"sessionId":"54C291C14D7A970CC8AC61992A6AD186","targetInfo":{"targetId":"701898CC002B5CF3EC0B396C1E93566A","type":"page","title":"","url":"","attached":true,"openerId":"90437BA3C8E18AB20BE999DC00D9D2E7","canAccessOpener":true,"openerFrameId":"3998E72AD9E21B4DC6373A6E51D46297","browserContextId":"A52C56733D374D6DD0CD28CA6C9D565F"},"waitingForDebugger":true}}
2026-10-30T15:48:58.344Z pw:protocol SEND ► {"id":236,"method":"Page.setFontFamilies","params":{"fontFamilies":{"standard":"Times New Roman","fixed":"Monospace","serif":"Times New Roman","sansSerif":"Arial","cursive":"Comic Sans MS","fantasy":"Impact"}},"sessionId":"54C291C14D7A970CC8AC61992A6AD186"}
2026-10-30T15:48:58.354Z pw:protocol ◀ RECV {"id":236,"result":{},"sessionId":"54C291C14D7A970CC8AC61992A6AD186"}
2026-10-30T15:48:58.344Z pw:protocol SEND ► {"id":238,"method":"Runtime.runIfWaitingForDebugger","sessionId":"54C291C14D7A970CC8AC61992A6AD186"}
Debugger.enable commands: 0
Debugger.paused events: 0
IFRAME_POPUP_PASS: cross-site control captured; popup adopted; debugger statements completed; chooser responds
```

Dependency inspection: installed Patchright coreBundle.js enables Debugger only in JSCoverage.start (line 35231), immediately alongside setSkipAllPauses; that path is not called by the fixture. Auto-attach at lines 37541 and 38353 has resume paths including lines 37577 and 37796. Rebrowser has the same coverage-only Debugger.enable pattern. The protocol trace, rather than those source paths alone, establishes that the owned fixture resumes.

Final login validation: after native dependency repair, oauth-login.test.ts passed all 94 tests (Google/GitHub popup and return paths). google-login.test.ts passed 62 and failed one lifecycle guard: `never adopts a replacement profile holder after cancellation`, expected `unknown`, received `closed` at line 302. Re-running the entire Google file with the production operate-drive.ts restored from HEAD reproduced that same failure (62 passed, 1 failed); the GSI patch was restored afterward. This is an unchanged baseline failure, not a claimed green suite. The new-tab-adoption and picker-window files passed in the combined run. No public Google chooser was reached.
