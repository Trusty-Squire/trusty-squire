# Closed-Loop Skill Remediation

**Status:** Designed (eng-review locked 2026-06-02). Not yet implemented.
**Branch:** to be created (`closed-loop-remediation`).
**Supersedes:** the passive "A2 — skill-replay dashboard panel" TODO. The
panel was reframed: a sole operator will not crawl panels to diagnose rot.
The telemetry must *drive* the housekeeper toward autonomous remediation.

## Problem

The registry already knows when a skill rots (replay/verifier failures) and
already demotes it. But the loop from "rotted" to "re-skilled" is not closed:

1. **No verify→discover chaining.** `runOneBatch` pulls from exactly one queue
   per process. Verify and discover are separate invocations; nothing makes a
   just-demoted skill trigger a rediscovery.
2. **Demotion doesn't enqueue rediscovery.** A demoted skill for a service
   with no recent demand sits demoted forever — re-skilling is incidental
   (it only happens if the service independently shows ≥3 demand events).
3. **The demote trigger is failure-kind-blind.** `prisma-skill-store.ts:272`
   increments `consecutive_verifier_failures` on ANY failure. A transient
   Cloudflare interstitial, an empty-inbox timeout, and a genuinely-stale
   selector all count equally toward the 3-strike demote. In a chained loop
   this is a thrash engine: a working skill eats 3 blips → demote → 6-min bot
   rediscovery → maybe a worse skill → repeat.
4. **Demotion reason is discarded.** `prisma-skill-store.ts:374`:
   `void reason; // no demotion_reason column yet`. A demoted skill persists
   its *status* but not *why* — useless for manual targeting.

## What already exists (build on, don't rebuild)

| Machine | Where | Keep as-is |
|---|---|---|
| Proactive re-verify (freshness sweep) | `prisma-skill-store.ts` `next_freshness_due_at` (weekly) | ✓ |
| Verify mode (replay → outcome) | `housekeeper/modes/verify.ts` | ✓ |
| Auto-demote (verifier + prod paths) | `prisma-skill-store.ts:181, 340` | extend |
| Discover mode (bot → auto-promote) | `housekeeper/modes/discover.ts` | ✓ |
| Demand candidate sourcing | `/admin/discovery-candidates` (≥3 demand, no active skill) | extend |
| Wall classifier (demand damper) | `harvest-candidates.ts` (`wall_ratio`, `WALL_DOMINANCE_THRESHOLD=0.5`) | promote to shared |
| Notifiers (per-event) | `housekeeper/notifier.ts` + telegram/github | extend to digest |
| Orchestrator loop (12h / `--once`) | `housekeeper/orchestrator.ts` | extend to chain |
| Demotion webhook EMITTER | registry → `TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL` | unused (see Not-in-scope) |

## Decisions (locked)

- **D1 — Scheduled chained pass.** One orchestrator run, on the existing loop
  (systemd timer on the headless box), does verify→discover in sequence:
  verify demotes rotting skills; discover immediately re-skills the
  freshly-demoted + demand candidates. One per-run digest notification. No new
  long-running service. (Rejected: event-driven webhook listener — needs an
  always-on HTTP service + deploy/auth for seconds-faster reaction the sole-
  operator cadence doesn't need.)

- **D2 — Classify failures, bounded retry, quarantine.** Anchor the demote
  counter on FIXABLE ROT only:
  - `wall` (captcha/anti-bot) → quarantine the service (stop re-verifying,
    route to manual pile), do NOT count toward demote.
  - `transient` (timeout, inbox-empty, interstitial, network) → do NOT count,
    retry with backoff next sweep.
  - `infra` (`verification_not_sent`, inbox/email-delivery failures, alias
    domain issues) → do NOT count toward demote; route to an **infra alert**,
    NOT the per-service manual pile. The skill did its job; the inbox did not.
    **Proven dominant in the field: the 2026-06-02 harvest of 75 services hit
    `verification_not_sent` on 71 of them** — a systemic email-delivery
    problem, not 71 stale skills. If this bucket defaulted to `rot`, one bad
    inbox would demote the entire registry. This is the single most important
    classification call.
  - `rot` (selector/extract/validator failures) → counts toward the 3-strike
    demote. **Unknown kinds default to `transient` (no-count), NOT `rot`** —
    erring toward not-demoting, because a false demote costs a 6-min bot
    rediscovery while a missed demote just waits one more sweep.
  - After a rot-demote, discover gets ≤N attempts (backoff) then quarantines
    with a reason. The chain never gets stuck on an unfixable service.

- **D3 — Reason on skill + unified rollup.** Persist `demotion_reason`
  (fills the `void reason` TODO) + a `quarantined` distinction on the skill
  row. Reuse the per-service bot-failure aggregation for walled-never-skilled
  services. Add ONE read-side rollup — `GET /admin/needs-human` /
  `mcp skill list --needs-human` — that unions demoted-with-reason skills +
  wall-quarantined services into an operator worklist
  (`[service, reason, last_attempt_at, capture_ref]`). **Non-destructive:
  never hard-delete a quarantined service — keep the skill row + capture
  sidecar so it can be fixed from where the bot left off.**

- **D4 — Canonical taxonomy in the shared package.** Define WALL / TRANSIENT /
  ROT kind sets + `classifyFailure(kind)` ONCE in
  `@trusty-squire/skill-schema` (the cross-boundary contract both registry and
  mcp already depend on). Three consumers import it: the registry demotion
  classifier (new), the registry demand damper (dedup of `harvest-candidates`
  + `provision-event-store` wall sets), and mcp `signup-telemetry` (dedup).
  Kills the existing 2-copy wall-kind drift and prevents a third.

## The loop (data flow)

```
                       systemd timer (12h)  /  --mode=heal --once
                                    │
                                    ▼
        ┌──────────────────── runOneBatch (chained) ────────────────────┐
        │                                                               │
        │  1. VERIFY queue: replay active + freshness-due skills        │
        │        │                                                      │
        │        ├─ success ─────────────── reset counter, reschedule   │
        │        └─ failure → classifyFailure(kind):                    │
        │              WALL      → quarantine(svc, reason=wall)         │
        │                          (don't count; stop re-verifying)     │
        │              INFRA     → infra alert (verification_not_sent,   │
        │                          inbox/delivery); DON'T count          │
        │              TRANSIENT → don't count; backoff, retry next     │
        │              (unknown) → treated as TRANSIENT (don't count)   │
        │              ROT       → consecutive_rot_failures++           │
        │                          ≥3 → demote(reason=rot) ── persist ──┤
        │                                                               │
        │  2. DISCOVER queue (sourced from):                            │
        │        • freshly-demoted(rot) services  ← NEW handoff         │
        │        • ≥3-demand no-skill services    (existing)            │
        │        • EXCLUDES wall-quarantined      (existing damper)     │
        │        │                                                      │
        │        ├─ bot ok → auto-promote → (next pass re-verify        │
        │        │            confirms the fresh skill)                 │
        │        └─ bot fail/wall, ≤N attempts exhausted →              │
        │                     quarantine(svc, reason=gaveup|wall)       │
        │                                                               │
        │  3. DIGEST (one notification):                                │
        │     "verified 12 · demoted 2 (render, neon) · re-skilled 1 ·  │
        │      needs human: neon (verification_not_sent)"               │
        └───────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
            GET /admin/needs-human  /  mcp skill list --needs-human
            → durable worklist [service, reason, last_attempt, capture_ref]
              (operator targets these manually; reactivate path resets state)
```

## Failure modes (each new codepath)

| Codepath | Realistic failure | Test? | Error-handled? | Operator sees? |
|---|---|---|---|---|
| `classifyFailure` | novel failure_kind string | unit (defaults to `rot`) | yes (default branch) | n/a |
| verifier counter (rot) | transient mislabeled as rot → false demote | regression | mitigated by classifier | digest shows demote+reason |
| demote→candidate handoff | demoted svc never re-queued | unit | n/a | digest "demoted, queued" |
| bounded rediscovery | bot loops forever on a wall | unit (≤N cap) | yes (give-up) | digest "needs human" |
| needs-human rollup | union double-counts a svc | unit (dedup by service) | yes | worklist |
| digest notifier | notifier throws → batch fails | unit | yes (swallow+log, existing fanOut) | log line |

**Critical-gap check:** none. Every new path has a test AND error handling AND
a surfaced signal (digest or worklist) — no silent failures.

## NOT in scope (explicitly deferred)

- **Event-driven webhook listener.** The registry already emits on
  `TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL`; a listener would react in seconds vs
  the sweep cadence. Deferred — the scheduled pass meets the sole-operator
  need without standing up an always-on service. Revisit if demotion latency
  becomes a real complaint.
- **Mutable "mark resolved" worklist.** The needs-human rollup is read-only;
  resolution happens via the existing reactivate/approve paths. A first-class
  `QuarantinedService` table with `resolved_at`/`resolution_note` was rejected
  as schema-heavy for one operator.
- **Auto-tuning thresholds from telemetry.** `DEMOTION_THRESHOLD`,
  rediscovery `N`, backoff windows stay constants for v1. Tune against real
  data after the loop runs.
- **Prod-path (non-verifier) demotion classifier.** This design classifies the
  *verifier* failure counter. The prod replay-failure counter
  (`consecutive_failures`) gets the same treatment in a fast-follow once the
  verifier path is validated, to avoid one PR touching both.

## Implementation Tasks

- [ ] **T1 (P1)** — `skill-schema` — add `failure-taxonomy.ts`:
  `WALL`/`INFRA`/`TRANSIENT`/`ROT` sets + `classifyFailure(kind)`; **unknown
  defaults to `transient` (no-count), NOT rot.** `verification_not_sent` +
  inbox/delivery kinds → `infra`. (Field-proven: 71/75 harvest failures were
  `verification_not_sent` — mis-bucketing this as rot would demote the whole
  registry on one bad inbox.)
  - Verify: unit test all buckets + unknown→transient default +
    `verification_not_sent`→infra. Export from package index.
- [ ] **T2 (P1)** — `registry` — dedup wall sets: `harvest-candidates.ts` +
  `provision-event-store.ts` import the shared taxonomy.
  - Verify: existing demand-damper tests stay green (byte/behavior-equivalent).
- [ ] **T3 (P1)** — `mcp` — `signup-telemetry.ts` imports the shared taxonomy;
  delete its local `WALL_FAILURE_KINDS`.
  - Verify: existing telemetry tests green.
- [ ] **T4 (P1, ★regression)** — `registry/prisma-skill-store.ts` +
  `skill-store-memory.ts` — `recordVerifierOutcome` classifies failure:
  wall→quarantine (no count), transient→no count, rot→count. Persist
  `demotion_reason` (new column + migration; mirror in-memory).
  - Verify: REGRESSION tests — transient×3 does NOT demote; wall×1 quarantines;
    rot×3 demotes with reason. Prior "any-fail counts" tests updated.
- [ ] **T5 (P1)** — `registry` — discovery-candidate sourcing: union
  freshly-demoted(rot) services; keep wall-quarantine exclusion.
  - Verify: unit — demote(rot)→eligible; quarantine(wall)→excluded.
- [ ] **T6 (P1)** — `registry` — `GET /admin/needs-human`: union
  demoted-with-reason skills + walled services from bot-failure aggregation;
  dedup by service; bearer/SSO auth.
  - Verify: unit — worklist shape, dedup, auth 401/200.
- [ ] **T7 (P1)** — `mcp/housekeeper` — chained pass: `--mode=heal` (or
  `--then-discover`) runs verify then discover in one `runOneBatch`; bounded
  rediscovery ≤N with backoff → quarantine; per-run digest notification
  (auto-healed vs needs-human split) via existing notifier fan-out.
  - Verify: unit — sequencing, per-task isolation, give-up cap, digest content.
- [ ] **T8 (P2)** — `mcp` — `mcp skill list --needs-human` CLI reads the
  rollup endpoint; sortable by last_attempt.
  - Verify: unit against a stubbed endpoint.
- [ ] **T9 (P2)** — ops — systemd timer unit for the heal pass on the headless
  box (12h); document in CLAUDE.md housekeeper section.
  - Verify: `systemctl --user list-timers` shows it; one manual `--once` run.

## Parallelization

```
Lane A (shared contract, must land first):
  T1 → T2 → T3   (skill-schema taxonomy, then dedup consumers)

Lane B (registry, after T1):  T4 → T5 → T6   (sequential, same store)
Lane C (mcp, after T1):       T7 → T8        (sequential, housekeeper)
Lane D (ops, after T7):       T9

Order: T1 first (everything imports it). Then B and C in parallel worktrees.
T9 last. Conflict flag: T2 and T6 both touch registry — same lane (B), sequential.
```
