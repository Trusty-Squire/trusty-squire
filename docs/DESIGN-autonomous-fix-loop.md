# DESIGN — Autonomous fix loop (live extraction is the oracle)

Status: PROPOSAL (eng-reviewed). 2026-06-17.
Supersedes the eval-corpus-as-oracle draft (the corpus was the weak premise;
see "Why the corpus was demoted").

## Thesis

Signup-bot debugging is high-volume, well-bounded, mechanical drudgery — the
ideal target for an autonomous loop with **zero human review**. The blocker has
always been: what's the trustworthy quality bar if no human looks?

**The oracle is the live extraction.** The real test is unfakeable: did the
signup produce an API key that works against the live API? A key works or it
doesn't — you cannot spoof it, overfit it, or mislabel it. That is the commit
gate. Everything else is plumbing in service of iterating *fast enough* to use
that oracle.

## Why the corpus was demoted

An offline eval corpus (replay the planner against a captured DOM) is a *proxy*
for live success. Every classic autonomous-loop failure — evaluator spoofing,
self-generated-label poisoning, holdout leakage, silent model-collapse — exists
*only because a proxy stands in for the real thing*. Gate on the real
extraction and they all dissolve:

- Spoof the evaluator? You can't fake a working key.
- Labels lie? The label IS "the key worked" — real.
- Silent collapse (all-green offline while live degrades)? Impossible — the
  gate is the live metric.

So the corpus keeps **one** job, and it is not being the oracle: **speed.** A
live signup is ~5 min + browser + robot + quota slot; an offline replay is ~1s.
You can't iterate a code fix against a 5-min test hundreds of times; you can
against a 1s replay. The corpus is a **fast iteration filter** — propose a fix,
check offline in 1s whether it even moves the stuck page, re-propose — so that
when you finally spend a live run, the candidate is plausible. It is **never the
commit gate.**

## Two clocks

- **Fast clock** — offline replay (`eval-page`, ~1s, no browser): the *fix
  iteration* engine. Propose → replay against the cluster's captured DOM → does
  the planner now pick the observed-good step? Re-propose up to K. Cheap.
- **Slow clock** — live discover (~5 min, real browser + extraction): the
  *oracle*. The offline-green candidate is run LIVE against the cluster's
  services + a held-out canary. Commit only on live keys.

The fast clock filters; the slow clock decides.

## The loop

```
  DRAIN (live, N-wide) ── captures + outcomes ──▶ ledger (drain-on-green)
        │                                                │
        ▼  cluster OPEN tickets                          │ retry-variance
  ROUTE (pure):                                          │ from recent events
    flaky (low determinism) ──▶ leave to DRAIN (retry, no fix)
    DNS-dead / curated wall ──▶ AUTO-WALL (mechanical)
    deterministic + in-fence ──▶ FIX ↓
    deterministic + out-of-fence ──▶ CAPABILITY-GAP (evidence, no fix)
        │
  ┌─────▼──────────── FAST CLOCK (offline, ~1s/attempt) ───────────────┐
  │ propose generalizing fix (path-fenced: post-OAuth nav planner only) │
  │ → eval-page replay over the cluster's captured stuck pages          │
  │ → re-propose until the pages move offline, or K=3 → PARK            │
  └─────┬───────────────────────────────────────────────────────────────┘
        │ offline-green candidate
  ┌─────▼──────────── SLOW CLOCK (live — THE ORACLE) ──────────────────┐
  │ run the cluster's services LIVE + a held-out CANARY set LIVE.       │
  │ COMMIT to `next` IFF:                                                │
  │   • ≥M targeted services now extract a WORKING key, AND             │
  │   • the canary's live success rate did NOT drop (no silent          │
  │     regression of untargeted services), AND                         │
  │   • staging-only + path-fence + green-only (existing fix-agent).    │
  │ else → revert the candidate, re-propose or PARK.                    │
  └─────┬───────────────────────────────────────────────────────────────┘
        │ committed → rebuild dist
        ▼
  loop until a full cycle commits nothing (convergence)
```

## Components

### A. Router (NEW — pure, composes existing signals)
Cluster open ledger tickets by `(coarse_failure_kind, failure_stage)`. Classify:
- **flaky** — recent ProvisionEvents for the service show retry-variance (it has
  flipped green) → leave to DRAIN.
- **DNS-dead / curated `needs-manual`** → AUTO-WALL with the DNS/curation
  evidence (mechanical).
- **deterministic AND in the fix-agent's allowed-path fence** (post-OAuth nav
  class) → FIX.
- **deterministic but out-of-fence** (`bot_crash` elsewhere, email, session) →
  CAPABILITY-GAP: surface with evidence, no autonomous fix (the agent's eval
  doesn't cover it; widening the fence is a deliberate, separate step per class).

Signals exist: `failure-stage.ts`, the ledger's coarse-kind keys, a DNS lookup,
retry-variance from `listByService`.

### B. Live gate (NEW — the oracle)
Given an offline-green candidate + a cluster's services + a fixed held-out
canary set: run all live (reuse the drain's concurrent discover), assert
≥M targeted services extract a working key and the canary rate holds. This
replaces the fix-agent's *commit* gate (the offline eval becomes the inner
iteration filter only).

### C. Canary (NEW — small, fixed, held-out)
A fixed set of services the fix never targets, run live every commit-cycle.
Their real success rate is the independent ground-truth signal that catches a
generalizing edit regressing untargeted services. Held out by SERVICE (the fix
sees none of their pages), pinned by content hash (reproducible, not reshuffled).

### D. Orchestrator (NEW — thin, modeled on `--mode=heal`)
`mcp housekeeper autoloop`: DRAIN → ROUTE → for the top FIX cluster run the
fast-clock iteration then the live gate → loop to convergence. `--mode=heal`
already chains verify→discover→digest; this is the same shape.

### Reused (built, unchanged)
- `eval-page.ts` — offline planner replay (fast-clock filter).
- `build-corpus.ts` — derive offline fixtures from captures (success→accept,
  failure→reject, redacted). Feeds the fast-clock filter only.
- `fix-agent.ts` / `modes/fix.ts` — cluster → generalizing fix → path-fence +
  staging-only + green-only + K=3 park. The COMMIT gate swaps offline→live.
- The ledger — drain-on-green, auto-wall, coarse-kind clustering, supersede.

## Safety — why this is sane unattended

| Risk | Defense |
|---|---|
| Evaluator spoofing | the gate is a live working key — unspoofable |
| Self-generated label poisoning | labels feed only the fast-clock FILTER, never the commit; the commit is live |
| Holdout overfit | the canary is held out BY SERVICE (fix sees none of its pages) + live |
| Silent model collapse | the live canary is an independent real-world signal decoupled from the corpus |
| Generalizing edit regresses other services | the canary catches it; path-fence bounds the edit surface |
| Reckless blast radius | path-fence (post-OAuth nav only) + staging-only + green-only-commit (existing) |
| Flaky → noise-chasing | only deterministic (low retry-variance, recurring) failures route to FIX |
| Out-of-fence clusters | routed to CAPABILITY-GAP, never fixed by an agent whose eval can't see them |
| Cost exhaustion | convergence = a cycle that commits nothing; live gate bounded to cluster + canary, not the whole queue |

The convergence residual is not "needs a human" — it is **capability-gaps**
(an SMS gate needs a phone faculty; an out-of-fence class needs eval coverage
added deliberately). Those surface with evidence: a roadmap input, not a review
queue.

## Implementation plan (phases, each shippable)

1. **Router** — pure cluster classification (flaky / DNS-dead / in-fence-det /
   out-of-fence) over the ledger's open tickets, with the retry-variance + DNS +
   stage signals. Auto-wall the dead; emit capability-gaps.
2. **Live gate + canary** — swap the fix-agent's commit gate from offline to
   live: run cluster + held-out canary via the concurrent discover, assert
   ≥M working keys + canary holds. Keep `eval-page` as the inner fast filter.
3. **Orchestrator** (`autoloop`) — chain DRAIN → ROUTE → fast-iterate → live-gate
   → loop-to-convergence, modeled on `--mode=heal`.
4. **Auto-run `build-corpus`** post-discover so the fast-clock filter stays
   current (optional speed; the gate never depends on it).

## Resolved starting values (eng-review)

1. `M = 2` — a generalizing fix must move ≥2 distinct services live (anti-
   overfit, beyond the canary). Canary delta: commit only if canary live rate
   ≥ its pre-fix rate (no drop).
2. Canary = ~4 known-good services spanning categories (e.g. ipinfo, openrouter,
   a DB, an analytics one), pinned by content hash; refreshed when one rots.
3. Live gate reuses the drain's pool but with a reserved concurrency slice so a
   gate run can't starve the drain.
4. Keep `eval-page` as the **inner fast-filter** (1s, saves live runs, NEVER the
   gate). Reversible — if it ever earns its keep poorly, drop the corpus and
   iterate purely live (one-line change; the gate is already live).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | Scope reframed (~80% built); oracle moved from corpus → live extraction; 4 decisions locked |
| Outside Voice | Codex | Independent 2nd opinion | 1 | issues_found | 11 findings; the headline (silent model-collapse) drove the live-oracle redesign |

- **CODEX:** 11 findings, all rooted in "the corpus is a gameable proxy." Rather than patch each (spoofing/poisoning/holdout/collapse), the user's cut dissolved them: **gate on live extraction, demote the corpus to a fast pre-filter.** The live canary remains as the independent real-world signal.
- **CROSS-MODEL:** Codex and the section review agreed the autonomous loop is ~80% built (eval-page, build-corpus, fix-agent, path-fence, K-park) and that the unattended-safety crux is an independent real-world check. The redesign makes the *real-world check the gate itself*, which is strictly stronger than any corpus hardening.
- **Step-0 reframe:** reuse-and-extend (not 4 new components) — router + live-gate/canary + thin orchestrator + auto-run build-corpus.
- **VERDICT:** ENG CLEARED — design reframed to live-extraction-as-oracle; the path-fence + staging-only + green-only + live-canary make unattended fixing safe; ready to implement the router (Phase 1).

NO UNRESOLVED DECISIONS
