# Investigation evidence — 2026-10-30

- Live Squire tools: Kling /app → Sign In shows Continue with Google in pixels and full text but no actionable control ref. Fresh screenshot clicks twice returned stale_screenshot with dispatch:not_dispatched. Session was closed without selecting an account.
- pnpm install --frozen-lockfile --ignore-scripts succeeded; sdk and skill-schema builds succeeded.
- Browser installer downloaded Chromium but stalled extracting. Manual unzip succeeded. Matching Chrome for Testing executable: /tmp/emberus-chrome147/chrome-linux64/chrome.
- Baseline with system Chrome: oauth-login, picker-window, new-tab-adoption, browser-oopif-observation passed; screenshot-click failed. Combined result: 149 passed, 11 failed, with timing failures during concurrent diagnostic work.
- Isolated screenshot suite against matching Chrome: 37 passed, 9 failed. See screenshot-baseline.log. Failures include child-frame points resolving to the parent frame and moved/replaced child targets unexpectedly dispatching.
- The existing separate-renderer screenshot test passes after adding an explicit iframe Target.getTargets assertion. Thus a general claim that OOPIF screenshots always fail is not supported.
- Isolated live Kling trials with system and matching Chrome reached only loading-shell text. Sign In locator timed out after 30000ms. See kling-isolated.log. No Google account chooser reached.
- Patchright dependency enables Target.setAutoAttach with waitForDebuggerOnStart, with matching runIfWaitingForDebugger paths. Its Debugger.enable occurrence is in JS coverage. Neither proves the live pause source.

Next: instrument hitTarget and geometry on the live broker reproduction, and diagnose why isolated Kling remains on the loading shell. Do not weaken screenshot freshness checks or assume a pause cause. No production fix or PR exists.
