# DESIGN — Post-OAuth navigation: eval harness + flakiness investigation

Status: planned 2026-06-05. Owner: bot. Reviewed via /plan-eng-review.

## Problem

Services authenticate fine (the 2026-06-04 sweep was 77% authenticated) but
the vision+DOM LLM planner (`postVerifyLoop` / `planPostVerifyStep` in
`apps/mcp/src/bot/agent.ts`) can't reliably reach/extract the API key. Three
failure modes block progress, and they are about the PROCESS, not any one prompt:

1. **No generalization** — a prompt fix that helps one service often doesn't
   help unseen services.
2. **Regressions** — a prompt fix breaks services that already passed.
3. **Flakiness** — OAuth/planner/proxy non-determinism makes a single live
   pass/fail an unreliable signal; we can't tell a real improvement from luck.

Root cause of why we can't make progress: **we iterate the prompt against live,
flaky, ~6-min signups with no regression guard and no held-out generalization
measurement.** You cannot improve a non-deterministic system you can't measure.

## Decisions (locked via /plan-eng-review)

- **D1 — Step-level eval, extending `eval-onboarding.ts`** (not trajectory replay).
  Each captured post-OAuth PAGE is one labeled case: the set of acceptable
  next-actions. Score the planner's single-step decision against the label.
  Deterministic, cheap, grows from the real corpus. (Trajectory replay hits the
  fundamental offline-agent problem — a counterfactual action has no recorded
  next-state — for marginal extra signal; deferred.)
- **D2 — Planner temperature = 0.** Today the planner LLM call sets NO
  temperature → provider default (~0.7) → same page decides differently
  run-to-run. Setting it to 0 removes the dominant planner-flakiness source AND
  makes the offline eval faithful to production (a green→red is a real
  regression, not dice).
- **D3 — Auto-derive the regression set; hand/LLM-label the target set.** A
  successful run's recorded action sequence IS the gold path → each
  page→action-taken auto-labels as "acceptable" (the regression guard, free,
  high-volume). The ~20 target services have no success path → curate a smaller
  hand/LLM-labeled generalization set ("what it SHOULD do at this stuck page").

## Adversarial review (codex) — accepted revisions

Decision: proceed with the build (the N1 bucket IS the planner-navigation
failures by definition), but fold in the non-contested fixes. The skipped
measure-first re-sequence is an accepted risk, bounded by R2 below.

- **R1 — Reject-list gate, NOT exact-match (codex #2/#3/#4).** The 100%
  exact-match-on-gold-path gate is a trap ("never disagree with a historical
  quirk"). Instead: a regress case carries (a) `rejectActions` = the
  KNOWN-WRONG steps (a step that provably stalled / left the page unchanged /
  navigated away from the key — derivable from captures where that action did
  NOT advance), and (b) `acceptActions` = the UNION of gold-path actions across
  ALL successful runs of that equivalent page (multiple acceptable answers per
  state). The gate fails only on a `rejectActions` hit, not on "didn't match the
  one historical action". This lets real improvements through while still
  catching genuine regressions.
- **R2 — End-to-end ship gate (codex #1/#20).** The eval is a proxy and can
  Goodhart. HARD RULE in A7: an offline-eval win ships only after a representative
  LIVE batch confirms verified-credential-acquisition-per-service did not drop.
  Offline = fast iteration substrate; live batch = the actual ship gate.
- **R3 — Corpus secret redaction (codex #14/#15) [P0].** Captures contain real
  API keys, emails, org IDs, cookies, tokens in DOM + screenshots. A mandatory
  redaction pass (regex: known key prefixes, the run's own email/alias,
  `Set-Cookie`/`Authorization`, 32-hex/UUID secrets; blur/strip screenshots of
  key panels) runs BEFORE any derived corpus is committed. Full captures stay in
  `~/.trusty-squire/corpus/` (gitignored); only the redacted eval corpus is
  committed.
- **R4 — Extraction correctness, not just clicks (codex #12).** Target labels
  MUST include the terminal cases: "the key is already visible → `extract`",
  "must `create`/regenerate/copy", "stop". The `extract` step-kind already
  exists; the corpus weights these, not just navigation clicks.
- **R5 — Folded-in refinements:** baseline pinned to a frozen prompt + model
  VERSION, lift reported with model held constant (codex #16); per-service
  macro-average + per-service pass, not just case-level X/Y (codex #17); sealed
  holdout with a rotation policy so inspection doesn't turn it into tune (#18);
  `failure_stage` = primary + contributing tags, not exactly-one (#13);
  semantic dedup that PRESERVES workspace/empty-project/modal/disabled-button/
  hidden-tab variants, not URL+title+html similarity (#11); outcome-join handles
  partial runs / crash-before-outcome / dup run-ids / concurrent housekeeper
  (#10).
- **R6 — Temp 0 is EVAL-faithful; production keeps its escape hatch (codex #5).**
  Temp 0 removes sampling noise and makes the eval match production, but a
  deterministic loop can't sample its way out. Production temp 0 is paired with
  the EXISTING stall-detector + prior-action memory as the escape; if a later
  failure_stage measurement shows `planner_loop` RISING after temp 0, revisit
  (low-temp, or an explicit "tried-X-failed → propose-different" step).

## What already exists (do NOT rebuild)

| Asset | What it is | Gap to close |
|---|---|---|
| `eval-onboarding.ts` | "Anti-overfitting instrument": corpus of post-OAuth page states → acceptable next-step kinds, scored vs `planPostVerifyStep`. `scoreOnboardingStep` pure+tested. | Synthetic seed corpus; single-step only; manual `tsx` dev-harness; no regression/target split; no gate. |
| `onboarding-capture.ts` | Captures every live round to `corpus/onboarding/<svc>-<runid>-rN.json` = `{state{url,title,html,screenshot}, inventory[], step}` chained by `prev_hash`. | Doesn't carry the run's terminal OUTCOME — needed to know which captures are "gold path". |
| `eval-planner.ts` | Same pattern for the form-fill picker (role→selector accuracy). | Same: synthetic, manual. (Out of N1 scope; pattern reuse only.) |
| `planner-shadow.test.ts`, `replay-skill.ts` | LLM-mode shadow test + skill replay. | Reuse the harness conventions. |
| `corpus/onboarding/*` on disk | Hundreds of MB of REAL captures (algolia, baseten, railway, northflank, together, ...). | Not joined to outcomes; not labeled. |

This is ~70% of the harness. The work is "evolve the dev-harness into a
corpus-driven, gated regression+generalization eval", plus a separate live-
flakiness investigation.

## Architecture

```
                          ┌─────────────────── WORKSTREAM A: offline eval ───────────────────┐
 live signups             │                                                                  │
 (housekeeper)            │   corpus/onboarding/*.json  ──►  build-corpus  ──►  eval cases     │
   │  per round           │   (page state + inventory        (join rounds      ┌────────────┐ │
   ├─ capture round ──────┼──► + planner step, chained)        with run        │ regress/   │ │
   │                      │                                    OUTCOME)         │ target set │ │
   └─ terminal outcome ───┼──► run-outcomes.jsonl ────────────────────────────►└────────────┘ │
      (ok / fail+stage)   │                                                          │         │
                          │   eval-onboarding (temp 0)  ◄────────────────────────────┘         │
                          │     for case: planPostVerifyStep(page) vs acceptKinds              │
                          │     GATE: regress set == 100%   ·   report target lift             │
                          └──────────────────────────────────────────────────────────────────┘

                          ┌─────────────────── WORKSTREAM B: flakiness ──────────────────────┐
 live signups ───────────┼──► tag each failure with failure_stage enum ──► run K svc × M     │
                          │    (oauth_handshake | account_chooser | consent | proxy_timeout    │
                          │     | hydration | planner_loop | extract | verify_email)           │
                          │    ──► per-stage distribution + per-service pass-rate variance     │
                          │    ──► attack the DOMINANT source (temp 0 already kills planner)   │
                          └──────────────────────────────────────────────────────────────────┘
```

### Data model — the eval case (extends `OnboardingExpectation`)

```ts
interface EvalCase {
  id: string;                 // <service>-<runid>-r<N>
  service: string;
  set: "regress" | "target";  // regress = auto from gold path; target = labeled
  page: {                     // the frozen DOM state (deterministic substrate)
    url: string; title: string; html: string;
    inventory: InteractiveElement[];
    screenshot: string;       // base64; the planner is vision+DOM
  };
  acceptKinds: StepKind[];    // correct next-step kinds
  rejectKinds?: StepKind[];   // explicitly-wrong (documents the trap)
  selectorsAnyOf?: string[];  // when a click/fill must hit one of these
  source: "gold_path" | "human" | "llm_proposed_human_confirmed";
}
```

The scorer is the EXISTING `scoreOnboardingStep` (pure, already unit-tested);
we only grow the corpus and wrap it in a gated runner.

### Two-set semantics (the load-bearing guardrail)

- **Regress set** (auto, from successful captures' gold paths): the gate fails
  only when the planner picks a `rejectActions` step (a KNOWN-WRONG action, per
  R1) on a regress page — NOT when it merely differs from the one historical
  action. `acceptActions` is the UNION of gold-path actions across all
  successful runs of the equivalent page. This stops regressions without
  blocking better routes.
- **Target set** (labeled, the ~20 N1 services): the generalization signal —
  report per-service pass + macro-average lift (R5), never tuned ON the
  `holdout` subset; rotate the sealed holdout (R5) so inspection doesn't turn it
  into tune.

## Workstream A — eval harness (sequenced)

A1. **Thread `temperature` (D2).** Add `temperature?: number` to `LLMRequest`;
    forward it in `ProxyLLMClient`/OpenRouter/Anthropic clients + the API LLM
    proxy. Set `planPostVerifyStep` (and `planExecuteWithRetry`) to `0`. Unit:
    request serializes temperature; planner call passes 0.

A2. **Carry the run outcome into captures.** Write a sibling
    `corpus/onboarding/<service>-<runid>.outcome.json` = `{ok, credential,
    failure_stage, terminal_round}` at run end (the bot already knows this).
    Lets the corpus builder tell gold paths from dead ends.

A3. **`build-corpus` (auto-derive) + REDACT (R3).** Script: walk captures, join
    with outcomes (robust to partial/crash/dup/concurrent per R5); for every
    SUCCESSFUL run emit `regress` cases per round, merging `acceptActions`
    across all successful runs of the equivalent page and deriving
    `rejectActions` from actions that did NOT advance (R1); semantic dedup that
    preserves state variants (R5). RUN THE REDACTION PASS (R3) before writing.
    Output a committed, versioned, redacted `corpus/eval/regress/*.json`; full
    raw captures stay gitignored.

A4. **Label the target set.** For the ~20 N1 services' stuck-page captures,
    hand-label (LLM proposes accept/reject kinds → operator confirms) into
    `corpus/eval/target/{tune,holdout}/*.json`. ~3 themes
    (create-resource / locate-in-UI+404 / finish-onboarding).

A5. **Gated runner.** Promote `eval-onboarding`'s `main()` into a CLI/test:
    run all cases at temp 0, print `regress: X/X · target-tune: a/b ·
    target-holdout: c/d`. Exit non-zero if regress < 100%.

A6. **CI gate (advisory → blocking).** New workflow, path-filtered to the
    planner-prompt + planner code. Phase 1: advisory comment with the deltas.
    Phase 2 (once corpus trusted): block merge on regress < 100%. Reversible
    rollout (start advisory) per the engineering-manager "make the cost of
    being wrong low" instinct.

A7. **Iterate the prompt against the harness + E2E SHIP GATE (R2).** Prompt
    changes iterate against the offline eval (fast, deterministic): keep only
    changes with NO regress-set `rejectActions` hit AND a `target-holdout`
    macro-avg lift. THEN the hard ship gate: a representative LIVE batch must
    confirm verified-credential-acquisition-per-service did not drop before the
    prompt ships. Offline = iteration; live batch = ship gate.

## Workstream B — flakiness investigation (measurement-first)

B1. **Structured `failure_stage`.** Add an enum tagged on every terminal
    failure (most already implied by the error string): `oauth_handshake |
    account_chooser | consent | proxy_timeout | hydration | planner_loop |
    extract | verify_email | run_timeout`. Emit in the ProvisionEvent + the
    capture outcome (A2).

B2. **Quantify.** Run K≈8 representative services M≈5× each through the
    housekeeper; compute the per-stage failure histogram + per-service
    pass-rate variance. This is the "where is the noise" map. (~one batch.)

B3. **Attack the dominant source.** Temp 0 (A1) already removes planner-sampling
    noise — re-measure B2 to see how much it drops. Then the residual:
    proxy_timeout → retry-on-transient nav + the congestion blips we already
    saw; account_chooser/consent variance → existing handlers; hydration →
    adaptive waits (already partly shipped). Each fix re-measured against B2,
    not vibes.

B4. **Trust threshold.** Define "a live signup is a reliable signal" as
    pass-rate variance below a chosen bar after B3. Until then, the OFFLINE eval
    (deterministic) is the iteration substrate; live runs are final confirmation
    only.

## Sequencing / what ships first

```
A1 (temp 0) ──┬──► B1 (failure_stage) ──► B2 (quantify) ──► B3 (reduce) ──► B4
              │
              └──► A2 (outcome) ──► A3 (auto regress) ──► A5 (runner) ──► A6 (CI) ──► A7 (iterate)
                                    A4 (label target) ───────────┘
```

A1 unblocks both workstreams and is a half-day. A2+A3+A5 give a working
regression gate from FREE auto-labels before any hand-labeling (A4). Ship the
regression gate first (stops the bleeding), then the target set (drives lift).

## Tests

- A1: `LLMRequest` serializes `temperature`; each client forwards it; planner
  calls pass 0. (unit)
- A3 `build-corpus`: a synthetic successful run → N gold-path cases with the
  right accept/selector; a failed run → 0 regress cases. (unit, pure)
- A5 runner: regress-set scorer returns 100% on the gold-path of the corpus it
  was built from (tautology guard — proves the harness is wired right); a
  deliberately-wrong injected step fails the gate. (unit + integration)
- Reuse existing `scoreOnboardingStep` tests; add cases for `selectorsAnyOf` +
  `rejectKinds` precedence.
- B1: each terminal error maps to exactly one `failure_stage`. (unit, table)
- No live-signup tests in CI (flaky by definition); the eval is the CI signal.

## NOT in scope

- **Trajectory replay** (D1-rejected) — the off-corpus counterfactual problem;
  revisit only if step-level proves insufficient.
- **LLM-judge grading** (D3-rejected as the gate) — re-adds the noise temp-0
  removes; allowed only as a label-proposer in A4.
- **Form-fill planner eval** (`eval-planner.ts`) — separate concern; this is
  post-OAuth navigation only.
- **New per-service heuristics** — the whole point is to stop those
  ([[feedback-generalize-not-per-service]]).

## Failure modes

- Auto-derived regress labels encode a SUBOPTIMAL gold path (the bot reached the
  key via a clumsy route). Mitigation: `acceptKinds` is permissive (kind-level),
  and de-dup; a clumsy-but-correct path is still a valid "don't regress".
- Corpus staleness — services redesign dashboards; captures rot. Mitigation:
  re-build regress set from recent successful captures each release; date the
  corpus.
- Temp 0 makes a hard page deterministically loop. Mitigation: existing stall
  detector breaks it; the eval flags a prompt that loops a labeled page.
- Screenshot bloat — captures are ~1MB/round. Mitigation: the committed eval
  corpus stores a downscaled screenshot or DOM-only for cases where vision
  isn't decisive; keep the full captures out of git (they live in `corpus/`).
```
