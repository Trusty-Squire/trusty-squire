# DESIGN — warm browser reuse (skip the per-session Chrome boot)

Status: implemented (2026-08-05). Section 8 is the locked authoritative model; the earlier sections
summarize the resulting lifecycle and its rationale.

## 1. Problem

Before this change, every `operate_start` did a full self-launch Chrome boot (self-launched Chrome +
`connectOverCDP` + Xvfb + anti-bot settle) — measured at **~120s cold**. `operate_finish` and the
session reaper then closed the whole browser, so back-to-back tasks paid that cost repeatedly.

## 2. The model (what the evidence actually supports)

**Keep one module-level `BrowserController` warm and reuse its original handler-bound page
sequentially.** Section 8 owns the locked decisions; the implemented lifecycle is:

1. **One persistent profile and one page.** `operate_finish` resets the original page to
   `about:blank`, closes incidental popups, clears controller-local per-page state, and preserves
   profile cookies and storage. It does not create a tab or context for the next task.
2. **One task at a time.** A second `operate_start` is rejected while a start or task is in flight.
3. **Narrow reuse eligibility.** Reuse requires the same requested `profileDir` and `proxyUrl`, a
   connected CDP browser, and a successful page reset. A mismatch, dead connection, or reset failure
   discards the warm browser and cold-boots.
4. **Bounded lifetime.** Every operate call resets an unrefed idle timer. Defaults are six hours
   (`BOT_WARM_BROWSER_IDLE_TTL_MS`), 50 reuses (`BOT_WARM_BROWSER_MAX_REUSES`), and 24 hours of
   wall-clock age (`BOT_WARM_BROWSER_MAX_AGE_MS`). Reaping skips and re-arms while a start or task is
   in flight; reuse-count and max-age recycling occurs only at a safe task boundary.
5. **The stdio connection owns server lifetime.** `runServer` handles transport close, stdin
   EOF/close, `SIGINT`, and `SIGTERM` through one shutdown path. It closes active sessions and any
   browser launch still in progress, closes the MCP server, then explicitly exits so Chrome cannot
   keep Node alive. The lower-level Chrome cleanup still covers process exit and `SIGHUP` (plus
   `SIGINT`/`SIGTERM` outside server mode). The Linux PPID=1 boot-time sweep covers verifier
   profiles, the default interactive profile, and an explicitly requested operator profile.

```
 operate_start ──► warm slot eligible, connected, unexpired? ──yes──► reset the SAME page
                              │no                                   │
                              ▼                                     ▼
                         discard + cold-boot ──────────────────► navigate task
 operate_finish ──► reset SAME page to about:blank; keep Chrome; re-arm idle timer
 idle TTL / reuse / max-age boundary, nothing in flight ──► close warm Chrome
 reaper fires during a task ──► skip + re-arm
 stdio close / EOF / SIGINT / SIGTERM ──► close sessions + MCP server ──► process exit
```

## 3. Why the simpler ideas were ruled out (evidence)

- **Fresh contexts or tabs per session** — multi-tenant/concurrent patterns; Trusty Squire has one
  identity and a controller whose lifecycle handlers are bound to one page. Cut.
- **Anti-bot benefit of a *warm process*** — the returning-user signal comes from the persistent
  *profile on disk* (2-year Google cookies, accumulated state), which survives a cold boot. Keeping
  the process warm is therefore **purely a latency win**, not an anti-bot one. (Research: a fresh
  clean browser IS flagged as suspicious; a persistent cookie jar looks like a returning user —
  which we already have via the profile.)
- **A memory/recycle watchdog** — unnecessary sampling and mid-task lifecycle machinery. The idle
  TTL plus task-boundary reuse-count and max-age backstops bound daemon lifetime without recycling
  during live work.
- **"Keep warm across a campaign"** — there is no campaign. Trusty Squire is on-demand tools with no
  campaign abstraction in its runtime.

## 4. Money-path + concurrency

- The warm browser is shared over time, never concurrently: `starting` and `inFlight` enforce one
  task on the single page, and a second `operate_start` fails closed.
- Payment work occurs inside that live task. Every idle or recycle path checks the same guard, so it
  cannot close Chrome while a task or its payment is in flight.

## 5. Maps onto existing code

| Piece | Where | Change |
|---|---|---|
| Acquire/reuse | `provision-session.ts` | reuse a module-level controller only when launch options and connection health match; otherwise cold-boot |
| Page reset | `browser.ts` `resetPageForReuse` | retain the original handler-bound page, close popups, clear local state, navigate to `about:blank` |
| Finish/reaper | `provision-drive.ts` `operate_finish`; `provision-session.ts` | reset the task page, keep Chrome, arm an unrefed idle timer, and skip/re-arm while in flight |
| Lifetime backstops | `provision-session.ts` | recycle at safe boundaries after configured reuse-count or max-age limits |
| Server shutdown | `server.ts` `runServer`; `provision-session.ts` | on stdio disconnect or termination, close sessions (including an in-progress launch), close the MCP server, and force process exit |
| Fallback exit reap | `browser.ts` `installSelfManagedChromeCleanup` | reap self-managed Chrome on process exit and `SIGHUP`, and on `SIGINT`/`SIGTERM` outside server mode |
| Orphan sweep | `browser.ts` `reapOrphanedBrowsersOnce` | match verifier and exact configured operator profiles on Linux |

New surface is **moderate, not trivial** (review correction — the earlier "holder + timer + regex"
undersold it): `BrowserController` is single-page by construction (`this.page`, with framenavigated/
load/response/console handlers and `settleAfterOAuth` page-switching all bound to it), so reuse is a
real lifecycle change — see the locked model in §8.

## 6. Out of scope (deferred, with triggers)

- **Multi-identity warm pools** — Trusty Squire is single-identity; N/A unless it becomes a shared
  multi-tenant service (then: warm-browser-per-identity, and the anti-bot rule "never share one
  fingerprint across many cookie jars" applies).
- **Multi-page concurrency and `storageState`-backed fresh contexts** — not needed for the locked
  one-task, one-identity model.
- **Campaign abstractions and memory watchdogs** — the task-boundary lifecycle backstops are the
  complete leak-control surface for this model.

## 7. Honest risks (for review)

- **SIGKILL orphan**: the one exit path that runs no handler; mitigated by the widened boot-time
  sweep (next server start reaps it), but there is a window where an orphaned operator Chrome squats
  RAM until the next boot. Acceptable; SIGKILL of the MCP server is rare.
- **Shared warm browser as new shared state**: a dead connection, mismatched launch configuration,
  or failed page reset forces a discard and cold boot rather than carrying uncertain state forward.
- **Lifecycle defaults are operational guesses**: six-hour idle, 50-reuse, and 24-hour max-age
  defaults are configurable and should be tuned against real daemon usage.

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
