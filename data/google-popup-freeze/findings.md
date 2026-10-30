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

## Fresh owned sessions and recovery guard (2026-10-30, 16:04–16:14 UTC)

Three new live Squire sessions on Kling /app were opened: 72e60ad2-f69c-4035-a662-a16cbcab5835, db1a5014-2273-42fe-8d23-d4d8fbb2deff, and 11bbfa6a-a546-437a-a55f-cd7356d37823. All reused the already signed-in profile. `operate_observe(query="Sign In")` returned `safe_table: []` in each. No Google popup click was possible on this page; these are three session attempts, not three completed popup trials. Logging out would affect the shared profile and Candy, so no logout, cookie clearing, account selection or account creation occurred. Each owned session was closed with operate_finish returning cleanup=closed.

`live-owned-trace-*.jsonl` records raw observer client attachments with autoAttach=true, waitForDebuggerOnStart=false, flatten=true, scoped to each owned page and descendants. Every observed attachment reported waitingForDebugger=false. The listener records Debugger.paused if delivered, but does not enable Debugger, so absence of that event is not proof that another client never paused. A separate CDP socket cannot observe other clients' commands or identify their session owners. It sent no Runtime.runIfWaitingForDebugger calls. The prior local protocol trace remains the evidence for Patchright's resume calls.

Reproduction GSI-4 (deliberate failure stand-in): the cross-site iframe opens a popup; a separate test CDP client enables Debugger and requests Debugger.pause before clicking the adopted popup's button. With the guard disabled, the same file fails `locator.click: Timeout 5000ms exceeded` at the popup button. With the guard enabled, it logs reason=other, resumes, and the button changes DOM state. This proves guard recovery, not the cause of the historical incident. The guard protocol test also verifies waitingForDebugger sends Runtime.runIfWaitingForDebugger and logs its reason, and that existing targets/ordinary tabs are not attached.

Commander explicitly requested this guard if no live cause was proved. The production attachment now installs it for new popup targets and their frames. No claim of a root-cause fix is made. The remaining live proof needs a signed-out Kling test session that does not log out or modify Candy's shared profile.

Guard validation, 16:15 UTC: whole popup-pause-guard, iframe-popup-cdp, oauth-login, google-login, new-tab-adoption and picker-window files completed with 176 passed and the same one baseline Google cancellation failure (expected unknown, received closed). Both new guard files pass. Build, ESLint, Prettier and diff whitespace checks pass.
