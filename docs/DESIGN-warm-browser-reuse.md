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

## Kernel ownership and containment

One broker holds a `flock` on the canonical profile's stable lock inode for its
whole life. The file contains no owner data and is never removed. The kernel
releases the lock on every process exit, including SIGKILL. Sessions do not
acquire the lock; each owns only a tab family in the shared Chrome.

On Linux, Chrome starts inside one named systemd user scope per profile before
it forks. The broker stays outside that scope. The launch wrapper gives its
`systemd-run` parent a parent-death SIGINT, so Chrome exits when its broker
dies. A crash may lose cookies written in the last ~30 seconds. The next
broker, after claiming the lock, sends SIGINT to the
scope, waits briefly, then uses SIGKILL on the remaining scope members. Empty
scope population is the proof that physical custody ended. Chrome's own
`SingletonLock` is left to Chrome to handle.

Ordinary session expiry is a broker timer. It closes that session's tab family
and leaves sibling sessions and Chrome running. A tab close that misses its
bound is treated as a wedged shared browser and the scope is torn down. Google
OAuth sign-in uses a broker-local mutex; other sessions remain concurrent.

macOS and Windows retain ordinary Playwright close and process-group fallback
without Linux cgroup containment, so crash-orphan guarantees are weaker there.

### Recovery after reconnect

Use the [broker recovery contract](browser-broker.md#ownership-and-contracts)
for connection loss, retained session capabilities, and uncertain payment
outcomes. An unknown session is not a release receipt or permission to repeat
a payment.

## Preserved invariants

The compact-observation-v2 serializer, card sealing, one-human approval per
purchase, payment/3DS audit order, vault restrictions, and
session addressing are unchanged. Physical browser teardown remains owner-bound;
session tab-family teardown follows the [broker contract](browser-broker.md).
