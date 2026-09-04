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

Interactive `connect`/`login` uses its persistent real profile too. The
plain Google-safe browser has no CDP attachment, and its completion is the
install claim plus the explicit Finish callback - not a cookie-file read.

## Lease, ownership, and containment

The profile lease resolves the recorded holder by host, PID, and process start
time. A proven-dead or absent holder is reaped and claimed; a live or
indeterminate holder returns `PROFILE_BUSY_MESSAGE`. There is no TTL.

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
purchase, host-scoped egress, payment/3DS audit order, vault restrictions, and
session addressing are unchanged. Browser teardown remains owner-bound and
session-scoped.
