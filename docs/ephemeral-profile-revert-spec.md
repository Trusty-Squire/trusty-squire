# Ephemeral per-operate browser profiles — implementation spec

## Decision

Remove the operator profile pool. Each `operate_start` creates one new, private Chrome user-data directory, seeds browser session/auth state from the canonical login state, keeps that browser open for all calls with the same `session_id`, and deletes the directory after `operate_finish` closes Chrome.

No pool, shared seed lock, slot count, broker, lease daemon, or feature flag. The operator path must never launch Chrome on `CHROME_PROFILE_DIR`.

## Evidence: current mechanics

| Current behavior | Evidence |
| --- | --- |
| Canonical profile: `TRUSTY_SQUIRE_PROFILE_DIR` or `~/.trusty-squire/chrome-profile`. | `apps/mcp/src/bot/profile.ts:26-27` |
| Advisory lock name is `trusty-squire-profile-<digest>.lock` (not the brief's shorthand `profile-<digest>.lock`); current wrapper is `withProfileOperationGuard` (not `withProfileLock`). | `profile.ts:291-306, 443-527` |
| Lock tombstones/stale-PID recovery and Chrome SingletonLock retry live here. | `profile.ts:334-500, 552-730` |
| Operator start acquires a pool/direct lease, launches a controller on its profile, then stores it in `leasedBrowsers`. | `apps/mcp/src/bot/provision-session.ts:626-890` |
| The pool serializes slot reservation and warm-profile claim/clone under `seed/.lock`; it either takes `warm/slot-0` or copies a seed. | `apps/mcp/src/bot/operator-profile-pool.ts:980-1098` |
| The seed is only `Local State`, provider/email markers, and selected **Google** cookies. | `operator-profile-pool.ts:53-83, 319-442` |
| Finish resets a reusable page, closes Chrome, returns a safe profile to warm storage, otherwise destroys it. | `provision-session.ts:860-890, 7522-7535`; `browser.ts:13437-13483` |
| Pooling was introduced by `89d9e429 feat(mcp): isolate operator sessions with profile pooling (#514)`; the predecessor had one warm controller/profile. | `git show --stat 89d9e429`; `git show 89d9e429^:apps/mcp/src/bot/provision-session.ts:590-734` |

The current pool is 1,117 lines and its focused test is 922 lines. This is the complexity to remove, not replace.

History check: the immediate parent of the pooling commit is a shared warm-controller implementation,
not a literal per-instance state-seeding implementation. Therefore this is not a blind `git revert`;
reuse the current filtered SQLite seed as the safe starting point, then generalize it into the small
session-state mechanism below.

## Canonical state and seeding

Keep `CHROME_PROFILE_DIR` only as the interactive `connect`/`login` authoring profile. It remains the source namespace, so `TRUSTY_SQUIRE_PROFILE_DIR` continues to isolate Hermes/eval exactly as it does now.

Add a small `apps/mcp/src/bot/session-state.ts`. Its authoritative state file is `<CHROME_PROFILE_DIR>/trusty-squire-session-state.json`, written with mode `0600` by atomic temp-file + rename. It is Playwright storage-state JSON, not a profile copy.

At start, create a unique `0700` directory with a `trusty-squire-operate-` mkdtemp prefix and, if the JSON snapshot exists, call `BrowserContext.setStorageState()` before the first target navigation. The installed Playwright type exposes restore plus `storageState({ indexedDB: true })` capture (`node_modules/.pnpm/playwright-core@1.59.1/.../types.d.ts:9407-9471`). No Chrome cookie database or profile files are copied.

Required coverage:

- Google OAuth: all Google cookie rows, including the current SID/APISID family; the existing live-session detector uses `__Secure-1PSID`, `SAPISID`, or `SID` (`browser.ts:1653-1684`).
- GitHub OAuth: all `github.com` rows, including `user_session`, which the same detector treats as live. The current filtered seed drops it.
- Merchant logins: all cookies plus local storage and IndexedDB from the storage-state JSON. This covers cookie sessions and Firebase-style tokens without copying a full profile. Provider/email marker JSON remains a hint, never auth proof (`login-state.ts:101-156`).

Never copy card fields, approvals, action traces, cache, history, or extensions.

## Lifecycle and write-back

### Start

Replace pool/direct acquisition with a small `startEphemeralBrowser` in `provision-session.ts`:

- make and seed the unique directory;
- read state JSON;
- construct `BrowserController({ profileDir: fresh, storageState })`;
- after its context exists, restore state before creating/navigating the primary page (the placement is `browser.ts:3446-3601`);
- remember controller, fresh dir, and canonical profile on the session.

Remove the `requireLiveIdentity` direct-canonical exception. Preserve the existing live-provider pre-navigation gate, but evaluate it against the seeded fresh browser. Existing multi-step reuse already works: a session owns one browser in `sessions` (`provision-session.ts:624, 2598-2634`) until finish removes it.

### Finish

Preserve current call-drain, audit, payment, and session-removal ordering (`provision-session.ts:7538-7584`). On an explicit successful finish:

1. Capture `context.storageState({ indexedDB: true })` before close.
2. Use the rc.9 bounded terminal owner to perform the existing identity-proven browser close.
3. Only after close is proven, asynchronously replace the canonical state JSON if the terminal owner is still authoritative immediately before the atomic rename.
4. Release the in-memory browser lease and schedule detached best-effort removal
   of the unique directory. Normal and forced terminal paths never await the
   recursive delete.

If the existing `profileRequiresDestroy` condition is true (`activePayment`, `paymentFieldSealActive`, or `pendingThreeDs`, `provision-session.ts:7846-7852`), close and schedule profile destruction but skip write-back. If close cannot be proved, retain that unique directory and the prior canonical snapshot, and report the retained directory; it is a disk leak, never a future-agent lock wedge. A detached deletion failure is reported and leaves the same harmless unique residual for later lazy reaping.

`connect`/`login` keeps editing the canonical authoring profile. On a successful context-backed login, write the full JSON state as well. A plain Chrome path has no context to capture, so it preserves the existing snapshot rather than clearing saved logins.

Write-back is deliberately **last writer wins**. Atomic rename prevents corruption; concurrent logins to the same merchant may lose the earlier update. Do not add a lock, merge protocol, or service to address that edge case.

## File-level changes

1. Add `session-state.ts`: profile mkdir, state read/write, atomic snapshot persistence.
2. In `browser.ts`, add optional input-state application and a narrow capture method; keep self-launch + CDP. Remove operator start's `profileOperationLease`/shared guard (`3110-3136`, `3266-3270`).
3. In `provision-session.ts`, delete pool/direct lease acquisition, capacity waiters, warm release/reset, and use the ephemeral lifecycle above.
4. In `google-login.ts`, replace `canPublishOperatorProfileSeed`/`publishOperatorProfileSeed` at `1163-1176` with state snapshot publication.
5. Update `docs/DESIGN-warm-browser-reuse.md` and comments; it currently describes the pool and direct canonical path.

Delete rather than rehome:

- `apps/mcp/src/bot/operator-profile-pool.ts` (seed lock/generations, active/warm slots, tombstones, leases, GC);
- `apps/mcp/src/bot/operator-direct-identity.ts` (canonical serial lease);
- `apps/mcp/src/bot/__tests__/operator-profile-pool.test.ts` and pool/mock/capacity branches in operate session tests;
- operator uses of `profileOperationLockDir`, `acquire*ProfileOperationGuard`, `withProfileOperationGuard`, lock-artifact scavenging, stale lock reaping, `waitForProfileFree`, and `launchWithProfileGate`;
- `BrowserController.resetPageForReuse()` and all warm limits/reset code.

Keep only the small process-identity/close-proof helpers needed to kill an owned child and to protect the separate interactive connect browser; move them out of the profile-lock module if necessary. No operator profile-derived lock directory remains.

## Tests and acceptance

1. Three simultaneous `operate_start` calls receive three distinct profile paths and no capacity/seed-lock wait.
2. Storage-state JSON round-trips cookies, local storage, and IndexedDB; no profile, cache, history, or SQLite-cookie bootstrap is used.
3. An explicit successful finish persists a login to a later fresh task, closes Chrome, and removes its profile. No-outcome or failed finishes preserve the prior snapshot. A payment, sealed-field, or pending-3DS session destroys without snapshot write-back. Unknown close retains only its unique directory.
4. Two explicit successful finishes leave one valid state file; the last completed snapshot is visible.
5. Multiple observe/act calls on one session do not create a second browser/profile.
6. `require_live_identity` tests prove a fresh seeded profile, never canonical profile access.
7. Retain rc.9 watchdog and `closeAllProvisionSessions` closure tests; remove pool slot/warm/seed-lock expectations.
8. Run focused tests, full `pnpm --filter @trusty-squire/mcp test`, then typecheck.

### Read-only Turnstile check

Run 10 fresh-profile attempts per target, alternating baseline and change with identical host/proxy/display/self-launch settings. Visit only the public entry, observe, and record launcher, profile mode, first-observation latency, Turnstile render, and visible success/token state. Stop before OAuth, email entry, submit, login, or purchase.

Targets: Exa public auth entry, Cartesia public signup, and Groq public login/API-key entry. `STATE.md:351-387` shows the historic Turnstile discriminator was `launchPersistentContext`, not IP, fingerprint, Xvfb, CDP attachment, or click method; preserve the current self-launch path. Cartesia's recorded issue was Clerk/email flow (`STATE.md:206-264`), and Groq's was a post-OAuth key-modal Turnstile (`STATE.md:306-330`), so report them separately rather than claiming a shared anti-bot result. Any material Exa regression blocks ship; an improvement is only a measured bonus.

## Startup, rollout, and invariants

The current warm worker is closed at finish (`docs/DESIGN-warm-browser-reuse.md:34-35`), so it avoids a profile copy, not Chrome launch. `STATE.md:427-430` measured self-launch + CDP attach at about 870 ms. Estimate installed-browser startup at 0.9–1.5 s warm versus 1.0–2.0 s fresh-with-state (roughly 0.1–0.5 s overhead before network navigation). Measure medians/p95 with temporary `provision-audit` fields: `profile_seed_ms`, `storage_restore_ms`, `browser_launch_ms`, and `start_total_ms`; remove them after first-release evidence. The avoided retained/copy class is approximately 280 MB, not a small auth snapshot.

Ship the direct replacement, no new flag. `TRUSTY_SQUIRE_PROFILE_DIR` remains unchanged. Card sealing, one-human approval, host-scoped egress, 3DS handling, vault restrictions, payment audit ordering, and session addressing are all unchanged.

## What could go wrong

- Current direct identity code says Google consoles can reject copied session state (`operator-direct-identity.ts:3-26`). A seeded `require_live_identity` regression plus read-only Firebase/GCP authenticated reachability smoke must pass. If it fails, report the incompatible mechanism; do not quietly restore the shared canonical fallback.
- A plain successful login has no context to capture; retain the prior snapshot rather than deleting saved logins.
- Concurrent finish can lose one login update by design; it cannot corrupt storage.
- IndexedDB snapshots can grow; measure their bytes, but never replace this design with cache/history copying.
- Uncertain teardown can retain a directory; its uniqueness makes it non-blocking.

## Investigation record

Read-only evidence gathered with:

```text
git log --all --oneline --regexp-ignore-case --grep='warm profile|shared profile|...'
git show --stat 89d9e429
git show 89d9e429^:apps/mcp/src/bot/provision-session.ts
rg/nl over browser.ts, provision-session.ts, profile.ts, operator-profile-pool.ts
rg -n -C 7 'turnstile|exa|groq|cartesia' STATE.md
rg -n -C 5 'storageState' node_modules/.pnpm/playwright-core@1.59.1/.../types.d.ts
```

Key output: `89d9e429 feat(mcp): isolate operator sessions with profile pooling (#514)` introduced the pool; the Exa matrix in `STATE.md` identifies launcher mode, not shared-profile reuse, as the proven Turnstile factor.

## Owner decisions (supersede the seeding sections above)

Two eng-review decisions override the spec's original seeding design. Implement THESE:

1. **Seed via Playwright `storageState` only — drop the SQLite cookie-DB copy entirely.**
   `BrowserContext.setStorageState()` (verified present, playwright-core 1.59.1 `types.d.ts:9413`;
   `storageState({indexedDB:true})` capture at :9467) restores cookies + localStorage + IndexedDB, so
   the DB copy is redundant. The DB copy was also the fragile half: on Linux, copied cookies are
   keyring-encrypted (`os_crypt` v10/v11, key bound to the OS user/keyring) and can silently fail to
   decrypt in a fresh profile dir, and hot-copying the live `Cookies` SQLite risks a WAL torn read.
   Removing it is simpler AND more robust. No cookie-DB seed path, no Google cookie-marker filter.

2. **Persist ALL session logins, not just the Google anchor — with a best-effort re-login guardrail.**
   Capture the full `storageState` on explicit successful finish, restore it into every fresh profile. Persist every
   site's session, not a filtered identity anchor. GUARDRAIL (required, keeps it safe): a restored
   session is best-effort — at session start / before an authenticated action, verify logged-in state
   using the EXISTING live-provider detector (`browser.ts:2198-2211`, cookie families `user_session`
   for GitHub / `__Secure-1PSID`/`SAPISID`/`SID` for Google, generalized) and re-login when the stored
   session is stale. Never trust a restored session blindly into a half-logged-in checkout. Reuse the
   existing login-state detection; do NOT build a new session-freshness subsystem.
   Accepted cost: a modestly larger local secret surface (session tokens on disk). The card seal,
   one-human-approval, host-scoped egress, and payment audit are unchanged and orthogonal.

Everything else in the spec stands: remove the pool + shared seed lock + `operator-direct-identity.ts`,
per-instance mkdtemp profile per `operate_start`, destroy-on-finish, destroy (skip write-back) on
`activePayment`/`paymentFieldSealActive`/`pendingThreeDs`, last-writer-wins atomic JSON write-back,
retain rc.9 watchdog.
Delete `google-login.ts`'s `publishOperatorProfileSeed` path — write full `storageState` on any clean
context-backed login, not a Google-gated seed.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→resolved | 2 load-bearing findings, both resolved by owner |

Scope: SPEC review of the profile-revert (remove shared warm profile + seed lock → per-instance
seeded profiles). Owner constraint: maximum simplicity. Verified spec claims against `origin/staging`
code (profile.ts, operator-profile-pool.ts, provision-session.ts, browser.ts, google-login.ts) and the
installed Playwright types.

Findings:
- **[P1] (confidence 9/10) Dual seeding mechanism is redundant; the cookie-DB half is fragile.** Spec
  seeded a copied cookie SQLite DB AND a storageState JSON. `setStorageState` already restores cookies
  (`types.d.ts:9413`). Copied Chrome cookies are keyring-bound on Linux and can silently fail to
  decrypt; hot-copying the live DB risks a torn read. → RESOLVED: storageState-JSON-only.
- **[P1] (confidence 8/10) Persistence scope not settled.** Spec proposed persisting Google + GitHub +
  all merchant cookies/localStorage/IndexedDB, broader than today's Google-anchor-only seed
  (`operator-profile-pool.ts` `canPublishOperatorProfileSeed` gates on `provider === "google"`). →
  RESOLVED by owner: persist ALL, with a best-effort re-login guardrail reusing the existing
  live-provider detector. Simpler than filtering; guardrail contains the stale-session risk.
- **[P2] (confidence 7/10) `require_live_identity` on a seeded profile.** `operator-direct-identity.ts`
  header warns Google consoles can reject copied session state. Covered by the spec's gate: a seeded
  `require_live_identity` regression test + read-only Firebase/GCP smoke must pass; on failure report
  the incompatible mechanism, do NOT silently restore a shared-canonical fallback.
- **[P2] (confidence 7/10) Hot-copy consistency** — mooted by dropping the DB copy (finding 1).

Simplicity check: PASS — net-negative complexity. Deletes the 1,117-line pool + its 922-line test,
`operator-direct-identity.ts`, the seed lock, lock-dir/stale-PID scavenging, and warm reset-for-reuse.
No pool, broker, lease daemon, feature flag, or new subsystem added.

Outside voice: Codex (medium, read-only) — timed out at high effort, re-run tight returned
SHIP-WITH-FIXES, converging with the review on both P1s (storageState-only; keyring/hot-copy risks).
No cross-model tension.

Tests required in implementation: 3 simultaneous `operate_start` → 3 distinct profiles, no lock wait;
storageState round-trips cookies+localStorage+IndexedDB and authenticates; explicit successful finish persists a
login to a later task; payment/sealed/pending-3DS session destroys without write-back; multi-observe on one session
reuses one browser; **stale-session re-login guardrail fires and re-authenticates**;
`require_live_identity` uses a seeded profile; retain rc.9 watchdog + `closeAllProvisionSessions` tests.

**VERDICT:** ENG CLEARED — ready to implement. Delivery: no-mistakes, base `staging`.

NO UNRESOLVED DECISIONS
