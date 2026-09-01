# Design: Collapse operator session state to the real Chrome profile

**Status:** Draft for engineering review
**Scope:** `@trusty-squire/mcp` operator provisioning path (operate_start → signup → vault)
**Source baseline:** `fm/login-reaper-fix` @ `1.1.13-rc.18`
**Known-good baseline:** GA `1.1.12`
**Goal, in priority order:** (1) signups work reliably; (2) codebase is as lean/simple as possible; (3) MCP tool surface is as lean/simple as possible.

---

## 1. Problem (proven)

Operator signups run on frozen **clones** of a saved "seed" profile. The seed carries a
`["google"]` *logged-in* marker but its captured cookies age out — Google rotates
`__Secure-1PSIDTS` every few minutes. Clones inherit the stale snapshot, come up
**signed-out**, Google's account/email lookup returns null, and the OAuth signup wall hits.

Two code facts make it permanent:

- **Publish gate never refreshes a live session.** `canPublishOperatorProfileSeed`
  requires `loginStatus === "completed"` (`operator-profile-pool.js:449-453`). An
  already-logged-in `connect` short-circuits to `preflight_satisfied`
  (`google-login.js:1035-1038`) and never republishes → the seed silently rots.
- **rc.18 added a broken OAuth "identity handoff."** `prepareOAuthActionBrowser` /
  `runSerializedOAuthBoundary` (`provision-session.ts:1528,1905`) swap browsers and
  re-inject cookies mid-login; this lost the "Continue with Google" button. **Absent in GA.**

Confirmed fix in the field: `require_live_identity: true` on GA — bypasses clones, uses the
real Chrome profile (which held the live session all along).

Underlying platform fact: **DBSC (hardware device-binding) is not available on Linux** —
Windows-only GA (Chrome 146), macOS pending. On this host, Google cookies are ordinary
bearer tokens and freely portable. The "cross-device wall" was never our problem; a
rotted local snapshot was.

## 2. What GA does (comparison baseline)

GA already contains both modes:

- **Default (ordinary session):** `acquireWarmBrowser` → `acquireOperatorProfileBounded`
  → **clone** from the seed pool. `ensureProvisionPrimaryProviderSession` probes the clone
  for live providers; a hollow clone → no google session → wall.
- **`require_live_identity` (opt-in):** uses "the canonical login-authoring profile
  directly. The immutable seed is never opened by Chrome" (`provision-session.js:1652-1654`),
  behind a fail-closed `googleSessionGate` (`:1663-1670`).
- **Harness sessions refuse live identity:** `startHarnessProvisionSession` throws
  "harness sessions cannot request live identity" (`:1769-1770`).

**Key insight:** rc.18 = GA + post-GA masking (the browser-swap) + churn. GA works in large
part because it never had the swap and because most users' seeds get refreshed often enough
by fresh `completed` logins to not rot. Plan A strips rc.18 back *past* GA's clone-default to
a single real-profile mode, keeps GA's simpler swap-free OAuth flow, and retains rc.18's one
real improvement (the lean serializer).

## 3. Plan A: target design

**One browser, one profile — the real Chrome login profile.** Log into Google once; each
signup opens that same profile and is already authenticated, exactly like a new tab. No seed,
no clone, no cookie copy, no browser-swap.

- Cookies stay fresh because the profile is **live** during operate (Chrome refreshes
  `__Secure-1PSIDTS` in place while the browser is open).
- **Serial by construction:** Chrome locks a profile to one process. Acceptable — concurrent
  signups are not required. Concurrency remains recoverable later via *clone-fresh-at-start*
  (never a cached seed), if ever needed.

### Comparison

| Dimension | GA 1.1.12 (works) | rc.18 (current, broken) | **Plan A (target)** |
|---|---|---|---|
| Default operate profile | Clone from seed pool | Clone from seed pool | **Real login profile** |
| Real-profile mode | Opt-in `require_live_identity` | Same opt-in | **Only mode; flag removed** |
| OAuth browser-swap handoff | Absent | Present (broken) | **Removed** |
| Seed pool / publish gate / marker | Present | Present | **Deleted** |
| DOM serializer | pre-lean | lean (retain) | **Keep rc.18 serializer** |
| Xvfb headed launch | Present | Present | **Keep** |
| Concurrency | Pool leases (parallel) | Pool leases | Serial (profile lock) |

## 4. Keep / Cut

**Keep**
- The current lean DOM serialization layer (the weight win). *Impl note: confirm the exact
  serializer commit being retained so the review knows precisely what stays.*
- Xvfb headed launch — required so Cloudflare/Stytch/Google don't block headless Chrome
  (`browser.js:2659-2668`).
- Self-launch + `connectOverCDP` anti-detection (beats Google's "not secure" check).

**Cut**
- Codex's login-masking: seed pool (`operator-profile-pool`), publish gate, `["google"]`
  marker, cookie-copy allowlist, and the OAuth browser-swap
  (`prepareOAuthActionBrowser` / `runSerializedOAuthBoundary` / `addSessionCookies`).
- My debug/test thrashing: `TS_OAUTH_DEBUG`, `TS_OPERATE_HEADED`, DISPLAY injection in
  `provision-session.ts` / `browser.ts`.

## 5. Tool-surface leanness

Making the real profile the only mode lets us **remove `require_live_identity`** from the
`provision-drive` tool schema (it becomes the default and only behavior) — one fewer knob the
agent can get wrong. Audit the `operate_*` surface for other options that only existed to
steer the clone/seed machinery and drop them with it. *Open: what to do with the
harness-session entry point — see risks.*

## 6. Implementation steps

1. Roll back my debug/test gates → clean source.
2. Make operate open the real profile directly; delete the seed/clone/pool subsystem and the
   OAuth browser-swap.
3. Remove now-dead tool params (`require_live_identity`, clone-only options).
4. Leave the lean serializer and Xvfb-headed launch untouched.
5. One ipinfo signup end-to-end; confirm the key lands in the vault. Basic test, hand off.

## 7. Risks / open questions (for the review)

1. **Harness-session path.** GA refuses live identity for `startHarnessProvisionSession`
   ("caller-owned harness page"). If real-profile becomes the only mode, does that path still
   function, or does removing clones break it? Decide: keep it clone-based, or converge it too.
2. **Serial locking UX.** Real profile = one operate at a time and it collides with a
   still-open login browser. Need clean lock handling / clear error, not a silent hang.
3. **`googleSessionGate` behavior.** With no clone, the "no live google session" case must
   fail closed to a clear "log in first" hand-back, not a confusing null.
4. **Real-profile mutation.** Operate now writes to the user's real Chrome profile (cookies,
   history). Acceptable for a personal tool, but name it — a bad signup touches the real login.
5. **Serializer provenance.** Confirm the retained serializer is the intended lean one and is
   not entangled with any clone/seed code being deleted.
6. **Egress/allowedHosts + credential seeding.** Ensure removing the clone path doesn't change
   which hosts are allowed to seed credential egress (`provision-session.js:1672-1681`).

## 8. Test plan

- One real ipinfo Google-OAuth signup end-to-end → key present in vault (audit log
  `credential_stored`).
- Re-run a second signup back-to-back → confirms the live profile serves repeated sessions
  without a seed refresh.
- Basic unit/type check on the touched files. No CI loop (pair-programming).

---

## GSTACK REVIEW REPORT

**Reviewer:** codex `gpt-5.6-terra`, high effort, read-only adversarial sweep against rc.18 source.
**Scope:** correctness (works E2E), codebase leanness, tool-surface leanness only.

### Runs / Status / Findings

| # | Finding | Axis | Severity |
|---|---|---|---|
| 1 | rc.18 already uses an **ephemeral profile + portable snapshot** (Google cookies stripped, restored from snapshot); the seed **pool is vestigial** (only reached by orphan sweeps). My doc's "default = clone from GA pool" was stale. | 1/2 | blocker (framing) |
| 3 | **Serial locking is NOT free.** Direct operate bypasses `launchWithProfileGate`/`waitForProfileFree` and only clears a stale lock; a live collision becomes a launch *failure*, not a clean hand-off. Needs one real profile lease held for the whole operate session. | 1/2 | blocker |
| 4 | **`googleSessionGate` can't be reused as-is.** `startProvisionSession` deliberately filters detected Google and restores only from the snapshot; making the gate unconditional would *falsely reject a live real profile*. Must remove that filtering. | 1 | blocker |
| 5 | **Don't delete `runSerializedOAuthBoundary` wholesale** — it preserves the authorized element and calls `loginWithOAuth`. The bad close/relaunch/re-goto swap is inside `runSerializedGoogleIdentityOperation`. Delete only that. | 1/2 | blocker |
| 10 | **Headed/Xvfb is NOT the shipped default** — self-managed operate adds `--headless=new` unless the uncommitted `TS_OPERATE_HEADED` gate is set. Making headed the *committed* default is part of the fix, not just a rollback. | 1/2 | major |
| 8 | Pool deletion also requires deleting its two orphan-sweep call sites (`server.ts`, `owner-process-reaper.ts`) + its tests. | 2 | major |
| 9 | **Keep the `["google"]` marker** (`logged-in-providers.json`) — it's `login-state.ts`, NOT pool machinery; `connect` live-provider reporting + force-relogin depend on it. My "cut the marker" was wrong. | 2 | major |
| 11 | Tool surface: remove `require_live_identity` from `operate_start` AND `operate_use` (+3 cold-start forwards) + internal `StartOptions.requireLiveIdentity` + harness rejection. Keep `proxy`, `allowed_hosts`, `extra_allowed_hosts`. | 3 | major |
| 2,6,7,12 | CONFIRMED clean: serializer (`compact-observation-v2`) independent → keep; egress-host seeding unchanged; harness path is the replay evaluator (not MCP), unaffected; vault `persistExtracted`/`storeCredential` unchanged. | 1/2 | minor |

### Corrected leanest end-state
- **Delete:** `operator-profile-pool.ts` + tests + its two sweep call sites; the ephemeral-handoff + portable-snapshot read/write + Google-cookie-injection branches in `provision-session.ts`; the inner swap in `runSerializedGoogleIdentityOperation`; my `TS_OAUTH_DEBUG`/`TS_OPERATE_HEADED`/DISPLAY debug gates.
- **Keep:** `runSerializedOAuthBoundary` + target re-resolution + `loginWithOAuth`; `compact-observation-v2`; vault extraction/storage; `login-state.ts` provider markers; `profile.ts` ownership/lock primitives (now used to hold ONE direct-profile lease per operate session).
- **Make headed the committed operate default** (drop the debug gate, set the real flag).

### VERDICT
Plan A is sound; deletion is real leanness (a whole subsystem + a tool param go). Three code blockers must be handled in-flight (real profile lease, remove Google-filtering before the gate, delete only the inner swap). Two decisions below gate the lease contract and scope.

**RESOLVED DECISIONS (captain):**
- **D1 (REVISED) — liveness-based eviction, NOT a TTL, NOT blanket fail-fast.** One
  direct-profile lease is held for the whole operate session via `profile.ts` primitives.
  On acquire, resolve the recorded holder identity (`ProfileProcessIdentity` = host + **pid +
  start_time**; start_time defeats PID reuse):
  - **Holder proven dead / absent → EVICT AND CLAIM.** Clear the stale lock
    (`clearStaleSingletonLock` / `reapLeakedProfileHolder`) and take the profile. A crashed
    holder must never strand the profile — reclaimed on the very next attempt.
  - **Holder proven alive → refuse** with `PROFILE_BUSY_MESSAGE`. Never steal from a live
    Chrome (two Chromes on one profile corrupts it).
  - **Indeterminate → refuse** (do not evict on unproven liveness).
  No TTL as the primary mechanism: a 5-min TTL both steals from legitimately-long signups
  (email verify / CAPTCHA / payment) and leaves a crashed holder stranded for 5 min. Liveness
  is strictly better on both. Release the lease on every exit path (success, throw, teardown).
- **D2 — `logged-in-providers.json` marker → REMOVE (now in scope).** The cached provider
  marker is the same class of lying-cache as the seed. Delete it and replace its `connect`
  live-provider reporting + force-relogin readers with a **live probe of the real profile**
  (`detectGoogleAccountEmail` / actual cookie presence), so "is Google logged in?" is answered
  by the live session, never a JSON claim. This expands scope into `login-state.ts` +
  `install/cli.ts` `connect`; carry it as its own commit.
- **D3 — multi-provider sessions are IN.** The live probe reports **every** provider with a
  live session in the real profile (`google`, `github`, …), not just Google. This is nearly
  free: a Chrome profile already stores all sites' cookies in one place, so logging into
  GitHub once in that profile makes "Continue with GitHub" signups work exactly like Google.
  `loginSessionGuidance` then tells the agent which providers are actually available.
  GitHub is lower-risk than Google (ordinary session cookies, no DBSC anywhere, no
  "secure browser" OAuth check). Only the login *driver* is Google-specific; the storage is
  generic. Trade-off named: more standing sessions in one profile = a bigger prize if a
  malicious page drove the browser, already contained by host-scope + control-plane denylist.

NO UNRESOLVED DECISIONS
