# DESIGN — ProvisionEvent + Dashboard Panel 2 + Demand-Weighted Harvesting

Status: planned (eng-review locked 2026-05-31)
Scope: first slice — unify the dispatch telemetry event, surface
cache-hit + demand on the existing `/admin` dashboard, and close ONE
loop (demand-weighted harvesting with a captcha-wall damper).

## Problem

The operator cannot compute **cache-hit rate** (how often a provision
is served from a learned-skill replay vs. the slow universal bot)
because the two dispatch paths land in different stores with no shared
tag:

- **Replay** outcomes → `postReplayOutcome` → skill counters +
  auto-demote. No per-request row.
- **Bot** outcomes → `ProvisionAttempt` store (bot-only).

The registry also only ever sees *failures*
(`UniversalBotFailureRecord`) plus replay *counters* — never total
per-service **demand**. So "which services do developers actually want"
is invisible, and the harvester can't be pointed at demand.

```
TODAY (two blind pipelines)
  router(provision)
    ├── tryReplayLearnedSkill ──> postReplayOutcome ──> skill counters ─┐
    │                                                    (auto-demote)  │  cache-hit
    └── bot.signup ───────────> recordProvisionAttempt ─> attempt store ┘  UNCOMPUTABLE
                                                          (failures only)  (no shared tag)
```

## What already exists (reuse, do not rebuild)

| Element | File |
|---|---|
| Bearer-gated read-only operator dashboard, `GET /admin`, 6 HTML sections | `apps/registry/src/routes/admin-dashboard.ts` |
| `ProvisionAttempt` store (bot-only: service/status/failure_kind/signup_url/provision_id/step_trail/account_id/mcp_version) + `listRecentFailures` | `apps/registry/src/provision-attempt-store.ts` (+ prisma variant) |
| `POST /v1/services/:slug/attempts` sink + `GET .../health` | `apps/registry/src/routes/services-health.ts` |
| Failure-driven discovery candidates (≥3 distinct failures, excludes active-skill services) | `apps/registry/src/bot-failure-store*.ts` |
| Auto-demotion on 3 consecutive replay failures | skill store + `postReplayOutcome` |
| `toReplayOutcomeBody` centralized outcome mapper (precedent for `toProvisionEvent`) | `apps/mcp/src/tools/provision-any.ts:420` |
| Hourly best-effort pruner (currently sweeps extract-failures only) | `apps/registry/src/server.ts:178` |

The dashboard "registry-as-home" question is **already the status quo**
— `/admin` is the home. Panel 2 is a new section on it, not a new app.
The open-source `@trusty-squire/mcp` package stays emit-only.

## Locked decisions (eng-review)

1. **Dual-sink, single emit point.** `postReplayOutcome` is untouched
   (stays the auto-demote actuator). A new `ProvisionEvent` is emitted
   from **one** site at the router boundary — observation-only,
   fire-and-forget, fail-open, never gates a signup. Replay rows are
   double-recorded (counter + event) by design.
   - **Source-of-truth rule:** `postReplayOutcome` counters = demote
     truth; `ProvisionEvent` = dashboard truth. They intentionally do
     NOT reconcile (the event also counts bot + no-skill paths the
     counters never see).
2. **Rename** `ProvisionAttempt` → `ProvisionEvent` (store + Prisma
   model + route field + tests) — the model changed, so rename over
   coexistence per house convention.
3. **Nullable cost fields; drop `is_first_for_account` AND `asn_class`
   from v1.** `llm_cost`/`captcha_cost` nullable; replay rows carry
   `0` (known-zero). `asn_class` dropped — `browser.proxied` is a
   boolean, not an ASN class (would be junk); revisit when a real ASN
   source exists. `is_first_for_account` derived server-side later
   (funnel concern, deferred).
4. **Demand loop = two complementary signals, one queue.** Keep the
   failure-driven `listDiscoveryCandidates` ("users hit walls here").
   ADD a demand-ranked query over `ProvisionEvent` ("lots of users want
   this, no skill yet"). The discover queue consumes both, dedupes by
   service, applies the wall damper to both.
5. **Wire backward-compat at the sink.** Strategy fields are OPTIONAL
   on `POST .../attempts`; absent → blind default to `bot` (old
   installed MCPs only ever posted bot attempts). Version-gated
   provenance is a deferred TODO.
6. **Damper fail-toward-harvest.** `isWallFailure(kind)` matches an
   allowlist `{captcha_blocked, anti_bot_blocked, captcha}`; unknown
   kinds count as NOT a wall, so a novel-string service stays
   eligible. Each wasted harvest surfaces the new wall kind.
7. **Full router test with fake deps** for dispatch resolution + the
   one-event invariant + fail-open; pure-fn unit tests for
   `isWallFailure`, `toProvisionEvent`, cache-hit aggregation; rename
   regression tests stay green.
8. **Count in the database.** Cache-hit + demand are windowed Postgres
   `GROUP BY` queries (the pattern `listDiscoveryCandidates` already
   uses), + indexes on `occurred_at`, `(service, occurred_at)`. App
   only formats.
9. **Retention DEFERRED** (left unbounded for now). Known risk: the
   table grows one row per provision with no sweep — see TODO.
10. **Event model = strategy + outcome subfields** (supersedes a single
    `dispatch` enum). One row per provision, fields:
    `initial_strategy (replay|bot)`, `final_strategy (replay|bot)`,
    `replay_outcome (ok|miss|na)`, `final_outcome (ok|failed|blocked)`.
    Makes the cache-hit denominator unambiguous and records *why*
    replay missed.
11. **Idempotency = upsert on `provision_id`** (unique constraint;
    duplicate post overwrites). Fire-and-forget retries can't inflate
    demand or skew cache-hit.
12. **Legacy fill = blind default to bot** (version-gating → TODO).

## Target architecture

```
router(provision)  [apps/mcp/src/tools/provision-any.ts]
  outcome = tryReplayLearnedSkill()        // postReplayOutcome stays (per-branch)
            ?? bot.signup()                // recordProvisionAttempt MOVES out
  // exactly ONE emit, at the boundary, fail-open:
  void registry.recordProvisionEvent(toProvisionEvent({
     service, provision_id,                 // upsert key
     initial_strategy, final_strategy,      // replay|bot
     replay_outcome, final_outcome,         // ok|miss|na / ok|failed|blocked
     failure_kind?, skill_id?,
     llm_cost?, captcha_cost?, duration_ms,
     mcp_version,
  }))

POST /v1/services/:slug/attempts  [services-health.ts]  (widened, upsert on provision_id)
        │
        ▼
ProvisionEvent store (renamed) ──┬──> Panel 2: cache-hit 3-way + demand   (GROUP BY)
                                 └──> listDemandCandidates(volume, !active) ─┐
UniversalBotFailureRecord ──────────> listDiscoveryCandidates (walls) ──────┤
                                                                            ▼
                                                  discover queue (dedupe by service,
                                                  wall damper) ──> housekeeper harvest
                                                                       │
                                                                       ▼
                                                  new skill ──> replay served ──> cache-hit ↑
                                                  (CLOSED LOOP)
```

Cache-hit denominator (unambiguous after Decision 10):
- **served-by-replay** = `final_strategy=replay AND final_outcome=ok`
- **fell-back** = `initial_strategy=replay AND final_strategy=bot`
- **no-skill-bot** = `initial_strategy=bot`

Wall damper (Decision 6 + concrete spec): over a 14-day window,
down-weight (exclude from demand candidates) a service when
`>50%` of its recent failures are wall-kinds per `isWallFailure`.
No decay in v1.

## Failure modes (new codepaths)

| Codepath | Realistic prod failure | Test? | Error handling | Visible? |
|---|---|---|---|---|
| Router single emit | registry down/500/timeout | ✅ fail-open test | fire-and-forget `void`, swallow | silent (intended — never blocks signup) |
| Sink upsert | duplicate `provision_id` from retry | ✅ idempotency test | `onConflict` overwrite | n/a |
| `isWallFailure` | novel wall-kind string not in allowlist | ✅ unit | unknown→not-wall | one wasted harvest run logs the new kind |
| Panel 2 GROUP BY | table grows unbounded (Decision 9) | — | windowed query bounds *read*, not *write* | **slow dashboard / disk later** ← deferred risk |
| Demand vs discovery active-skill exclusion drift | two queues use different "active" definition | ✅ assert shared exclusion set | shared helper | queues disagree |

**No critical gaps** (silent + no-test + no-handling): the fail-open
emit is silent by design and *is* tested. The retention risk is a
known, accepted deferral, not a silent gap.

## Implementation Tasks
Synthesized from this review. Sequenced per Codex: schema+emit →
dashboard → harvesting (so numbers can be sanity-checked before the
loop actuates).

- [ ] **T1 (P1, human: ~1d / CC: ~25min)** — registry — Rename `ProvisionAttempt`→`ProvisionEvent`; add `initial_strategy/final_strategy/replay_outcome/final_outcome`, nullable `llm_cost/captcha_cost`, unique `provision_id`; Prisma migration + indexes `occurred_at`,`(service,occurred_at)`.
  - Surfaced by: Architecture (Decisions 2,3,10,11), Performance (8)
  - Files: `apps/registry/src/provision-attempt-store.ts`→`provision-event-store.ts`, `prisma-*`, `registry-prisma-client.ts`, `prisma/schema.prisma`
  - Verify: `pnpm -F @trusty-squire/registry test` (rename regression green)
- [ ] **T2 (P1, human: ~3h / CC: ~15min)** — registry — Widen `POST /v1/services/:slug/attempts`: optional strategy fields (blind-default bot), upsert on `provision_id`.
  - Surfaced by: Decisions 5,11,12
  - Files: `apps/registry/src/routes/services-health.ts`
  - Verify: sink tests (missing-field→bot, dispatch+costs stored, duplicate provision_id upserts)
- [ ] **T3 (P1, human: ~4h / CC: ~20min)** — mcp — Single boundary emit + `toProvisionEvent()` mapper; move bot-path `recordProvisionAttempt` (line ~867) to the boundary; resolve strategy/outcome across replay+bot.
  - Surfaced by: Architecture (Decision 1,10)
  - Files: `apps/mcp/src/tools/provision-any.ts`, `apps/mcp/src/skill-registry-client.ts`
  - Verify: full router test (3 dispatch outcomes + one-event invariant + fail-open)
- [ ] **T4 (P2, human: ~3h / CC: ~15min)** — mcp/registry — `isWallFailure()` + cache-hit 3-way aggregation (pure fns).
  - Surfaced by: Code quality (6), Test (7)
  - Verify: exhaustive unit tests
- [ ] **T5 (P2, human: ~1.5d / CC: ~40min)** — registry — Restyle ALL of `/admin` to DESIGN.md (dark, Geist + JetBrains Mono, hairline-ruled, indigo accent, ok/err/warn) AND add Panel 2: cache-hit 3-way segmented bar + demand distribution table via windowed GROUP BY. Empty-state + low-N caveat (N<50).
  - Surfaced by: Performance (8); Design review (all passes + restyle decision)
  - Files: `apps/registry/src/routes/admin-dashboard.ts` (CSS + all section renderers), store query methods
  - Verify: dashboard render test (with events, empty state, low-N caveat); visual check against the approved mockup
  - Reference: `~/.gstack/projects/Trusty-Squire-trusty-squire/designs/registry-admin-dashboard-20260531/admin-dashboard-mockup.html`
- [ ] **T6 (P2, human: ~5h / CC: ~25min)** — registry — `listDemandCandidates` over ProvisionEvent + discover queue consumes both sources, dedupe-by-service, wall damper (14d, >50% wall-kinds).
  - Surfaced by: Architecture (4), Code quality (6)
  - Files: `bot-failure-store*.ts` (or new `demand-store`), `housekeeper/queues/index.ts`
  - Verify: in-memory + prisma demand query tests; damper down-weights wall-dominated service; shared active-skill exclusion

## NOT in scope (deferred, with rationale)

- **Funnel cross-DB join** (npm downloads ↔ API-DB accounts ↔
  registry-DB first-success) — spans two Postgres DBs + an external
  source; the hardest single piece, no closed loop yet.
- **`failure_kind` taxonomy / enum migration** — the damper only needs
  a 3-string allowlist today; full normalization is its own change.
- **Replay-decay → re-harvest edge** on auto-demotion — second loop;
  ship the demand loop first.
- **`is_first_for_account` + `asn_class`** — funnel / no clean source.
- **ProvisionEvent retention sweep** — accepted growth risk for now
  (Decision 9).
- **Demand *value*-weighting** (popular-but-low-value services) — the
  wall damper covers "unsolvable"; value-weighting is future.
- **Cost/quota/abuse/verification/proxy loops** — later tiles.

## TODOs (deferred items worth tracking)

- ProvisionEvent retention: add `pruneOlderThan` + wire into the
  `server.ts:178` hourly pruner, env-tunable window (~90d). **Blocked
  by:** nothing; do before the table gets large.
- Version-gated legacy fill: when `mcp_version` ≥ event-release and
  strategy is absent, tag `legacy_unknown` + warn (catches modern
  client bugs Decision 12's blind-default would hide).
- Demand value-weighting beyond raw volume.
- (pre-existing flag) `bot-failure-store.pruneOlderThan` appears
  defined but not called from `server.ts:178` — verify it's wired.

## Parallelization

| Step | Modules | Depends on |
|---|---|---|
| T1 | registry store/prisma | — |
| T2 | registry routes | T1 |
| T3 | mcp router/client | T1 (event shape) |
| T4 | pure fns (mcp+registry) | — |
| T5 | registry dashboard | T1 |
| T6 | registry queues/store | T1 |

- **Lane A:** T1 → (T2, T5, T6 in parallel after T1) — all registry,
  share `provision-event-store` so sequential-after-T1.
- **Lane B:** T3 (mcp) — depends only on the T1 event *shape*; can
  start once the interface lands.
- **Lane C:** T4 (pure fns) — fully independent, start immediately.
- Conflict flag: T2/T5/T6 all touch the registry store + routes —
  same lane, sequential, not parallel worktrees.

## Design (operator dashboard — DESIGN.md-aligned)

Decision: `/admin` is **promoted into the design system** (previously a
plain light-table internal tool; DESIGN.md formerly scoped to `apps/web`
only). Approved direction (mockup at
`~/.gstack/projects/Trusty-Squire-trusty-squire/designs/registry-admin-dashboard-20260531/`):

- **Whole page restyled** to dark (`#08080A`), Geist (chrome) + JetBrains
  Mono (every count/%/slug/skill-id/timestamp), hairline-ruled sections
  (not cards), one indigo accent, `--ok`/`--err`/`--warn` for state.
- **Cache-hit = north star, top of page:** a flat hairline-segmented
  bar (no gradient) — replay-served (accent) / fell-back (muted) /
  no-skill-bot (raised) — plus big mono stat readouts (provisions,
  replay-served %, median durations). Text+% legend (not color-only).
- **Demand distribution:** hairline-ruled table, favicon tile + mono
  slug, mono right-aligned volume/share, `--ok` dot for has-skill,
  **amber `harvest candidate` tag** for high-demand-no-skill — the
  closed loop made visible on the page.
- **Hierarchy:** summary (cache-hit, demand) above operational sections
  (active / pending / freshness / discovery / demoted / failures).
- **Empty + low-N states:** zero events → warmth line, bar/table
  hidden (no broken 0/0 bar); `N<50` in window → bar greyed with a mono
  `low sample (N=…)` caveat so early noise isn't trusted.

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|---|---|---|---|
| Registry `/admin` (full page + Panel 2) | `~/.gstack/projects/Trusty-Squire-trusty-squire/designs/registry-admin-dashboard-20260531/admin-dashboard-mockup.html` | Dark, mono-forward, hairline-ruled, DESIGN.md tokens | Built from real tokens (image-gen was org-gated); openable in browser; doubles as T5 reference |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 20 raised; 3 adopted as tensions, rest baked/TODO |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 8 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open | 4/10 → 9/10; 5 decisions, restyle to DESIGN.md, mockup approved |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** independent review adopted 3 ways (strategy+outcome subfields, upsert idempotency, surfaced legacy-fill); corrected `asn_class` (dropped from v1); rest baked or deferred to TODO.
- **CROSS-MODEL:** Eng review + Codex agree the architecture is sound; the only structural change Codex forced was the event model (Decision 10) — accepted.
- **DESIGN:** `/admin` promoted into the design system; whole page restyled dark/mono-forward; cache-hit segmented bar + demand table with amber harvest-candidate cue; empty + low-N states specified. Mockup approved.
- **UNRESOLVED:** 0 unresolved decisions (12 eng + 5 design locked). 2 accepted deferred risks: ProvisionEvent retention (Decision 9), and cache-hit-over-time sparkline (design, deferred).
- **VERDICT:** ENG + DESIGN reviews complete, scope reduced to one slice. Plan ready to implement. No critical gaps.

