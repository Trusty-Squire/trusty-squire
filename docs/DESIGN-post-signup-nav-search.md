# DESIGN — Post-signup navigation as goal-directed search

Status: reviewed (plan-eng-review 2026-06-14, incl. outside-voice challenge), not
yet implemented. Owner: bot. Scope: the universal signup bot's POST-authentication
phase only.

## Problem

The back half of every signup — getting from "authenticated" to "API key
extracted" — is where runs fail hardest. The current `postVerifyLoop`
(`apps/mcp/src/bot/agent.ts`, ~12k-line file) drives it as **greedy per-screen
vision-LLM step-picking**: each round it screenshots/inventories the page and
asks the LLM "what now," up to 24 rounds. Dominant failure modes:

- **URL-guessing 404s** — composes key-paths from a hardcoded convention list
  and 404s on non-standard paths (unify, luma).
- **run_timeout flailing** — no goal definition, no frontier → random walk to the
  600s cap (luma-ai ×4, unify-ai, writer).
- **premature-done / no_credentials_after_already_signed_in** — gives up without
  a concrete "have I arrived" test.
- **trapped in onboarding wizards/modals** — imagekit role-select, unify "Hire
  Assistant", "name your project" — each treated as a novel page.

Root cause: the goal is narrow and identical across services (find/create an API
key), but pursued with the wrong algorithm. Dashboards aren't standardized, so
platform handlers don't help here — but every dashboard exposes a finite set of
affordances (links AND buttons, some behind expandable menus), and the bot
ignores that map.

## Approach: goal-directed search over the dashboard's affordances

Replace greedy LLM step-picking with a bounded search whose candidates are the
dashboard's own navigable affordances and whose goal is a concrete verifier.

```
  authenticated landing
        │
        ▼
  EXPAND latent nav (hamburger / avatar / settings menus) ──┐  ← outside-voice #1
        │                                                    │
        ▼                                                    │
  enumerate candidates = links + BUTTONS (not just <a>)  ────┘  ← outside-voice #2
        │
        ▼
  rank by relevance ── deterministic keyword score (reuse findApiKeysNavLink);
        │              LLM only on tie / zero-score              (A1)
        ▼
  try top-N with backtrack  (flat rank-once, depth ~1-2;        ← outside-voice #4
        │                    NOT a URL-keyed frontier — SPA      (revised from
        │                    re-renders make URL keys unstable)   "best-first frontier")
        ▼
  blocking overlay? ──interstitial (anti-bot)──▶ waitForFormReady (existing)
        │            ──wizard/modal──▶ dismiss OR satisfy minimal step
        ▼
  goal verifier ── distinguishes ARRIVED (key string / masked+reveal /
        │           existing key listing) from START-OF-GATED (a "Create API
        │           key" BUTTON → that's a subgoal, not done)   ← outside-voice #3
        │
        ├─ arrived but masked/copy ──▶ ACTION STEP (click reveal/copy) ──▶ extract
        ├─ create-key affordance ────▶ subgoal: create → re-search
        ├─ no key, "create project" ─▶ subgoal: create project → re-search (bounded)
        ├─ extracted ────────────────▶ DONE
        └─ candidates exhausted ─────▶ honest no_self_serve_key
```

### Reviewed decisions (plan-eng-review 2026-06-14)

- **A1 — ranking: deterministic-first, LLM tiebreak.** Score candidates by
  href/text keywords (reuse `findApiKeysNavLink` scoring) as the PRIMARY ranker;
  call the LLM only to break ties or when zero candidates score. Deterministic
  hot loop; LLM is a bounded component, not the engine.
- **A2 — kill-env flag + capture-chain parity (REVISED from hard-replace).**
  Route the cutover behind `NAV_SEARCH` (default on). Reason the outside voice
  surfaced: the greedy loop emits a **per-round capture chain** the skill
  synthesizer depends on for auto-promote (OF#1); a nav-search that doesn't emit
  the same capture shape can silently stop minting skills even on runs that still
  extract a key — and a key-extraction live gate won't catch it. So: (a) flag for
  one-env-var rollback (delete flag + old loop after 1-2 clean heal cycles), and
  (b) **capture-chain parity is a hard requirement with an explicit test**, and
  (c) the live gate asserts skill-minting, not just key extraction.
- **A3 — new pure module `apps/mcp/src/bot/nav-search.ts`.** Search loop +
  ranking + goal verifier + overlay handler as pure-ish logic taking the browser
  + existing helpers as inputs. `postVerifyLoop` becomes a thin caller.
  Unit-testable without a browser.
- **A4 — strangler-fig de-monolithing.** No separate big-bang refactor of
  agent.ts. Each architecture phase carves one coherent module out behind tests:
  **nav-search (this slice)** → OAuth/consent → form-fill/captcha → extraction →
  capture-chain. agent.ts shrinks to a thin orchestrator over time. Discipline:
  extract and behavior-change in SEPARATE commits (Beck — make the change easy,
  then make the easy change).

### Outside-voice corrections folded into the design

1. **Expand latent nav before enumerating** — open hamburger/avatar/settings
   menus so the keys link (often not in the rendered top nav) is in scope.
2. **Candidates = links + buttons** — the keys page is often reached by a button,
   not an `<a href>` (and `findApiKeysNavLink` currently skips buttons). The
   non-standard-host services that 404 today are exactly the button-reached ones.
3. **Goal verifier distinguishes arrived-vs-start-of-gated** — a "Create API key"
   button is a subgoal, not arrival. Masked/copy keys need an ACTION STEP (click
   reveal/copy) between arrival and extraction.
4. **Flat rank-once + backtrack, not a URL-keyed frontier** — real depth is ~1-2;
   a frontier's URL-keyed visited-set breaks on SPA re-renders and OAuth
   `?code=`/`#token` fragments (revisit-loops or false skips). Keep a small
   tried-set keyed by affordance identity, not URL.
5. **Interstitial-aware** — an anti-bot "Verifying you are human" page between
   clicks is NOT a dead end; route it to the existing `waitForFormReady`/captcha
   handling, don't count it as candidates-exhausted.

## Component design (`nav-search.ts`, new)

- `expandLatentNav(browser)` → open obvious menu toggles (hamburger / avatar /
  "Settings" gear) so hidden nav mounts before enumeration.
- `enumerateCandidates(inventory)` → links AND buttons with href/text/aria.
- `rankCandidates(candidates)` → deterministic keyword score (reuse
  `findApiKeysNavLink` scoring, extended to buttons); `needsTiebreak` on tie/zero.
- `reachedKeyGoal(state)` → composes EXISTING detectors: `EXISTING_KEY_URL_HINT`,
  `findCreateKeyAffordance` (as START-OF-GATED, not done), `detectExistingAccountNoExtract`,
  the extractors. Returns `arrived | start_of_gated | not_yet`.
- overlay handler → generalize inline `WIZARD_FORWARD` (agent.ts:10413): detect
  dialog/aria-modal/full-screen onboarding → dismiss or satisfy minimal step.
- subgoals → create-key (click → fill name → create → extract) and create-project
  (bounded: one create affordance + submit; if it needs a plan/billing/region
  value the bot lacks, STOP with an honest gated-key reason — do NOT branch
  per-service).
- LLM demoted to: rank tiebreaker, "is this the keys page" classifier when the
  deterministic verifier is unsure, and the fallback for a genuinely bespoke
  screen with no recognizable affordances.

## Test plan

Unit (pure, no browser):
- rank: deterministic top pick with a keys link/button present; `needsTiebreak`
  only on tie/zero; buttons included.
- `reachedKeyGoal`: arrived (key string / masked+reveal / existing listing) vs
  start_of_gated (create-key button) vs not_yet (dashboard, marketing).
- candidate exhaustion → `no_self_serve_key` (not a timeout); tried-set keyed by
  affordance identity terminates.
- overlay handler: dismiss, satisfy-minimal-step, no-false-trigger on a real form.
- subgoals: create-key flow; create-project then re-search; gated-stop when a
  required value is missing.
- **capture-chain parity (A2): a nav-search run emits the same per-round capture
  shape the synthesizer consumes** (the OF#1 safety test).

Live-validation GATE before the flag flips to default-only / old loop deleted:
- serial re-run on: URL-guess victims (unify-ai, luma-ai), known-good (galileo),
  an `oauth_onboarding_failed` cohort, plus a menu-hidden-nav service and a
  button-reached-keys service (outside-voice #1/#2 coverage).
- assert: no regression on galileo-class, ≥ parity on the failures, AND
  **auto-promote/skill-minting still fires** (not just key extraction).

## NOT in scope (deferred, with rationale)

- Platform-first auth handlers (Clerk/Auth0/WorkOS/Supabase) for the front half —
  separate piece; the back half is where the bleeding is.
- Big-bang refactor of agent.ts — replaced by A4 strangler-fig.
- Genuinely-bespoke long tail (no enumerable affordances, real phone gates) —
  falls to the LLM fallback; some stay unservable, honestly.
- Replacing skill-registry replay recipes with nav/platform generality — related,
  separate.

## What already exists (reuse, don't rebuild)

`findApiKeysNavLink` (ranker primitive, extend to buttons), `findCreateKeyAffordance`
(start-of-gated detector), `detectExistingAccountNoExtract` + `EXISTING_KEY_URL_HINT`,
the extractors (`extractLabeledCredentialCandidates` / `revealMaskedCredentials` /
`extractCredentialsNearCopyButtons`), `WIZARD_FORWARD` (generalize),
`waitForInteractiveDom` / `originRoot` / `isLoadingShell`, the captcha/interstitial
`waitForFormReady`. `pickStuckLoopFallbackUrl` (URL-guesser) → demoted to
last-resort, removed once nav-search proves out. The per-round capture writers
(`writeFastPathSyntheticCapture` / the verifyCaptureChain coupling) → MUST be
preserved by nav-search (A2 parity).

## Failure modes (per new codepath)

- nav enumeration empty (SPA not hydrated / nav behind a menu) → expandLatentNav
  + bounded `waitForInteractiveDom`, then honest exhaustion. Test: yes. **This is
  the outside-voice's biggest risk (silent false dequeue) — the menu-expansion +
  button inclusion + the menu-hidden-nav gate service exist to catch it.**
- LLM tiebreak errors → fall back to top deterministic score. Test: yes.
- overlay handler dismisses a real form → gate to confirmed overlays; re-assess.
  Test: no-false-trigger.
- goal-verifier false-positive on a create-key button → returns start_of_gated,
  not arrived. Test: yes.
- capture-chain not emitted → OF#1 regression; caught by the parity test + the
  skill-minting assertion in the live gate.

## Implementation tasks

- [ ] **T1 (P1)** — `nav-search.ts`: expandLatentNav + enumerateCandidates
  (links+buttons) + rankCandidates (deterministic, LLM tiebreak) + tried-set +
  termination. Pure, unit-tested.
- [ ] **T2 (P1)** — `reachedKeyGoal` verifier (arrived / start_of_gated / not_yet)
  composing existing detectors; action-step for masked/copy; unit-tested.
- [ ] **T3 (P1)** — generalize `WIZARD_FORWARD` into the overlay handler
  (wizard/modal + interstitial routing); unit-tested.
- [ ] **T4 (P1)** — subgoals: create-key + bounded create-project; gated-stop.
- [ ] **T5 (P1)** — wire `postVerifyLoop` (3 call sites) to call NavSearch behind
  the `NAV_SEARCH` flag; demote `pickStuckLoopFallbackUrl`. Preserve the per-round
  capture chain (A2 parity).
- [ ] **T6 (P1, GATE)** — capture-chain parity test + live-validation sweep
  (unify-ai, luma-ai, galileo, oauth_onboarding cohort, menu-hidden + button-reached
  services) proving match-or-beat AND skill-minting intact before flag→default.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found→resolved | 4 architecture decisions (A1-A4); outside voice surfaced 5 gaps, all folded |
| Outside Voice | Claude subagent | Independent 2nd opinion | 1 | issues_found | nav-space-too-narrow, capture-chain/OF#1, verifier FP, frontier-overkill, seams — all folded or accepted |

- **CROSS-MODEL:** Two tensions surfaced. A2 (hard-replace→flag+capture-parity): outside voice's OF#1 capture-chain risk accepted → revised to kill-flag + parity test. Search model (frontier→flat rank links+buttons): accepted → revised. Other 3 outside-voice findings folded as required corrections.
- **VERDICT:** ENG CLEARED — architecture locked (A1 deterministic-first ranking, A2 flag+capture-parity, A3 pure nav-search module, A4 strangler-fig). Ready to implement T1-T6; T6 is the merge gate.

NO UNRESOLVED DECISIONS
