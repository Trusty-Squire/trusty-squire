# Broker increment evidence ledger

Observations below describe development runs, not a published or deployed release.
All task artifacts are under the disposable worktree; acceptance profiles are
explicit fixtures. Timestamps are UTC.

| Observation | Tool/source | Result and inference |
| --- | --- | --- |
| Initial inventory assertion, 2026-09-07 | `chrome-devtools-axi run`; `.broker-inventory-diagnostic.log` | Assertion counted zero roots. Diagnostic showed Chrome PID 2026187 with a rewritten, space-delimited process title in one argv entry. The assertion was wrong; this run did not pass acceptance. |
| Inventory fix, 2026-09-07 | Executable `broker-process-inventory` tests | NUL-delimited arguments preserve spaces inside values. Chrome's single-entry rewritten title is tokenized separately; renderer/zygote arguments remain distinguishable. |
| Earlier failed fixture cleanup, 2026-09-07 | Exact fixture reaper manifest and `sweepOrphanedOwnerProcesses` | A stale reaper persisted because an unrelated unreadable process group poisoned a dead group's proof. `profileProcessGroupMarkerState` now ignores a proven different group before reading its marker; 3 behavioral regressions cover the boundary. Exact fixture cleanup completed. |
| Mechanical fixture after parser repair, 2026-09-07T20:23Z | `chrome-devtools-axi run`; `.broker-fixed-inventory.log` | Three separate OS clients, one Chrome root, authenticated provisioning on three loopback origins, overlapping activity, client SIGKILL isolation, cookies after browser reopen, empty baseline and final inventory. Fixture only, not real Google. |

Final-build acceptance and required-test results are appended after their commands finish.

- **2026-09-07T20:30Z**, `chrome-devtools-axi run` on the updated build: [raw mechanical evidence](mechanical-three-process.json). Broker PID 2315404; Chrome root [2315453]; client PIDs [2315418, 2315419, 2315420]; three distinct targets and sessions; common activity overlap **1485 ms**. Three fixture services provisioned; first client exited by SIGKILL; siblings retained authentication; cookies survived reopen; process inventory `[] → []`.
- **2026-09-07T20:30Z**, `vitest run broker-runtime broker-authority broker-process-inventory`: **3 files, 14 tests passed** on the latest runtime changes.
- **2026-09-07T20:33Z**, production daemon regression: startup failed when profile and broker election locks shared the same directory. Separated the election namespace; no browser was launched in the failing run.
- **2026-09-07T20:34Z**, `vitest run broker-daemon.test.ts`: **1 file, 1 test passed**. Actual broker child retained live clients, drained plain-login maintenance, accepted refreshed account credentials and refused old credentials, then exited 0 and removed its socket and ownership record.

- **2026-09-07T20:36Z**, `pnpm --filter @trusty-squire/mcp test:fast`, exit 0: core **88 files / 1,494 passed / 1 skipped**; required operator behavior **23 files / 642 passed / 3 skipped**; required payment safety **9 files / 469 passed**. Total **2,605 passed, 4 existing skips**. No safety or operator file moved to the slow tier.
- **2026-09-07T20:37Z**, additional required `broker-daemon.test.ts`, exit 0: **1 test passed**, including maintenance-client loss followed by authentication using the refreshed credential. This file was added to the required behavior manifest after the full run began; it was executed separately. Together the current manifest has **121 passing files / 2,606 passed / 4 existing skips**.
- Final runtime changes were covered again by the focused **14-test** authority/runtime/inventory run. Final daemon changes were covered by the separate actual-daemon test. Build, typecheck, changed-file lint, formatting, and `git diff --check` passed; full command logs remain in ignored `.broker-*.log` development artifacts.
- **Qualification not executed:** no real enrolled test Google identity or authorized three-service driver configuration is held in this worktree. The exact required human setup is in `docs/browser-broker.md`. No production default was changed, no package was published, and no PR was merged. The committed increment still needs the project's no-mistakes delivery gate.
