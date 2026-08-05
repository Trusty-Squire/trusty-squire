# DESIGN — warm browser reuse (skip the per-session Chrome boot)

Status: proposed (2026-08-04), for eng review. Research-grounded (gbrain: browser-lifecycle
research this session); code-grounded against `apps/mcp/src/bot/browser.ts` +
`provision-session.ts`.

## 1. Problem

Every `operate_start` does a full self-launch Chrome boot (self-launched Chrome + `connectOverCDP`
+ Xvfb + anti-bot settle) — measured at **~120s cold** this session. `operate_finish` (and the
idle reaper) then closes the whole browser. So the 120s is paid **per session**, and for any run of
back-to-back tasks (the gifting repeat loop being the worst case) it is paid N times over.

## 2. The model (what the evidence actually supports)

**Keep the browser warm across `operate_start`/`operate_finish`, reuse it, and let the process
boundary you already have do the cleanup.** The design is deliberately small — prior over-built
versions (fresh contexts per session, a recycle-watchdog, a "campaign" concept) were wrong for this
system; each was ruled out below.

1. **One persistent profile, a new tab per task.** Trusty Squire is a **single identity** (the
   user's own account; signups read the user's own Gmail). It already runs a persistent Chrome
   profile (`CHROME_PROFILE_DIR`) so signups reuse the Google session. So there is nothing to
   isolate — do NOT create fresh contexts per session (that is a multi-tenant testing pattern). Each
   task opens a new page/tab in the one persistent-profile browser.
2. **`operate_finish` stops closing Chrome.** It closes the tab/page for that task and keeps the
   warm browser reference. The next `operate_start` reuses it — no 120s boot.
3. **A long idle-TTL (~6h) closes the warm browser after genuine quiet.** In-process `setTimeout`,
   `.unref()`'d (so a pending close never keeps the Node process alive), armed/reset on every
   `operate_*` call, and it **must skip if any session is in-flight** (reuse the existing `inFlight`
   guard — never kill a live task or a payment). This one timer covers both host shapes:
   - **Per-session host** (Claude Code, Codex): the server exits in minutes-to-hours, before a 6h
     timer fires — the TTL is a no-op, and existing exit handlers reap Chrome at session end.
   - **Daemon host** (Hermes, days of uptime): the TTL fires during an idle stretch, closes Chrome,
     frees the laptop RAM, and **the cold boot on the next task resets the accumulated leak** — so
     the idle-TTL is also the leak guard. No separate memory-watchdog needed.
4. **Existing exit handlers already reap Chrome on server exit.** `browser.ts` tracks every
   self-launched Chrome PID (`selfManagedChromePids`) and kills them on `exit`, `SIGINT`, `SIGTERM`,
   and `SIGHUP` (`installSelfManagedChromeCleanup`). No new lifecycle machinery.
5. **Widen the boot-time orphan sweep to the operator profile.** `reapOrphanedVerifyBrowsersOnce`
   sweeps PPID=1 orphans but only matches `profiles/verify-*` (the housekeeper). A SIGKILL of the
   server (the one exit that runs no handler) would orphan an *operator* Chrome the sweep misses.
   Widen the regex to the operator/interactive profile too. This closes the only real leak path.

```
 operate_start ──► warm browser exists? ──yes──► new tab (fast, no boot)
                        │no
                        ▼
                   self-launch Chrome (~120s, once) ──► new tab
 operate_finish ──► close the TAB; keep browser; (re)arm the ~6h idle timer (.unref, skip-if-in-flight)
 idle > 6h, nothing in-flight ──► close warm Chrome (frees RAM; next task cold-boots, leak reset)
 server exit (SIGTERM/…) ──► existing handler SIGKILLs all self-managed Chrome
```

## 3. Why the simpler ideas were ruled out (evidence)

- **Fresh contexts per session** — a multi-tenant testing pattern; Trusty Squire has one identity, so
  the persistent profile (accumulated real state) is both correct and more human. Cut.
- **Anti-bot benefit of a *warm process*** — the returning-user signal comes from the persistent
  *profile on disk* (2-year Google cookies, accumulated state), which survives a cold boot. Keeping
  the process warm is therefore **purely a latency win**, not an anti-bot one. (Research: a fresh
  clean browser IS flagged as suspicious; a persistent cookie jar looks like a returning user —
  which we already have via the profile.)
- **A recycle-watchdog / memory-threshold reaper** — over-engineering for sporadic usage. Under a
  long idle-TTL, Chrome hits an idle gap and cold-boots fresh before it bloats, so the leak self-
  bounds. (Research: long-running Chrome DOES leak and needs recycling *at scale/continuous load* —
  which is not this usage.)
- **"Keep warm across a campaign"** — there is no campaign. Trusty Squire is on-demand tools with no
  usage spikes; the only relevant variable is the gap between calls, which the idle-TTL handles.

## 4. Money-path + concurrency

- The warm browser is now shared across sessions. The existing exclusive **payment lease** +
  `inFlight` guard (`acquirePaymentSession`, the reaper's in-flight skip) already model multi-session
  on one browser — the idle-TTL reuses that guard to never close during a payment.
- Concurrency: two concurrent `operate_start`s share the warm browser as two tabs. For a single
  identity this is fine; sequential is the common case. No cross-identity mixing (there is one
  identity).

## 5. Maps onto existing code

| Piece | Where | Change |
|---|---|---|
| Per-session browser launch | `provision-session.ts` (`new BrowserController` + `browser.start()`) | reuse a module-level warm browser instead of launching per session |
| Close on finish | `provision-drive.ts` `operate_finish`; `provision-session.ts` reaper | close the tab, keep the browser; arm the idle-TTL |
| Idle-TTL timer | `provision-session.ts` (new) | `.unref()`'d setTimeout, reset on `touchSession`, skip-if-in-flight |
| Exit reap | `browser.ts` `installSelfManagedChromeCleanup` | unchanged (already reaps on signals/exit) |
| Orphan sweep | `browser.ts` `reapOrphanedVerifyBrowsersOnce` | widen regex from `verify-*` to include the operator profile |

New surface is **moderate, not trivial** (review correction — the earlier "holder + timer + regex"
undersold it): `BrowserController` is single-page by construction (`this.page`, with framenavigated/
load/response/console handlers and `settleAfterOAuth` page-switching all bound to it), so reuse is a
real lifecycle change — see the locked model in §8.

## 6. Out of scope (deferred, with triggers)

- **Max-age recycle** — only if a *continuously-busy* daemon host (a task every few minutes for days,
  never idle) becomes real; then the idle-TTL never trips and the leak grows. Not this usage.
- **Multi-identity warm pools** — Trusty Squire is single-identity; N/A unless it becomes a shared
  multi-tenant service (then: warm-browser-per-identity, and the anti-bot rule "never share one
  fingerprint across many cookie jars" applies).
- **`storageState`-backed fresh contexts** — the multi-tenant pattern; not needed for one identity.

## 7. Honest risks (for review)

- **SIGKILL orphan**: the one exit path that runs no handler; mitigated by the widened boot-time
  sweep (next server start reaps it), but there is a window where an orphaned operator Chrome squats
  RAM until the next boot. Acceptable; SIGKILL of the MCP server is rare.
- **Shared warm browser as new shared state**: a wedged/crashed warm browser now affects the next
  task instead of being freshly launched. Need a health check on reuse (is the CDP connection
  alive?) — if the warm browser is dead, discard it and cold-boot. Small but required for robustness.
- **The idle-TTL value (~6h) is a guess** — long enough to span any real activity cluster, short
  enough to free a laptop's RAM on genuine quiet. Make it configurable; tune against real usage.

## 8. Eng-review outcome (2026-08-04) — LOCKED

Scope challenge caught the doc underselling the change (`BrowserController` is single-page). Core
idea (warm reuse) upheld; three corrections + two fork decisions:

**Corrections:**
- **Not "a holder + a timer."** `BrowserController` is built around one `this.page` with page-bound
  handlers + OAuth page-switching. Reuse is a lifecycle change, not a trivial add.
- **Reuse eligibility is narrow.** A warm browser is bound to ONE `profileDir` + ONE `proxyUrl`. The
  reuse check must match profile AND proxy (a task needing different egress cold-boots), not just
  "a browser exists."
- **Health-check-on-reuse is REQUIRED, not a risk.** Before reusing, verify the CDP connection is
  alive (`isConnected`); if the warm browser died between tasks, discard it and cold-boot.

**Fork D1 — page model → SEQUENTIAL SINGLE-PAGE REUSE.** The warm browser keeps its one page; the
next `operate_start` resets that page's state (about:blank + clear per-page state) and navigates it.
ONE task at a time — matches the sporadic, single-identity usage. Do NOT refactor to multi-page;
add that only if real concurrency (two purchases at once) ever appears.

**Fork D2 — leak backstop → IDLE-TTL + REUSE-COUNT/MAX-AGE BACKSTOP.** The "idle-TTL self-bounds the
leak" claim only holds if quiet gaps exceed the TTL. A regularly-but-lightly-used daemon (a task
every few hours, all day — the gifting-daemon shape) never idles 6h, never recycles, and Chrome
bloats over days. So ALSO recycle after N reuses (or a wall-clock max-age) regardless of idle. Few
lines; bounds the leak unconditionally.

**Locked build order:** (1) sequential single-page reuse with explicit page-state reset +
reuse-eligibility guard (profile+proxy+`isConnected`); (2) `operate_finish` stops closing the browser,
resets the page, arms the idle-TTL; (3) reuse-count/max-age backstop recycle; (4) widen the orphan
sweep to the operator profile. VERDICT: proceed with the locked model; the doc's earlier "small
surface" and "idle-TTL self-bounds" framings are superseded by this section.
