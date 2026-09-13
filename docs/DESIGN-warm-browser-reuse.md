# DESIGN - operator profile lifecycle

The operator has one browser/profile path: every `operate_start` opens the
user's real `CHROME_PROFILE_DIR` and holds its profile lease until
`operate_finish` or terminal teardown. There is no seed, clone, portable
storage state, profile pool, or browser replacement.

## Admission and OAuth

`BrowserController.detectSessionProviders()` reads cookies from that live
browser context. `googleSessionGate` admits Google only when that live probe
reports it; otherwise it returns a clear log-in-first `needs_user` result.
The profile's cookie database is never read for identity admission or login
completion.

Google OAuth stays in the same real-profile browser context. The serialized
OAuth boundary retains the authorized target and delegates to
`BrowserController.loginWithOAuth`; it never swaps or recreates the browser.

Interactive `connect` - the one onboarding and re-auth pathway - uses its
persistent real profile too. The
plain Google-safe browser has no CDP attachment, and its completion is the
install claim plus the explicit Finish callback - not a cookie-file read.

## Lease, ownership, and containment

The profile lease resolves the recorded holder by host, PID, and process start
time. A proven-dead or absent holder is reaped and claimed; a live or
indeterminate holder returns `PROFILE_BUSY_MESSAGE`. There is no TTL.

After an MCP restart or reconnect, call `operate_start` for a new session.
If the old Chrome still holds `SingletonLock`, admission awaits the Linux
owner reaper for manifests naming that profile before checking the lock again.
This also recovers when the detached watchdog has not polled yet or has exited.
The reaper must prove the recorded MCP owner is dead and the browser's process
birth identity and profile still match before bounded TERM-to-KILL cleanup.
Live or indeterminate owners and browsers without a valid ownership manifest
remain busy. Reconnect never kills a live shared MCP server. Session IDs belong
to their original server: `operate_finish` on a replacement cannot adopt or
close an old ID; recovery starts a fresh session after the owner is gone.

### Recovering after reconnect

Automatic reclaim is limited to proven-dead owners. If the previous server is
still alive, use its existing MCP connection to call `operate_finish` with the
live session ID. Wait for cleanup to complete, then call `operate_start` on the
replacement. Finishing releases that session's browser and profile lease; if
other sessions share the browser, their leases remain until they finish too.
An `unknown provision session` response from the replacement is not a release
receipt: route the finish call to the owning connection.

For a superseded server dedicated to the same home, the host can instead close
that server's MCP transport/stdin through its normal disconnect/stop action.
The local server shutdown handler drains admitted calls and closes its sessions
and browsers before exiting. Only stop an instance known to be dedicated to
that home; never stop a shared server serving other lanes or homes. Do not
delete `SingletonLock` or manually kill processes to bypass live ownership.

If reconnect leaves the old transport open and its connection is no longer
addressable, automatic clean shutdown at the host reconnect/ownership boundary
is follow-up work. This change does not implement live-server takeover; the
profile stays busy until the owning session is finished or its dedicated server
is cleanly disconnected. After that release, retry `operate_start`; Linux
admission can recover any remaining browser recorded to a proven-dead owner.

Raw PID equality is never authority to signal a process. A local browser binding
records the host, PID, Linux process start time, Trusty Squire launch marker,
and normalized expected `--user-data-dir`. Cleanup signals only processes whose
birth identity and exact profile path still match. Root-PID-only signaling and
broad `pkill` remain forbidden.

Every provision session owns the cross-platform watchdog. The 10-minute
browser-start timeout and shutdown cancellation race ordinary close with the
bounded identity-proven force boundary. On Linux, each self-launched Chrome runs
in a detached process group; marked Chromium descendants are accounted through
`/proc` and bounded SIGTERM-to-SIGKILL cleanup.

The accepted residual is a briefly reparented idle renderer. The strict cgroup
follow-up remains tracked by
[`TODOS.md`](../TODOS.md#ts-operator-browser-cgroup-containment-p1-infra).

## Preserved invariants

The compact-observation-v2 serializer, card sealing, one-human approval per
purchase, payment/3DS audit order, vault restrictions, and
session addressing are unchanged. Browser teardown remains owner-bound and
session-scoped.
