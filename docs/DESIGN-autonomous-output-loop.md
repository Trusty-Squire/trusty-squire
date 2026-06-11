# DESIGN — Autonomous output-side loop (failure → fix → RC → promote)

Status: drafted 2026-06-09. Owner: bot/housekeeper. Companion to
`docs/AUTONOMOUS-LOOP.md` (the run loop) and
`docs/DESIGN-planner-navigation-eval.md` (the eval gate, **already shipped**).

## Goal

Close the loop on the **output** side: the daily heal run's failures should
feed back into the bot's own code automatically, compounding run over run, with
the human reduced to a single evidence-gated button — promote a vetted release
candidate to `latest`. No per-failure human triage; no upfront "fixable vs wall"
categorization. The default action for every failure is **try to fix it**; a
"wall" is just the residual a fix attempt earns by articulating a concrete infra
reason (real phone / real card / IP-reputation) it can't be beaten.

## What closes, precisely

```
daily run on `next` (frozen RC bot)
  → failure batch (all non-success outcomes + traces, one frozen bot version)
  → holistic fix-agent:
        cluster failures by root cause
        propose a GENERALIZING fix per cluster (prompt or nav code)
        iterate against the EXISTING eval-gate until regress == 100% (+ target lift)
        commit to `staging`, bump -rc.N
  → CI ships the `next` dist-tag
  → next day's run runs that RC live → measures OF#2
  → human promotes next→latest when OF#2 holds across N runs   ← the only human touch
```

Two properties this leans on, both already true:
- The run is a pure measurement pass against one frozen bot version, so the
  run-over-run OF#2 delta cleanly attributes to the last batch of fixes.
- Every success already appends to the regress gate (`build-corpus` derives a
  regress case per gold-path round), so the gate grows with coverage.

## What already exists — do NOT rebuild

| Asset | File(s) | Role in this loop |
|---|---|---|
| **The eval gate** (reject-driven, temp-0, deterministic) | `apps/mcp/src/bot/eval-gate.ts`, `eval-corpus.ts` | The regression gate the fix-agent reconciles against. `regress` bucket must stay 100% (`regressGatePassed`). |
| **Regress corpus + builder** | `apps/mcp/corpus/eval/`, `build-corpus.ts` | 8 regress / 14 target cases today; auto-derived from successful gold paths, R3-redacted. Grows from every success. |
| **Target set + labeler** | `corpus/eval/target/{tune,holdout}/`, `label-target.ts` | The generalization signal (report-only macro-avg lift; sealed holdout). |
| **CI gate** | `.github/workflows/planner-eval.yml` | `harness` job (deterministic, blocking) + `eval-gate` job (advisory Phase 1; flips to blocking Phase 2). Path-filtered to planner code + corpus. |
| **Failure-batch substrate** | `<slug>-<runId>.outcome.json` sidecars, `failure-stage.ts`, `failure-stats.ts` (`aggregateOutcomes`) | Per-run terminal outcome + `failure_stage` enum + the per-stage / per-service aggregator. This IS the fix-agent's input. |
| **Determinism pin** | `UNIVERSAL_BOT_OR_PROVIDER`, temp-0 planner | A green→red in the gate is a real regression, not routing dice. Required for the fix-agent's iterate-against-gate loop to be trustworthy. |
| **Release fence** | `.github/workflows/release.yml` (shape-check L174–179) | `main`+stable→`latest`, `staging`+rc→`next`. Hard-errors on a mismatch — so the fix-agent is *structurally* unable to publish `latest`. |
| **OF#1/OF#2 + HealRun + dashboard** | `apps/registry/.../admin-dashboard.ts`, `HealRun` | The metrics + trend the promote decision keys off (just shipped). |

The eval-harness layer is ~done. The R2 doctrine in the eval design —
"**offline eval = fast iteration substrate; a representative LIVE batch is the
ship gate**" — maps exactly onto our `next`→`latest` split. R2 *is* the promote
rule. Nothing about the gate needs inventing; we automate the human who today
drives A7.

## Scope boundary (read before building the fix-agent)

The shipped gate covers the **post-OAuth navigation planner only**
(`planPostVerifyStep` / N1 onboarding — reach + extract the key). It explicitly
does **not** gate the **form-fill signup planner** (`eval-planner.ts` is
"pattern reuse only, out of scope" per the eval design).

**Consequence:** the fix-agent can safely touch post-OAuth-nav prompt/code
because a regression there is caught by the gate. A fix to *form-fill* code is
**ungated** and must NOT auto-ship. Two acceptable postures (pick one in C2):
- **(a) Fence the fix-agent to gated surfaces only.** It may edit the
  post-OAuth-nav planner + the prompt the gate exercises; any proposed fix that
  touches form-fill code is parked for human review instead of auto-committed.
- **(b) Extend the gate first.** Promote `eval-planner.ts` to a gated
  regress+target corpus (a second `build-corpus` over form-fill captures) before
  the fix-agent is allowed to touch form-fill. This is the eval-design's
  deferred "form-fill planner eval" item; it's the prerequisite for full
  autonomy over the whole signup, not just the tail.

Recommended start: **(a)** — ship the autonomous loop over the gated surface
now, treat (b) as the coverage-expansion that widens the loop's reach later.

## Components to build

### C1 — Failure-batch artifact (post-run)

After a heal/discover pass completes, consolidate every non-success into one
batch the fix-agent consumes. Almost entirely assembly over existing data.

- Source: the run's capture dir (`resolveCaptureDir()`), already holding
  per-round captures + `*.outcome.json` sidecars.
- Reuse `readOutcomes()` + `aggregateOutcomes()` (`failure-stats.ts`) for the
  per-service / per-stage view.
- Emit `corpus/onboarding/<runId>.batch.json`:
  ```ts
  interface FixBatch {
    run_id: string;
    bot_version: string;            // the frozen RC the run executed
    stats: FailureStats;            // from aggregateOutcomes
    failures: Array<{
      service: string;
      failure_stage: FailureStage;  // primary + contributing tags
      terminal_round: number;
      capture_refs: string[];       // round sidecar paths (DOM+inventory+screenshot)
      reproduce_count: number;      // same (service, signature) across the pass
      planner_reasoning?: string;   // last plan rationale, if captured
    }>;
  }
  ```
- `reproduce_count` + a `signature` (hash of url-path + sorted top-N inventory)
  exist only to **cluster** in C2 — not to route. Label/stage is a hint, never a
  gate.

### C2 — The holistic fix-agent (automates A7)

A post-run coding agent (spawned via the Agent tool from the orchestrator, or a
standalone `mcp housekeeper --mode=fix` step). Input: one `FixBatch`. It does
what a human does in A7, in a loop:

1. **Cluster** failures by likely root cause (shared `failure_stage` +
   signature proximity + capture similarity). One generalizing fix per cluster,
   not one patch per service ([[feedback-generalize-not-per-service]]).
2. For each cluster, **propose a fix** to the planner prompt or the deterministic
   nav/inventory code — scoped per the boundary above.
3. **Reconcile against the gate (inner loop):** run `eval-gate` (temp-0,
   provider-pinned). Accept the fix only if `regress == 100%` AND
   `target-holdout` macro-avg did not drop (ideally rose). If red, iterate the
   fix; if it can't get green in K rounds, drop that cluster's fix and record
   why.
4. **Commit** the surviving fixes to `staging`, bump `-rc.N`, push. CI ships
   `next`. Open nothing on `main`.
5. For clusters it could neither fix nor get past the gate, write a
   `wall-candidate` record with the concrete reason (or "no articulable reason,
   N attempts") → the small real human/physical queue. This is the residual, not
   a pre-judged category.

Hard invariants (enforced, not trusted):
- Only ever writes to `staging` with a prerelease version. The release
  shape-check is the backstop, but the agent must target `staging` itself.
- A fix touching ungated surface (form-fill, under posture (a)) → park for human,
  never auto-commit.
- Never edits the corpus to make the gate pass (no grading its own homework). The
  corpus is append-only-from-successes via `build-corpus`; the fix-agent is
  forbidden to write `corpus/eval/**`. Enforce in the agent's allowed-paths.

### C3 — RC-fenced release path

Mostly configuration over existing automation:
- The fix-agent's commit step bumps `apps/mcp/package.json` to the next
  `-rc.N` and pushes `staging`. `release.yml` already publishes `next` and
  hard-errors if the shape is wrong.
- Add a thin guard in the agent: refuse to run if the current branch resolves to
  `main`, or if the computed version is non-prerelease.

### C4 — Dogfood the RC (`next`) on the operator box

The RC channel only means something if it's exercised. Point the housekeeper's
daily run at the `next`-tag bot so each day's run is the live test of yesterday's
RC.
- Operationally: the systemd unit runs from a source checkout pinned to
  `staging` (or installs `@trusty-squire/mcp@next`). One-line change to
  `tools/systemd/trusty-squire-heal.service` `WorkingDirectory` / launch.
- The run that *produces* tomorrow's `FixBatch` is itself running the RC the
  last batch shipped → the loop is self-testing.

### C5 — Promote signal + the one human button

- Stamp the RC `bot_version` on each `HealRun` (extend the row + the dashboard
  Objective-functions panel already added). Show OF#2 per-RC-version, run over
  run.
- Promotion = the existing stable-release SOP (`/ship` to `main`): cut a stable
  semver from the vetted RC → `release.yml` publishes `latest`.
- Promote criterion (R2, made concrete): OF#2 on the RC **held or rose across
  the last N runs** and no new `failure_stage` regression appeared. Start with a
  human reading the panel; the criterion is explicit enough to automate later if
  trusted.

## Eval harnesses

Three layers, two already exist:

1. **The regression gate (EXISTS — `eval-gate.ts`).** Deterministic temp-0
   replay of the committed corpus; `regress == 100%` is the hard merge gate;
   `target` buckets report generalization lift. This is what the fix-agent
   reconciles against in C2.3. No change needed beyond Phase-2 flip (advisory →
   blocking) in `planner-eval.yml` once the fix-agent is live.

2. **Fix-agent loop dry-run (NEW — deterministic, no LLM, no live signups).**
   The analogue of the eval design's "harness job". Feed the fix-agent a
   **synthetic `FixBatch`** and a **fake gate** and assert the *control flow*,
   not model output:
   - clusters a batch with a shared root cause into ONE fix, not N;
   - commits only when the (fake) gate returns green; iterates when red; gives
     up after K and emits a `wall-candidate`;
   - targets `staging` + a prerelease version; **refuses** on `main` / stable;
   - **refuses** to write `corpus/eval/**` or ungated form-fill paths (posture a).
   Pure and fast — runs in `ci.yml`. This is the gate on the *agent itself*.

3. **The live ship gate (EXISTS as doctrine — R2).** A representative live batch
   (the daily `next` run) must show verified-credential-acquisition-per-service
   (= OF#2) did not drop before `next`→`latest`. This is C5, not new
   machinery — it's the promote criterion.

## Build sequence

```
C1 (failure-batch artifact)  ──►  C2 (fix-agent + dry-run harness #2)  ──►  C3 (RC fence)
                                       │
C4 (dogfood next) ─────────────────────┘
C5 (promote signal) ──────────────────────────────────────────────────────►  next→latest
```

C1 is assembly over shipped data (~half day). C2 is the real net-new work and
its dry-run harness (#2) is built alongside it. C3 is a guard + a version bump.
C4/C5 are config + a dashboard column. Ship C1–C3 to get an autonomous
RC-producing loop; C4/C5 make the promote evidence-based.

## Tests

- **C1:** `aggregateOutcomes` already unit-tested; add a `FixBatch` assembler
  test (a dir of synthetic sidecars → the expected batch, reproduce_count
  grouping, signature stability).
- **C2 (harness #2, the load-bearing one):** the dry-run assertions above —
  cluster-collapse, green-only-commit, iterate-on-red, give-up→wall-candidate,
  staging-only/prerelease-only refusal, corpus-write refusal, ungated-path
  refusal. All pure, no LLM.
- **C2 integration:** plant a known past regression (e.g. the button-rank drop
  that suppressed the "Get API Key" CTA) into the deterministic nav path and
  confirm `eval-gate`'s regress bucket goes red — i.e. the gate the fix-agent
  trusts actually catches a real regression. (The eval design already calls for
  this "deliberately-wrong injected step fails the gate" test; reuse it.)
- **C3:** version-bump computes a prerelease on `staging`; the guard throws on
  `main`/stable.
- No live-signup tests in CI (flaky by definition) — the live signal is the
  daily `next` run, surfaced via C5.

## Failure modes / honest limits

- **Gate coverage is post-OAuth-nav only.** Form-fill regressions are invisible
  to the gate today; posture (a) fences the agent off them. Full-signup autonomy
  needs the deferred form-fill eval (boundary §, option b).
- **The gate protects only captured services** (thin at first; grows
  monotonically from successes). A regression on an uncaptured service rides to
  `next` and is caught only by the live dogfood run — which is exactly why C4
  exists and why promotion waits for OF#2 evidence (C5).
- **Goodhart on the offline eval.** Mitigated structurally: regress is
  reject-driven (can't be gamed by matching one historical quirk), the agent
  can't write the corpus, and the live `next` run is the real ship gate.
- **Fix-agent mislabels a real wall as fixable** — burns a few attempts, then
  emits a `wall-candidate`. Cheap and self-correcting; that's the intended
  "earn the wall" behavior, not a bug.
- **A bad RC sits on `next` until the next run.** Acceptable: `next` is opt-in
  (operator box + dogfooders), blast radius bounded, and `latest` users are never
  exposed until the human promote.

## Build status (2026-06-09) — C1–C5 implemented

All five components are built, typechecked, and tested (mcp 1951 pass, registry
206 pass). Files:

- **C1** `apps/mcp/src/housekeeper/fix-batch.ts` (+ `__tests__/fix-batch.test.ts`):
  `readFixBatch` joins outcome sidecars with round captures; `computeSignature`
  keys on path + sorted identity (not gloss). Read on-demand from the capture
  dir, scoped by a 24h window (`TRUSTY_SQUIRE_FIX_SINCE_HOURS`) — no persisted
  `.batch.json` (the fix step reads live; simpler, same effect).
- **C2** `fix-agent.ts` (pure orchestration + `__tests__/fix-agent.test.ts`, the
  dry-run harness) + `fix-agent-runtime.ts` (the coding-agent proposer, git
  committer, `evalGateRunner`) + `modes/fix.ts` + `--mode=fix` in `cli.ts`.
  `eval-gate.ts` gained an exported `runEvalGate()` returning a structured
  `EvalGateResult`. Invariants enforced + tested: staging/prerelease-only,
  path fence (corpus + ungated form-fill off-limits), green-only-commit,
  K=3 → wall-candidate.
- **C3** `release-guard.ts` (+ tests): `assertStagingPrerelease` / `computeNextRc`.
- **C4** `tools/systemd/trusty-squire-heal.service` runs `--mode=fix` as a
  best-effort `ExecStartPost`; **push is opt-in** (`TRUSTY_SQUIRE_FIX_AGENT_PUSH`)
  so RCs commit locally until the operator pushes. README documents dogfooding
  `next` (checkout on `staging`).
- **C5** reused the **existing `HealRun.mcp_version` column** (no migration
  needed — it was already wired through the store + route). The orchestrator now
  stamps `VERSION` on the heartbeat; the dashboard objectives trend gained an
  **RC** column (the per-RC promote signal).

Two deltas from the plan, both deliberate:
- **C1** reads the batch on-demand instead of persisting a `<runId>.batch.json`.
- **Tarball fence:** the operator-only fix-agent value-imports dev-harness
  modules (`eval-gate`, `failure-stats`) that are excluded from the published
  build. Compiling the housekeeper pulled them into `dist/bot`, so
  `apps/mcp/package.json` `files` now denylists `dist/bot/eval-*`,
  `build-corpus.*`, `label-target.*`, `failure-stats.*` — same pattern as the
  existing `dist/housekeeper` exclusion. The operator still gets them in its
  local `dist`; end users don't.

## Decisions (settled 2026-06-09)

1. **Boundary posture → (a) fence to the gated surface now.** The fix-agent may
   auto-commit only post-OAuth-nav fixes (covered by the shipped gate); a
   proposed fix that touches form-fill code is parked for human review. The
   form-fill eval (option b) is the later coverage-expansion that widens the
   loop's reach. C2 enforces this via allowed-paths.
2. **Promote → human reads the OF#2 panel.** `next`→`latest` stays a human
   `/ship`-to-`main`, gated on the per-RC OF#2 trend (held/risen across N runs +
   no new `failure_stage` regression). The criterion is written down (C5) so it
   can be automated later if trusted; it is NOT auto-promoted at launch.
3. **K = 3.** Three gate-red iterations per cluster, then the fix-agent parks a
   `wall-candidate` for human review. Mirrors the loop's existing 3-strike
   conventions.

## Loop closure (#1) — fix grading (2026-06-11)

The fix-agent committed RCs but nothing closed the feedback: "did the fix
actually lift the rate on the services it targeted?" That half is now the
**fix-grading ledger** (`apps/mcp/src/housekeeper/fix-ledger.ts`):

1. **Record (write side).** When `--mode=fix` commits a cluster fix, it appends
   an OPEN attempt to `~/.config/trusty-squire/fix-ledger.json`: the RC version,
   the targeted `services`, the page `signature`, and the fix summary. (The
   fix-agent now exposes `services`/`signature` on each committed entry.)
2. **Grade (read side).** Every heal pass records per-service discovery
   outcomes (`HousekeeperBatchSummary.serviceOutcomes`). After discovery,
   `runHealPass` calls `gradeLedgerAgainstPass`: for each open attempt whose
   targeted services were re-tested this pass, it grades
   `improved` / `partial` / `regressed`, or leaves it `no_data` (not re-tested
   yet) to grade on a later pass. The verdict is recorded once.
3. **Surface.** Newly-graded attempts go into the heal digest
   (`… · fixes graded N (X✓/Y✗)`) and the per-attempt line via `describeGrade`.

Grading is pure (`gradeAttempt` / `applyGrades`) and unit-tested without the
filesystem. A blocked wall is not a fix signal, so it's excluded from the
per-service map. State is operator-only (next to the unknown-state store),
excluded from the npm tarball with the rest of `housekeeper/`.

**Still open (next slice):** auto-revert/flag a `regressed` fix, and surface
the ledger on the admin dashboard (a "fix outcomes" readout) so the operator
sees the loop's output quality over time, not just per-digest.
