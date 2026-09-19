# DESIGN - operator profile lifecycle

The [browser broker](browser-broker.md) owns physical Chrome custody and the
real profile. This document owns live-profile OAuth admission and process
containment; broker discovery, session lifetime, and recovery are defined in the
broker guide. There is no seed, clone, portable storage state, or profile pool.

## Admission and OAuth

`BrowserController.detectSessionProviders()` reads cookies from that live
browser context. `googleSessionGate` admits Google only when that live probe
reports it; otherwise it returns a clear log-in-first `needs_user` result.
Ordinary operator admission never substitutes an on-disk cookie read for that
live-context probe.

Each start performs a fresh live account lookup to warm the profile before
provider detection, and reuses that lookup's email for session metadata.
Neither admission nor account metadata is cached across starts. The account
lookup itself is not the admission signal; the provider probe remains the gate.

Google OAuth stays in the same real-profile browser context. The serialized
OAuth boundary retains the authorized target and delegates to
`BrowserController.loginWithOAuth`; it never swaps or recreates the browser.

Interactive `connect` uses that real profile too. Its ceremony admission
exception, completion, and cookie-snapshot probes are owned by the
[broker guide](browser-broker.md).

## Lease, ownership, and containment

The profile lease resolves the recorded holder by host, PID, and process start
time. A proven-dead or absent holder is reaped and claimed; a live or
indeterminate holder returns `PROFILE_BUSY_MESSAGE`. There is no TTL.

### Recovering after reconnect

Use the [broker recovery contract](browser-broker.md#ownership-and-recovery-contracts)
for connection loss, retained session capabilities, and uncertain payment outcomes;
the [configuration section](browser-broker.md#configuration-and-operation) explains
the accepted fresh-lineage limitation after an operator process restart.
An unknown session is not a release receipt or permission to repeat a payment.
Use the original live connection to finish an owned session when available.
Never delete `SingletonLock` or manually kill a shared process to bypass custody.

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
session addressing are unchanged. Physical browser teardown remains owner-bound;
session tab-family teardown follows the [broker contract](browser-broker.md).
