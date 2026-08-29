# DESIGN — operator profile lifecycle

Status: ephemeral per-session profiles implemented. This document owns operator
browser profile state, session teardown, crash recovery, and containment.
Payment authorization and secret-handling contracts remain owned by
[`SECURITY.md`](../SECURITY.md).

## 1. Session boundary

Each `operate_start` creates a unique `0700` Chrome user-data directory in the
system temporary directory. One session owns that directory and one browser
until its terminal transition. There is no shared profile pool, capacity slot,
warm browser, seed lock, lease daemon, or canonical-profile fallback.

The canonical `CHROME_PROFILE_DIR` remains the interactive `connect`/`login`
authoring profile. Operator browsers never open it. `TRUSTY_SQUIRE_PROFILE_DIR`
continues to select a separate canonical namespace for eval and Hermes use.

## 2. Portable login state

A successful context-backed interactive login captures Playwright
`storageState({ indexedDB: true })`. The snapshot includes all cookies, local
storage, and IndexedDB and is atomically stored as
`<CHROME_PROFILE_DIR>/trusty-squire-session-state.json` with mode `0600`.
Plain Chrome remains unattached throughout Google OAuth. After its proven close,
the login flow briefly reopens the canonical authoring profile in a headless
context, captures the same portable state, closes the context, and publishes the
snapshot. Snapshots larger than 4 MiB are ignored on read and skipped on write,
also preserving the prior snapshot.

Every operator browser restores that snapshot before its first target
navigation. `require_live_identity` runs the shared live-provider detector in
the fresh seeded browser. A stale identity fails closed with the context-backed
login handoff and cannot overwrite canonical state.

An explicitly successful result has either `data.confirmed: true` or a
confirmed `verify_recipe`. Credential outcomes succeed only after extraction
and vault storage complete without a blocker. No-outcome, failed, unconfirmed,
payment-active, payment-field-sealed, and pending-3DS sessions never publish a
snapshot.

## 3. Start and active ownership

`acquireWarmBrowser` is retained only as the internal session-acquisition seam.
It creates the private profile, reads portable state, constructs one
`BrowserController`, starts Chrome under the bounded launch owner, rechecks
shutdown cancellation after launch, and registers that controller to the
session. Repeated observe and act calls reuse the same browser.

Remote CDP is rejected for this path because it cannot prove ownership of the
private local profile. Startup cancellation closes the identity-bound browser,
releases its in-memory custody record, and schedules private-directory cleanup
only after closure is proven.

## 4. Finish and the money fence

`operate_finish` closes admission, drains calls that already entered, prepares
the explicit outcome, and runs the existing pending-3DS audit before clearing
payment state or releasing the browser. The rc.9 terminal owner retains its
30-second outer deadline, active-payment deferral, and exactly-once pending-3DS
audit/clear handoff.

For an eligible successful outcome, finish captures storage state before close,
proves the identity-scoped browser close, writes a private temporary snapshot,
then checks terminal ownership and performs the atomic rename without an async
yield between the check and commit. The last completed writer wins. A capture,
write, close-proof, or ownership failure preserves the prior snapshot.

After proven close, the in-memory browser lease is released and recursive
profile deletion is scheduled as detached best-effort cleanup. Neither normal
nor forced terminal completion awaits directory deletion. A failed deletion is
reported and leaves a harmless unique disk-leak residual until OS or manual cleanup.
An unproven close does not schedule deletion and retains that unique directory
for inspection.

## 5. Ownership, crash recovery, and containment

Raw PID equality is never authority to signal a process. A local browser binding
records the host, PID, Linux process start time, Trusty Squire launch marker,
and normalized expected `--user-data-dir`. Cleanup signals only processes whose
birth identity and exact private-profile path still match. Root-PID-only
signaling and broad `pkill` remain forbidden.

Every provision session owns the cross-platform rc.9 watchdog. Ten minutes
without an entered MCP operation closes an abandoned session. The 30-minute
lifetime check runs before the active-call guard, so continuous non-payment work
cannot extend the browser indefinitely. Maximum-lifetime and Linux CPU-budget
termination may defer only an active payment and only within the shared
terminal-transition deadline. Teardown performs the bounded pending-3DS live
check and metadata-only audit before clearing that state.

The 10-minute browser-start timeout and shutdown cancellation do not await an
unresolved launch. They race ordinary close with the bounded identity-proven
force boundary. Late launch settlement uses that controller's inherited marker
and profile identity, so it cannot signal a replacement session.

On Linux, each self-launched Chrome runs in a detached process group and marked
Chromium descendants are accounted together through `/proc`. Birth-safe
per-process CPU deltas enforce aggregate CPU and lifetime budgets after a root
process exits or a child reparents. The persistent-context fallback uses the
identity-proven profile-root snapshot captured for that launch.

That fallback remains best effort rather than strict containment. An idle
renderer that reparents after the snapshot can remain briefly, and a process
that forks and exits between watchdog polls is outside PID sampling. A spinning
or long-lived marked renderer is still caught. The accepted residual and the
strict cgroup follow-up remain tracked by
[`TODOS.md`](../TODOS.md#ts-operator-browser-cgroup-containment-p1-infra).

The terminal critical path contains browser force-close, lease release, and
payment/3DS audit publication or skip. Recursive deletion of profile files,
cache, and IndexedDB is detached after proven close. Cleanup failure can leak
only that session's unique directory; it cannot block another start, retain a
shared lock, or transfer browser custody.

## 6. Preserved invariants

Card sealing, one-human approval per purchase, host-scoped egress, payment and
3DS audit order, vault restrictions, session addressing, browser watchdogs,
and `TRUSTY_SQUIRE_PROFILE_DIR` isolation are unchanged. Profile cleanup does
not create a second teardown owner, lock, daemon, or shared reclamation path.
