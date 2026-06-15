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

1. ✅ **Extract the pure primitives** (`430fbfe`) — `form-fill.ts` + tests, unwired.
2. ✅ **Extract the full `decideFormFillStep` reducer** (`6ba2674`) — phase-
   discriminated, eng-reviewed; 33-case golden-transition table (the parity gate).
3. ✅ **Wire behind `FORM_FILL_ENGINE`** (default-off, `add145e`) — realized as a
   flag-gated sibling executor `planExecuteViaEngine` (early-return from
   `planExecuteWithRetry`) rather than in-place interleaving: the proven inline
   loop stays byte-identical (only the guard added), so the default path cannot
   regress. The engine method routes all 5 checkpoints through the reducer and
   owns only the I/O + the replan-hint CONTENT (`buildSubmitDisabledHint`). The
   temporary orchestration duplication is the strangler bridge — deleted in step 4.
4. ⏳ **Validate live** (`FORM_FILL_ENGINE=1` email-signup discover, pool-free) →
   confirm parity with the inline path on real pages → flip default-on → DELETE
   the inline `planExecuteWithRetry` loop + the duplication. THE REMAINING GATE.

## NOT in scope (this slice)

- The LLM form-planner prompt + `executePlan` I/O — stays in agent.ts; the reducer
  only decides whether/how to replan, not what to fill.
- The captcha gate mechanics (`runCaptchaGate`) — I/O, stays inline.
- The OAuth-first scan — already its own concern (slice 2 territory).

## GSTACK REVIEW REPORT (eng-review, 2026-06-15 — Claude + Codex)

Reviewed BEFORE building `decideFormFillStep`, to scope what the reducer must
cover (the OAuth review's lesson: enumerate the whole stateful loop). Source of
truth: `planExecuteWithRetry` agent.ts:4648–5392, read end-to-end.

**Verdict: adopt the reducer — but NOT OAuth's single-observation shape.** This
loop's round is a *sequence* of 4 I/O-gated checkpoints where later I/O depends
on earlier decisions (the planner doesn't run if the OAuth-first scan
short-circuits). A single `decideFormFillStep(state, observation)` per round
forces `observation` into a god-object that pre-runs I/O the round may never
reach. The faithful boundary is a **phase-discriminated** reducer.

### Blocking architecture findings

- **A1 — a round is multi-checkpoint.** Model `state.phase ∈ {pre_plan,
  post_plan, post_execute, post_submit}`; the executor calls the reducer at each
  checkpoint, runs the action's I/O, re-enters with the next phase. Checkpoints:
  - **C1 pre_plan** (waitForFormReady, dismissConsentBanner, getState+buildInventory,
    extractText): verify-wall→submitted, code-gate→submitted, OAuth-first scan,
    anti-bot→blocked, oauth-only→required/needs-session, already-signed-in→already_oauth.
  - **C2 plan** (planSignupForm, may throw): error-replan vs upstream-blip-retry vs planning_failed.
  - **C3 post_plan** (pure on plan+inventory — the ONLY genuinely-pure checkpoint today):
    dashboard-pivot→already_oauth, stuck-repeat→planning_failed, verifyPlan→error-replan.
  - **C4 post_execute/post_submit** (executePlan, checkRequiredAgreementBoxes,
    runCaptchaGate×2, clickSubmit, extractText): commit-to-email, empty/no-fill replan,
    submit_disabled snapshot-hint replan, submit-timeout replan, post-submit-Turnstile→submitted,
    validation→replan/submitted.
- **A2 — the OAuth-first scan is a nested state machine** (4778–4923): own budget
  resets (`oauthScanRetries`→0 on shell-reload AND on advance-click), 3 recovery
  actions (`wait(3)`, `goto(currentUrl)` reload, `click(advance)`), loading-shell
  predicate gating max-retries 2-vs-8. `wait`/`reload`/`advance` are SEMANTICS —
  must be explicit reducer actions with explicit `nextState` budget resets, or the
  getstream/lancedb/replit loading-shell recovery regresses.
- **A3 — `committedToEmailPath` is one-way control-state, not a flag** (4645/4778/
  5132). Seeded from `forceFormFill`; once set, suppresses the entire C1 OAuth-first
  scan. Recompute it and the rc.30 Railway two-stage-chooser regression returns
  (methoxine Security-Code challenge). Carry it in `state`.

### Must-enumerate faithfulness findings

- **Q1 — the counter taxonomy is THREE debts, not one budget.** `errorReplans`
  (max2: invalid planner output) vs `progressReplans` (max6: page advanced, no fill
  — ALSO charged by submit_disabled / submit-timeout / post-submit validation) vs
  `upstreamBlipRetries` (max8: 50x/network — deliberately does NOT tick errorReplans)
  vs `emptyPlans` (bail at 2 *consecutive*, reset on any non-empty plan). Commit 2
  must state which branch ticks which counter — a misattribution silently changes
  how many attempts a real signup gets (mailgun's 6th-plan checkbox).
- **Q2 — `submit_disabled` replan is impure by construction** (5234–5298). The hint
  is synthesized from a FRESH `buildInventory(…, 60)` snapshot. Reducer emits
  `replan(hintIntent)`; the executor owns snapshot→hint *content*. This is the one
  seam that genuinely cannot be pure — and that's correct, not a compromise.
- **Q3 — two non-local terminal-outcome exceptions.** (a) `captcha_blocked` +
  `turnstile` + `task.inbox` → flips to `submitted` (managed Turnstile resolves
  server-side, inbox arbitrates; cartesia). (b) post-submit validation with
  `progressReplans` exhausted → `submitted` (extraction is the real arbiter). Both
  depend on `task.inbox`/budget — enumerate or regress to false `captcha_blocked`.

### Tests

- **T1 (good)** — the 4 extracted primitives + 10 tests are faithful to 5050–5096
  and 5184–5206 (verified line-by-line); the kinde + field-edit cases pin the
  MEASURED 2026-06-13 regressions. Keep.
- **T2 (gap for commit 2)** — write a **golden-transition table** (one fixture per
  terminal outcome ×9 + major replan paths) asserting `(state, observation) →
  action + counter deltas` BEFORE wiring. This is the only parity gate for the
  default-off→on flip beyond live runs. Pin Q1, Q3, A3 explicitly.

### Performance

- **P1** — preserve the C1 `Promise.all([getState, buildInventory])` (4662) and the
  "reuse state.html, don't re-extractText" optimization (4675): keep I/O batching in
  the EXECUTOR. A naive "observation gathers everything" serializes or double-reads.
- **P2** — reducer itself is pure CPU over small inputs; no perf risk.

### Commit-2 enumeration checklist (the analog of OAuth's 8 gaps)

1. 4 checkpoints C1–C4 as `state.phase`.
2. OAuth-first nested scan: 3 actions + 2 budget resets (A2).
3. `committedToEmailPath` carried one-way control-state (A3).
4. 4-counter taxonomy + which branch ticks each (Q1).
5. `replan` carries a hint *intent*; executor owns hint *content* (Q2).
6. 2 terminal-outcome policy exceptions (Q3).
7. Golden-transition table test as the parity gate (T2).
