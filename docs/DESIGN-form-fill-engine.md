# DESIGN — form-fill engine (pre-login refactor, strangler slice 3)

Status: scoping + first pure extraction (2026-06-15). Owner: bot. Scope: the
universal signup bot's FORM-FILL phase only. Third strangler-fig slice of the
agent.ts de-monolithing (A4 in `DESIGN-post-signup-nav-search.md`): nav-search
(done) → OAuth/consent (reducer in, consent wired) → **form-fill (this)** →
extraction.

## Problem

`planExecuteWithRetry` (`apps/mcp/src/bot/agent.ts`, ~800 lines) drives the
email/password signup-form phase: scan for an OAuth affordance, else ask the LLM
to plan the form fill, execute it, and RETRY with intricate policy — replan on
error, replan on no-progress, detect a planner loop, reroute to OAuth, reload a
stuck SPA shell, bound proxy blips. Like OAuth (slice 2), it is a **stateful
loop**: ~10 counters/budgets (`errorReplans`, `progressReplans`, `emptyPlans`,
`oauthScanRetries`, `oauthShellReloads`, `upstreamBlipRetries`,
`signInAdvanceClicks`) + page-fingerprint memory (`lastRoundPageSig`,
`lastNoProgressClickSelectors`) interleaved with heavy I/O (the LLM form planner,
`executePlan`, the captcha gate). The decision policy is untestable in isolation
because it's welded to the I/O — and it's a recurring brittleness source
(kinde/Railway no-progress false-bails, meilisearch blip spin).

## Approach: the eng-reviewed stateful-reducer pattern (from slice 2)

The OAuth eng review (Claude + Codex) established the right decomposition for an
intricate stateful loop: a PURE reducer `(state, observation) → {action,
nextState}`, the executor owns the I/O + advance bookkeeping. Apply it here:

```
decideFormFillStep(state, observation) → { action, nextState }
```
- `state`: the counters/budgets + page-fingerprint memory (every loop-carried var).
- `observation`: the round's I/O-gathered facts (the plan, the page-moved
  fingerprint, the error kind, whether an OAuth affordance is present, …).
- `action` ∈ execute_plan | replan(hint) | reroute_oauth | reload_shell |
  advance_signin | blip_retry | bail(reason) — carrying any hint/side-effect.
- `nextState`: updated counters/memory, so the executor is a dumb apply-loop.

## This commit — first pure primitives (the no-progress / stuck-loop detector)

The most self-contained, highest-value pure piece (F14 + `lastRoundPageSig`),
extracted to `form-fill.ts` with tests, NOT yet wired (cannot regress):

- `computePageSig(url, selectors)` — the page fingerprint (url + sorted
  selectors) that decides whether a round made real progress.
- `pageMovedSince(prevSig, currSig)` — did the page change between rounds.
- `isStuckRepeat({ planClickSelectors, planEditsAField, noProgressSelectors })` —
  the F14 loop test: a click-only plan that re-picks ONLY already-dead selectors
  is a planner loop → bail. Does NOT fire when the plan adds a new selector or
  edits a field (legitimate progress — the kinde unique-domain retry).
- `nextNoProgressSet({ planClickSelectors, hadFieldEdit })` — the memory update:
  a field edit clears the dead-selector set; a no-progress round records its
  clicks so the next round's `isStuckRepeat` can catch a loop.

## Migration (separate commits — Beck)

1. **Extract the pure primitives** (this commit) — `form-fill.ts` + tests, unwired.
2. **Extract the full `decideFormFillStep` reducer** — the replan/bail/reroute
   policy, eng-reviewed (the consent gate's lesson: model the WHOLE stateful loop,
   not action-only).
3. **Wire behind `FORM_FILL_ENGINE`** (default-off) — `planExecuteWithRetry`'s
   decision branches call the reducer; the I/O executors stay.
4. **Validate** live (email-signup discover, pool-free) then flip default-on.

## NOT in scope (this slice)

- The LLM form-planner prompt + `executePlan` I/O — stays in agent.ts; the reducer
  only decides whether/how to replan, not what to fill.
- The captcha gate mechanics (`runCaptchaGate`) — I/O, stays inline.
- The OAuth-first scan — already its own concern (slice 2 territory).
