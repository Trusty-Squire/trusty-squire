# DESIGN — isolated operator profile pool

Status: migration stage 3 implemented (2026-08-14). This document owns the operator profile-pool,
session lifecycle, and login-seed lifecycle. Payment authorization and secret-handling contracts
remain owned by [`SECURITY.md`](../SECURITY.md).

## 1. Stage boundary

Each `operate_start` now leases an isolated Chrome profile. The canonical profile used by
`connect` and `login` is an authoring source only: operator Chrome never opens it. A successful
Google login can publish a filtered, immutable seed generation, and a new worker profile is cloned
from that seed or reclaimed from one closed warm-profile slot.

Stage 3 retains the session-addressed payment and drain-before-finish gates while widening the
fixed pool for concurrent execution:

- two starts or active tasks at a time per profile-pool namespace;
- two filesystem active slots implement that bound;
- one closed warm-profile slot;
- one page within the leased worker profile.

A third `operate_start` in the same namespace waits at the provision seam for up to 30 seconds,
retrying the fixed slots without creating another profile or browser. Shutdown cancels starts
waiting for capacity before it releases active slots.

There is no warm Chrome process between sessions. `operate_finish` closes Chrome before its profile
can enter the warm slot.

```text
connect / Google login
  -> close canonical Chrome with proof
  -> copy only the identity seed under the seed lock
  -> atomically publish seed/current and delete non-current generations

operate_start
  -> reserve either active slot, or wait with the bounded retry while both are claimed
  -> under the seed lock, claim a current warm profile or clone seed/current
  -> launch Chrome on the claimed worker profile
  -> bind the worker's process birth identity and exact user-data directory
  -> validate identity through that worker

operate_finish
  -> stop admitting calls to this session and drain calls that already entered
  -> classify the remaining payment fence state for profile disposition
  -> clear the session's active payment and payment-field seal
  -> reset the page only for a reusable profile, then close Chrome with proof
  -> return a safe profile to the one warm slot; destroy or quarantine a payment-sensitive one
```

## 2. Filesystem model

The default pool lives under
`~/.trusty-squire/operator-profiles/namespaces/<source-profile-hash>/`. An explicit source profile
gets its own namespace. Pool directories and JSON descriptors are private (`0700` directories and
`0600` files).

```text
seed/
  .lock
  current -> generations/<generation>
  generations/<generation>/user-data/
profiles/<profile-id>/user-data/
active/slot-0 -> ../active-claims/<claim-id>/
active/slot-1 -> ../active-claims/<claim-id>/
active-claims/<claim-id>/
  owner.json
  claim/lease.json
warm/slot-0/lease.json
tombstones/
```

Seed generations are immutable after publication. A generation contains only Chrome's `Local
State`, provider/email markers, and selected Google identity cookies copied into a new SQLite cookie
store. Transient locks and caches are excluded. Pool ownership and lease metadata contain opaque
IDs, private tokens, timestamps, reuse counters, and process identity only.

Card data, payment approvals, mandates, sealed fields, and other payment material are never copied
into the seed or written to pool metadata.

## 3. Seed publication

Publication is allowed only when all of these conditions hold:

1. The runtime is Linux, where process birth identity can be proven.
2. A Google login completed during the current run. A preflight hit or cached marker is not enough.
3. The login Chrome process has closed and closure was proven.

The canonical profile operation guard remains held through login teardown and publication. One
filesystem seed lock serializes publication, `seed/current` resolution, warm-profile selection,
seed cloning, and generation garbage collection. Publication stages a new generation, validates a
completed-login proof captured from the actual interactive flow, atomically switches `seed/current`,
and then deletes every non-current generation. It does not open or independently revalidate a copy
of the candidate seed. This stage has no previous-generation grace window.

A failed login or uncertain close leaves the current generation unchanged.

## 4. Acquisition and reuse

`acquireWarmBrowser` remains the runtime seam, but it now always obtains an
`OperatorProfileLease` before constructing `BrowserController`.

Under the seed lock, acquisition:

1. scavenges only ownership states it can prove stale;
2. reserves the first free active slot with a private owner token;
3. claims the closed warm profile when it belongs to `seed/current` and is within its bounds; or
4. copies the current immutable seed into a new worker profile.

Capacity remains fixed at two active leases per namespace. A third start in that namespace retries
acquisition for at most 30 seconds, including time spent behind seed publication on the shared seed
lock, and launches only after one of those leases is released. Teardown cancels registered capacity
waiters and each start rechecks the shutdown generation after acquisition before launch.

Before the first seed exists, acquisition creates an empty worker profile; a caller that requires a
live identity then fails closed at the existing Google-session gate. Identity and email checks run
against the claimed worker profile, never the canonical profile or seed.

A warm profile is eligible for at most six hours idle, 50 reuses, or 24 hours of age. Bounds and
current-generation invalidation are enforced deterministically on the next serialized pool
operation; there is no background timer or daemon. Publishing a new seed therefore invalidates the
old warm profile before it can be claimed again.

## 5. Ownership and crash recovery

Seed-lock ownership records bind a host, PID, process start time, and private token. Given a valid
owner record, a contender reclaims the lock only when the recorded local process has exited or its
start time no longer matches. This never races a resuming holder, because a confirmed-dead process
cannot resume. Missing or malformed owner metadata is an ownerless artifact and retains the existing
30-second startup-grace cleanup; age never overrides a valid matching or cross-host owner. Such an
owner remains genuine contention indefinitely: wall-clock reclaim of a lock whose owner might still
be alive was evaluated and rejected as unsafe to make fully race-free, and would not help against an
already-running old-version orphaned process regardless. The operational mitigation for a
wedged-but-alive holder is identifying and killing that process by PID.

Raw PID equality is never authority to signal a process. A worker binding records host, PID, Linux
process start time, and the normalized expected `--user-data-dir`. Cleanup signals Chrome only when
both the process birth identity and exact worker-profile path still match.

Process shutdown has one exit owner per mode. During an interactive headless CLI login, the login
lifecycle temporarily suspends the general Chrome `SIGINT`/`SIGTERM` exit handlers, performs its
capped browser-and-rig teardown, and then restores them. In server mode those login exit handlers
remain disabled: on transport/stdin disconnect or a termination signal, the server coordinator
first drains every tracked OAuth-bootstrap login, then closes provision sessions and the server.
Cancellation and normal completion share one memoized, identity-proven browser teardown; process
`exit` hooks remain the force-kill backstop.

Destructive cleanup first atomically renames a claimable active or warm lease into `tombstones/`.
Only the private, unclaimable tombstone is inspected, signalled, or deleted. An unknown owner or
worker identity is retained for later inspection; it is not treated as stale. A verified matching
worker may be killed, but its profile is removed only after a later check proves that worker no
longer matches.

Lease tokens and active-owner tokens stay in private files. CDP is local loopback only in this
stage. `BOT_CDP_ENDPOINT` is rejected for isolated operator leases, and non-Linux operator profile
acquisition fails before launch.

## 6. Finish and the money fence

A profile may return to the closed warm slot only after the page reset succeeds, Chrome closure is
proven, its seed generation is still current, and the session has no payment-sensitive state.
Failure to prove closure quarantines the lease instead of pooling or deleting it.

`operate_finish` first marks the addressed session closing. New calls for that session are rejected,
calls that already acquired the session drain, and outcome preparation runs behind the same closed
admission gate. Remaining payment state never vetoes teardown. Finish records whether the profile is
destroy-required, clears the active payment object and payment-field seal, removes the session, and
then closes Chrome. A payment-sensitive profile is destroyed or quarantined instead of entering the
warm slot.

The profile is destroy-required when any of these are true at finish:

- an active payment object remains;
- payment fields remain sealed.

Destroy-required profiles never enter the warm slot. If Chrome closed with proof, the quarantined
profile is deleted. If closure is unknown, the profile remains quarantined and later scavenging uses
the bound worker identity before any signal or deletion. This keeps the existing payment money
fence intact without putting card or approval state into the pool.

## 7. Deferred stages

This stage does not add:

- a third active slot or dynamic operator capacity;
- safe cross-process handoff of a live CDP browser;
- remote-CDP generality, a CDP proxy, or an authentication service;
- new v1 configuration, a scheduler, daemon, or control plane;
- redundant public lease descriptors or previous-generation grace GC.

Those changes require their own migration stages. Live browser handoff remains separate from the
fixed two-session pool and is not required for isolated local controllers.

## 8. Code map

| Contract                                           | Owner                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Pool layout, seed lock, leases, warm slot, GC      | `apps/mcp/src/bot/operator-profile-pool.ts`                       |
| Process birth and profile-path identity            | `apps/mcp/src/bot/profile.ts`                                     |
| Local Chrome lifecycle and closure proof           | `apps/mcp/src/bot/browser.ts`                                     |
| Login lifecycle and seed-publication provenance     | `apps/mcp/src/bot/google-login.ts`                               |
| Acquire seam, payment selection, call drain, finish disposition | `apps/mcp/src/bot/provision-session.ts`              |
| Install provider-completion evidence               | `apps/mcp/src/bot/install-completion.ts`, `apps/web/app/install/` |
