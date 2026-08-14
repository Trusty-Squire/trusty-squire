# DESIGN — isolated operator profile pool

Status: migration stage 1 implemented (2026-08-14). This document owns the operator profile-pool
and login-seed lifecycle. Payment authorization and secret-handling contracts remain owned by
[`SECURITY.md`](../SECURITY.md).

## 1. Stage boundary

Each `operate_start` now leases an isolated Chrome profile. The canonical profile used by
`connect` and `login` is an authoring source only: operator Chrome never opens it. A successful
Google login can publish a filtered, immutable seed generation, and a new worker profile is cloned
from that seed or reclaimed from one closed warm-profile slot.

This stage deliberately preserves the existing concurrency behavior:

- one in-process start or active task at a time;
- one filesystem active slot per profile-pool namespace;
- one closed warm-profile slot;
- one page within the leased worker profile.

There is no warm Chrome process between sessions. `operate_finish` closes Chrome before its profile
can enter the warm slot.

```text
connect / Google login
  -> close canonical Chrome with proof
  -> copy only the identity seed under the seed lock
  -> validate Google identity through a disposable clone
  -> close validation Chrome with proof
  -> atomically publish seed/current and delete non-current generations

operate_start
  -> reserve the one active slot
  -> under the seed lock, claim a current warm profile or clone seed/current
  -> launch Chrome on the claimed worker profile
  -> bind the worker's process birth identity and exact user-data directory
  -> validate identity through that worker

operate_finish
  -> classify payment state
  -> reset the page and close Chrome with proof
  -> return a safe profile to the one warm slot, otherwise destroy or quarantine it
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
4. A disposable clone of the candidate seed reaches `myaccount.google.com` as signed in.
5. The validation Chrome process also closes with proof.

The canonical profile operation guard remains held through login teardown and publication. One
filesystem seed lock serializes publication, `seed/current` resolution, warm-profile selection,
seed cloning, and generation garbage collection. Publication stages a new generation, validates a
separate clone rather than the canonical profile or immutable candidate, atomically switches
`seed/current`, and then deletes every non-current generation. This stage has no previous-generation
grace window.

A failed login, uncertain close, failed validation, or uncertain validation close leaves the
current generation unchanged.

## 4. Acquisition and reuse

`acquireWarmBrowser` remains the runtime seam, but it now always obtains an
`OperatorProfileLease` before constructing `BrowserController`.

Under the seed lock, acquisition:

1. scavenges only ownership states it can prove stale;
2. reserves the single active slot with a private owner token;
3. claims the closed warm profile when it belongs to `seed/current` and is within its bounds; or
4. copies the current immutable seed into a new worker profile.

Before the first seed exists, acquisition creates an empty worker profile; a caller that requires a
live identity then fails closed at the existing Google-session gate. Identity and email checks run
against the claimed worker profile, never the canonical profile or seed.

A warm profile is eligible for at most six hours idle, 50 reuses, or 24 hours of age. Bounds and
current-generation invalidation are enforced deterministically on the next serialized pool
operation; there is no background timer or daemon. Publishing a new seed therefore invalidates the
old warm profile before it can be claimed again.

## 5. Ownership and crash recovery

Raw PID equality is never authority to signal a process. A worker binding records host, PID, Linux
process start time, and the normalized expected `--user-data-dir`. Cleanup signals Chrome only when
both the process birth identity and exact worker-profile path still match.

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

The profile is destroy-required when any of these are true at finish:

- an active payment object remains;
- payment fields remain sealed; or
- a money-path replay has not reached a verified payment guard.

Destroy-required profiles never enter the warm slot. If Chrome closed with proof, the quarantined
profile is deleted. If closure is unknown, the profile remains quarantined and later scavenging uses
the bound worker identity before any signal or deletion. This keeps the existing payment money
fence intact without putting card or approval state into the pool.

## 7. Deferred stages

This stage does not add:

- a second active slot or concurrent operator execution;
- safe cross-process handoff of a live CDP browser;
- session-addressed payment state, resolve-once semantics, or drain-before-finish gates;
- remote-CDP generality, a CDP proxy, or an authentication service;
- new v1 configuration, a scheduler, daemon, or control plane;
- redundant public lease descriptors or previous-generation grace GC.

Those changes require their own migration stages. In particular, the second active slot must remain
disabled until browser handoff and payment ownership are session-safe.

## 8. Code map

| Contract                                           | Owner                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Pool layout, seed lock, leases, warm slot, GC      | `apps/mcp/src/bot/operator-profile-pool.ts`                       |
| Process birth and profile-path identity            | `apps/mcp/src/bot/profile.ts`                                     |
| Local Chrome lifecycle and closure proof           | `apps/mcp/src/bot/browser.ts`                                     |
| Login teardown, seed publication, clone validation | `apps/mcp/src/bot/google-login.ts`                                |
| Acquire seam, identity probe, finish disposition   | `apps/mcp/src/bot/provision-session.ts`                           |
| Install provider-completion evidence               | `apps/mcp/src/bot/install-completion.ts`, `apps/web/app/install/` |
