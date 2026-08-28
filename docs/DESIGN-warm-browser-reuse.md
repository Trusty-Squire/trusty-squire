# DESIGN — operator profile lifecycle

Status: migration stage 3 implemented (2026-08-14), with direct Google-identity sessions added
(2026-08). This document owns the operator profile pool, direct-identity profile lifecycle, session
lifecycle, and login-seed lifecycle. Payment authorization and secret-handling contracts remain
owned by [`SECURITY.md`](../SECURITY.md).

## 1. Stage boundary

Ordinary `operate_start` sessions lease an isolated Chrome profile. The canonical profile used by
`connect` and `login` is their authoring source only: a successful Google login can publish a
cookie-free, immutable seed generation, and a worker profile is cloned from that seed or reclaimed
from one closed warm-profile slot. A session with `requireLiveIdentity` instead opens the canonical
profile directly, because replaying a filesystem clone of Google's rotating session cookies can
invalidate the user's live Google session.

Stage 3 retains the session-addressed payment and drain-before-finish gates while widening the
fixed pool for concurrent execution:

- two starts or active tasks at a time per profile-pool namespace;
- two filesystem active slots implement that bound;
- one closed warm-profile slot;
- one page within the leased worker profile.

Direct Google-identity sessions do not consume those slots. They are serialized separately to one
active session across processes by the canonical profile-operation guard and Chrome's
`SingletonLock`.

A third ordinary `operate_start` in the same namespace waits at the provision seam for up to 30
seconds, retrying the fixed slots without creating another profile or browser. A second direct
Google-identity start waits up to the same bound for the canonical profile. Shutdown cancels starts
waiting for either kind of capacity before it releases active resources.

There is no warm Chrome process between sessions. `operate_finish` closes Chrome before its profile
can enter the warm slot.

```text
connect / Google login
  -> close canonical Chrome with proof
  -> copy only the identity seed under the seed lock
  -> atomically publish seed/current and delete non-current generations

ordinary operate_start
  -> under the seed lock, reclaim stale metadata and reserve either active slot
  -> claim a current warm profile or clone seed/current while still holding the lock
  -> after releasing the lock, physically delete any privately tombstoned old profiles
  -> wait with the bounded retry while both active slots are claimed
  -> launch Chrome on the claimed worker profile
  -> bind the worker's process birth identity and exact user-data directory
  -> validate identity through that worker

operate_start with requireLiveIdentity
  -> acquire the canonical profile-operation guard
  -> launch Chrome directly on the profile that completed the interactive login
  -> validate the live Google identity through that profile

operate_finish
  -> stop admitting calls to this session and drain calls that already entered
  -> classify the remaining payment fence state for profile disposition
  -> clear the session's active payment and payment-field seal
  -> reset only an isolated reusable profile, then close Chrome with proof
  -> return a safe isolated profile to the warm slot, or release the direct-profile guard

watchdog / disconnect / startup cancellation
  -> close admission and use the bounded ordinary Playwright teardown first
  -> force-close or quarantine the owned browser and profile lease when ordinary close cannot finish
  -> release the shared seed or canonical-profile guard without awaiting a hung launch
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
State` and the provider/email marker files; it contains no cookie store. Transient locks and caches
are excluded. Pool ownership and lease metadata contain opaque IDs, private tokens, timestamps,
reuse counters, and process identity only.

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

`acquireWarmBrowser` remains the runtime seam. Ordinary sessions obtain an
`OperatorProfileLease` for an isolated pool worker before constructing `BrowserController`.
Sessions started with `requireLiveIdentity` instead obtain a `DirectIdentityProfileLease` for the
canonical `CHROME_PROFILE_DIR`, because Google's authenticated session does not survive a profile
clone. The direct lease transfers its pre-acquired profile-operation guard to `BrowserController`,
which owns that guard until browser shutdown; the lease must not acquire or release a second guard.

Under the seed lock, acquisition:

1. scavenges only ownership states it can prove stale, atomically moving reclaimable leases into
   private tombstones;
2. reserves the first free active slot with a private owner token;
3. claims the closed warm profile when it belongs to `seed/current` and is within its bounds; or
4. copies the current immutable seed into a new worker profile.

Before either a reclaimed warm profile or a new clone is leased, acquisition removes Chrome's
legacy `Default/Cookies` and `Default/Network/Cookies` stores and their SQLite sidecars. This keeps
profiles created by earlier releases from replaying session cookies after an upgrade.

Recursive deletion of a tombstoned Chrome profile happens only after the seed lock is released.
Profile directories can contain large caches, history, and IndexedDB state, so physical deletion is
not part of serialized pool bookkeeping and cannot block an unrelated start from acquiring the
lock. A failed deferred deletion leaves its private tombstone in place for a later acquisition to
retry; the lease cannot become claimable again in the meantime.

Pool capacity remains fixed at two active leases per namespace. A third ordinary start in that
namespace retries acquisition for at most 30 seconds, including time spent behind seed publication
on the shared seed lock, and launches only after one of those leases is released. Direct-identity
capacity is one canonical-profile session across processes; a second `requireLiveIdentity` start
waits up to the same bound for the current browser lifecycle to release its guard. Teardown cancels
registered capacity waiters and each start rechecks the shutdown generation after acquisition
before launch.

Before the first seed exists, ordinary acquisition creates an empty worker profile. Identity and
email checks for ordinary sessions run against that claimed worker profile. A
`requireLiveIdentity` session bypasses the pool, checks the canonical profile directly, and fails
closed at the existing Google-session gate when no live Google session exists.

A warm profile is eligible for at most six hours idle, 50 reuses, or 24 hours of age. Bounds and
current-generation invalidation are enforced deterministically on the next serialized pool
operation; there is no background timer or daemon. Publishing a new seed therefore invalidates the
old warm profile before it can be claimed again.

## 5. Ownership, crash recovery, and containment

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

Every provision session also owns a cross-platform watchdog. Ten minutes without an entered MCP
operation closes an abandoned session, and the 30-minute lifetime check is evaluated before the
active-call guard, so continuous non-payment activity cannot extend the session indefinitely. A
maximum-lifetime or Linux CPU-budget termination may let an active payment finish only within the
shared 30-second terminal-transition deadline. At that deadline, teardown uses the existing bounded
pending-3DS live check and metadata-only audit before destruction; an idle, disconnected, or
payment-free session does not receive that deferral. The server's separate 12-hour open-session idle
exit remains a process-level backstop, not operator-browser ownership.

The 10-minute browser-start timeout and shutdown cancellation do not await an unresolved launch.
They race ordinary close with a bounded custody-release force boundary, then destroy a proven-closed
lease or retain it quarantined. Late launch settlement cleans up idempotently using this controller's
inherited marker and launch custody, never the shared profile's current holder, so it cannot signal a
replacement session that acquired the profile afterward.

Ordinary bounded Playwright close and profile-lease release are the primary path on every platform.
On Linux, self-launched Chrome additionally runs in a detached process group and every local launch
inherits a Trusty Squire marker. A process-wide `/proc` watchdog groups marked Chromium descendants,
uses birth-safe per-process CPU deltas, and enforces the aggregate CPU and lifetime budgets even when
the browser root exits or children reparent. The Playwright persistent-context fallback uses the
identity-proven profile-root process snapshot captured for that launch. Signals are always scoped to
that proof or marker; root-PID-only cleanup and broad `pkill` are forbidden.

That snapshot is intentionally best effort rather than strict containment. A renderer that reparents
after the fallback snapshot can briefly remain idle, and a process that forks and exits wholly between
Linux watchdog polls is outside PID sampling. A spinning or long-lived marked renderer is still caught
by the Linux watchdog. [`TODOS.md`](../TODOS.md#ts-operator-browser-cgroup-containment-p1-infra)
tracks cgroup ownership for a strict Linux zero-orphan boundary and last-resort macOS/Windows
containment.

Destructive cleanup first atomically renames a claimable active or warm lease into `tombstones/`.
Only the private, unclaimable tombstone is inspected, signalled, or deleted. An unknown owner or
worker identity is retained for later inspection; it is not treated as stale. A verified matching
worker may be killed, but its profile is removed only after a later check proves that worker no
longer matches.

Lease tokens and active-owner tokens stay in private files. CDP is local loopback only in this
stage. `BOT_CDP_ENDPOINT` is rejected for isolated operator leases, and non-Linux operator profile
acquisition fails before launch.

## 6. Finish and the money fence

An isolated worker profile may return to the closed warm slot only after the page reset succeeds,
Chrome closure is proven, its seed generation is still current, and the session has no
payment-sensitive state. Failure to prove closure quarantines the lease instead of pooling or
deleting it. A direct-identity session never pools or deletes the canonical profile; browser
teardown releases its exclusive profile-operation guard.

`operate_finish` first marks the addressed session closing and installs one bounded terminal owner.
New calls for that session are rejected, calls that already acquired the session drain within the
configured drain bound, and outcome preparation runs behind the same closed admission gate. The
whole drain, preparation, and close transition has a 30-second outer deadline; exceeding it routes
through that owner's force-close path instead of reopening admission or waiting indefinitely.
Remaining payment state never vetoes teardown. Finish records whether the profile is
destroy-required, performs the bounded pending-3DS close audit, clears the active payment object and
payment-field seal, removes the session, and then closes Chrome. A payment-sensitive profile is
destroyed or quarantined instead of entering the warm slot.

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

| Contract                                                        | Owner                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Pool layout, seed lock, leases, warm slot, GC                   | `apps/mcp/src/bot/operator-profile-pool.ts`                       |
| Direct Google-identity lease                                    | `apps/mcp/src/bot/operator-direct-identity.ts`                    |
| Process birth and profile-path identity                         | `apps/mcp/src/bot/profile.ts`                                     |
| Local Chrome lifecycle and closure proof                        | `apps/mcp/src/bot/browser.ts`                                     |
| Session/process watchdog policy and Linux marker accounting     | `apps/mcp/src/bot/operator-browser-watchdog.ts`                   |
| Login lifecycle and seed-publication provenance                 | `apps/mcp/src/bot/google-login.ts`                                |
| Acquire seam, payment selection, call drain, finish disposition | `apps/mcp/src/bot/provision-session.ts`                           |
| Install provider-completion evidence                            | `apps/mcp/src/bot/install-completion.ts`, `apps/web/app/install/` |
