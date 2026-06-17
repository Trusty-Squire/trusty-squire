# DESIGN — Housekeeper Memory Overhaul

Status: PROPOSAL (pre-eng-review). Author: 2026-06-17.

## Problem

A single housekeeper run's "memory" is smeared across **3 databases +
local files + hand-written prose**, and the three things you actually
need are each in the wrong place:

- **Outcome** is split across two DBs: `ProvisionEvent` (registry) and
  `CaptchaEvent` (API).
- **Evidence** — the per-round DOM/inventory/observed chain that actually
  cracks bugs (`~/.trusty-squire/corpus/onboarding/*.json`) — is
  **local-only on the heal box and reaped**. groq's in-modal Turnstile was
  cracked (2026-06-17) only because that local capture happened to still be
  on disk.
- **Diagnosis** lives only in `STATE.md`, hand-written, linked to nothing,
  goes stale.

There is **no single per-service record of "status + why + evidence +
history."** Reconstructing it is a 6-source hand-join every session — the
root of the "run out of context / re-derive false walls" failure mode.

### Current sinks (the fragmentation, mapped)

| Sink | DB / location | Holds |
|---|---|---|
| `ProvisionEvent` | registry DB | per-run outcome + step-trail blob |
| `HealRun` | registry DB | per-pass aggregate (OF#1/#3, fix grades) |
| verifier-outcome | registry DB | per-skill replay pass/fail → demotion |
| `Skill` | registry DB | promoted recipe |
| `CaptchaEvent` | **API DB** | captcha kind/variant/blocked/stealth |
| `LLMUsageEvent` | API DB | cost |
| corpus chain | **heal-box local files** | per-round DOM/inventory (reaped) |
| pacing / spent / fix-ledger / unknown-state | heal-box local files | operational |
| digest | Telegram / GH issue / journal | ephemeral summary |
| `STATE.md` | hand-written file | the ONLY diagnosis record |

## Locked decisions (product review + eng review, 2026-06-17)

1. **Home of record = the registry DB.** It already owns cross-user
   institutional memory (skills, verifier outcomes). One trust boundary,
   one backup target.
2. **Evidence centralization = upload-on-failure (+ sample successes).**
   Durable where it matters, bounded cost.
3. **SCOPE = reframe, not greenfield (eng review).** The registry already
   has `ProvisionEvent` (a reserved `artifacts_uri`!), `ExtractFailureSnapshot`
   (upload-on-failure html+screenshot, 7-day retention), `SkillCaptureRecord`
   (per-round chain on success), `SkillReplayRecord` (replay outcomes),
   `UniversalBotFailureRecord` (per-service failure aggregation), and an
   on-read compat-score. The overhaul EXTENDS these and adds only the two
   genuinely-missing things (materialized `ServiceState`, `OpenIssue` ledger)
   — NOT four new tables. See "What already exists" below.
4. **Captcha fold = partial (eng review).** `CaptchaEvent` (API DB,
   correlated with machine-token egress reputation, no live read-route)
   stays API-side for the reputation work; `ProvisionEvent` gains the
   captcha SUMMARY (kind/variant/blocked) as columns. No cross-app client
   rewrite.
5. **ServiceState writer = registry-on-insert + heal-for-diagnosis (eng
   review).** The registry updates status/confidence/last_green in the same
   path that records each run (always fresh); the heal pass owns the slower
   `current_diagnosis`/wall fields. `compat-score.ts` becomes the updater,
   NOT a parallel on-read derivation — one source of truth.
6. **Failure evidence = full round chain on EVERY failure kind (eng
   review).** Today only extract-failures snapshot and only successes get a
   centralized chain; `oauth_onboarding_failed`/`needs_login`/`captcha_blocked`
   upload nothing (the groq case, cracked only because a local file survived).
   On any terminal failure, upload the full per-round chain + final snapshot,
   keyed by `provision_id`, 7-day retention.
7. **Close-gate = server-side enforced (eng review).** The `resolved`
   (requires a green run) and `wall` (requires a falsification pointer)
   constraints are enforced in the registry route, NOT just the CLI — else
   the loop can bypass them.

## What already exists (reuse, do not rebuild)

| Need | Existing table | Gap to close |
|---|---|---|
| L0 event log | `ProvisionEvent` (schema:307) — status, failure_kind, signup_url, provision_id, step_trail, costs, `artifacts_uri` reserved | add `mode` (discover/verify/replay) + captcha summary columns |
| L1 evidence | `ExtractFailureSnapshot` (232) html_gzip+screenshot+7d; `SkillCaptureRecord` (146) per-round chain | fire chain capture on ALL failure kinds, not just extract/success |
| L2 status | on-read `compat-score.ts` + `services-health.ts` | materialize as `ServiceState`; compat-score becomes the updater |
| L2 failure agg | `UniversalBotFailureRecord` (200) per-(service,kind) | feeds `OpenIssue` generation; no lifecycle today |
| L3 ledger | — | genuinely new: `OpenIssue` + server-side close-gate |

## Design principles

1. **One firehose, one source of truth per question.** Events append;
   status is derived; nothing is hand-maintained.
2. **Evidence is a first-class durable artifact**, not a local side-effect.
3. **Diagnosis is machine-written with an evidence gate** — you cannot mark
   a service a "wall" without a falsification pointer.
4. **One read surface** answers "what's the deal with service X" and
   "what's open" in a single call.

## The model — extend two tables, add two (all in the registry DB)

### L0 · event log — EXTEND `ProvisionEvent` (do not rebuild)

`ProvisionEvent` (schema:307) already is the per-run firehose. Extend it;
do NOT rename to `ProvisionRun` (it is the hot compat-score input — rename
is risk for zero gain). `SkillReplayRecord` stays as replay-outcome detail;
`ProvisionEvent.mode=replay` is the firehose view.

```
ProvisionEvent {                       // EXISTING — additions marked +
  id, service, status, failure_kind, signup_url,
  initial_strategy, final_strategy, replay_outcome, final_outcome,
  provision_id, step_trail, llm_cost, captcha_cost, duration_ms,
  account_id, mcp_version, occurred_at,
  artifacts_uri      // EXISTING (reserved) → now the evidence pointer
+ mode               // discover | verify | replay
+ captcha_kind       // partial captcha fold — SUMMARY only (decision 4)
+ captcha_variant
+ captcha_blocked
}
```

### L1 · evidence — GENERALIZE the existing failure-snapshot path

`ExtractFailureSnapshot` (232) already does upload-on-failure (`html_gzip`
+ `screenshot_jpeg` + 7-day `expires_at` + `provision_id`);
`SkillCaptureRecord` (146) already stores the per-round chain on success.
The gap: **non-extract failures upload no chain.** Close it (decision 6):

- On ANY terminal failure, upload the full per-round chain (reuse the
  `SkillCaptureRecord` shape, keyed by `provision_id`) + the final snapshot.
- Keep the 7-day retention sweep already in place.
- `ProvisionEvent.artifacts_uri` points at the bundle.

No new table; an uploader-wiring + retention change. **Highest-leverage
piece** — the DOM that explains a failure stops being local-and-reaped.

### L2 · `ServiceState` — canonical per-service status (mutable, one row/service)

```
ServiceState {
  service            string PK
  status             enum servable | blocked | wall | unservable | unknown
  confidence         float   Beta posterior over recent ProvisionRuns (reuse D2)
  current_diagnosis  json?   { failure_kind, hypothesis, evidence_ref }
  last_green_run     string? → ProvisionRun.run_id
  attempt_count      int
  of_role            json?   which objective this service serves
  updated_at         ts
}
```

**Maintained by the heal pass from L0 — never hand-written.** `STATE.md`
becomes a generated projection of this table (the falsified-hypothesis
narrative can live as a `notes` blob keyed off the diagnosis).

### L3 · `OpenIssue` — drainable work queue (the ledger)

One ticket per (service, failure_kind) while `status != servable`.

```
OpenIssue {
  id               string PK   service:failure_kind
  service          string
  failure_kind     string
  status           enum open | in_progress | resolved | wall
  first_seen       ts
  attempts         int
  resolved_run     string?  REQUIRED to set status=resolved (a green run)
  falsified        json?    REQUIRED to set status=wall { experiment, result, evidence_ref }
  updated_at       ts
}
```

Regenerated / merged each heal from `ServiceState`. **Close-gate enforced
SERVER-SIDE** (decision 7): the registry route refuses `resolved` without
`resolved_run` and `wall` without `falsified` — the CLI is a client, not
the guard. Loop surface: one ticket per iteration, resumable across context
resets. Generation seeds from `UniversalBotFailureRecord` (existing
per-service failure aggregation).

### Cross-cutting · one read API

- `GET /service/:slug/dossier` → `ServiceState` + last N `ProvisionEvent` +
  `OpenIssue` + evidence links. Replaces the 6-source hand-join.
- `GET /issues?status=open` → the loop's worklist.

## What changes (consolidation — reframed)

| Today | Becomes |
|---|---|
| `ProvisionEvent` (registry) | EXTENDED (+mode, +captcha summary); kept, not renamed |
| `CaptchaEvent` (API) | stays API-side; summary copied to ProvisionEvent (partial fold) |
| `SkillReplayRecord` | stays — replay-outcome detail; `mode=replay` is the firehose view |
| `ExtractFailureSnapshot` + `SkillCaptureRecord` | generalized: full chain on EVERY failure kind |
| on-read `compat-score.ts` | becomes the writer of materialized `ServiceState` |
| `UniversalBotFailureRecord` | seeds `OpenIssue` generation |
| STATE.md (hand-written) | generated view of `ServiceState` |
| fix-ledger, unknown-state-store | subsumed by `OpenIssue` / `ServiceState` |

## Phased rollout (each phase non-breaking, shippable alone)

1. **Extend `ProvisionEvent`** (+mode, +captcha summary columns; all
   nullable/defaulted → `db push` non-destructive). Backfill not required —
   new columns default. Unifies the firehose with no rename risk.
2. **Generalize the failure-snapshot path** to upload the full per-round
   chain on every failure kind + retention. Biggest immediate payoff;
   independent of everything else.
3. **Materialize `ServiceState`** — `compat-score.ts` becomes the on-insert
   updater; heal writes diagnosis; `dossier` endpoint; generate STATE.md.
4. **`OpenIssue` + server-side close-gate + loop wiring.** The drainable
   queue.

Rollout ambition (recommended): **phases 1-2 first** — they are the
highest-value, lowest-risk half (firehose unified + durable failure
evidence), and 3-4 follow once those land.

## Honest tradeoffs / risks

- **Storage cost + a heal-box→registry upload path** for L1 (failures-only
  bounds it).
- **Registry becomes the single institutional-memory dependency** —
  correct, but concentrates risk; needs backup discipline (already a
  documented concern for the vault master key; same posture).
- **Migration is real work** — dual-write windows, backfill, reader
  cutover; staged so nothing breaks mid-flight.
- **L2/L3 rot if the heal pass stops maintaining them** — same failure mode
  that let STATE.md go stale. The close-gate-in-code is the guard; without
  the heal wiring being load-bearing they're just more silos.
- **`failure_kind` taxonomy stability** — L2/L3 key off it; if the
  classifier churns its labels, tickets fragment. May need a stable
  coarse-bucket layer over the fine classifier.

## Test requirements (eng review — mandatory, not deferred)

- **Close-gate (critical):** registry route REFUSES `resolved` without a
  `resolved_run` and `wall` without `falsified`. Both the reject and the
  accept paths. This is the integrity guard of the whole ledger.
- **ServiceState materialization:** on-insert update produces the right
  status/last_green transitions (failed→blocked, a green run→servable +
  stamps last_green).
- **Failure-chain upload fires on ALL failure kinds** (oauth/needs_login/
  captcha/onboarding), not just extract — the regression the groq case
  exposed.
- **STATE.md generation** is a pure projection of ServiceState (snapshot
  test).

## Still-open questions (carried)

1. Object store for the failure bundles: today `ExtractFailureSnapshot`
   uses Postgres `Bytes` (bytea) with 7-day retention — keep that (simple,
   already wired, bounded by failure rate) or move to an S3-class bucket if
   volume grows? Recommend: keep bytea until retention sweep shows growth.
2. Does `ServiceState.confidence` read the housekeeper's Beta-posterior
   (D2, MCP-side, `fresh-verify.ts`) or recompute registry-side from
   ProvisionEvent? They are different layers; recommend registry recomputes
   its own from the firehose (avoids an MCP→registry coupling on read).

## Hardening from the outside voice (Codex)

- **Discover-mode upload wiring (P0, verified).** The upload primitive
  (`POST /v1/extract-failures`, single snapshot) only fires on the *extract*
  failure path; the round *chain* uploads only on *success*
  (`/skills/:id/captures`). Phase 2 MUST wire the bot's terminal-failure
  path to upload the chain for ALL failure kinds — else "full chain on every
  failure" is aspirational. This is the load-bearing Phase-2 task.
- **Seed `OpenIssue` from `ProvisionEvent` failures, not
  `UniversalBotFailureRecord`.** UBF isn't populated on every failure path;
  seeding from the firehose avoids silent "all clear" windows.
- **`ServiceState` = split projection + overlay** (decision, this review):
  status/confidence/last_green are a projection over `ProvisionEvent`;
  diagnosis/wall-class/human overrides are a thin mutable row.
- **`ServiceState` updates need per-service dedup + tie-break** (a later
  green run after a blocking run in the same batch must win) and a one-time
  backfill job on rollout (else transient "unknown").
- **Evidence redaction before persist** (decision, this review): scrub
  cf-turnstile tokens, `Authorization`/cookie headers, `sk-`/`ghp_`/`eyJ`
  key shapes, and password-field values from DOM/JSON before upload; flag
  any minted-key frame. Keep 7-day retention.
- **`artifacts_uri` needs a typed contract** — `{type, layout, version}`,
  not a bare string, or it becomes unqueryable.
- **Close-gate needs an actor + optimistic concurrency.** `in_progress` /
  `wall` / `resolved` transitions carry `actor` + a version check, so
  parallel loop workers (we run concurrency≥2) can't stomp each other or
  null an in-flight falsification.
- **Dossier endpoint needs paging + caps + ACL** — bound the
  ProvisionEvent/snapshot/issue joins.

## Resolved (this review)

Scope reframe (extend, not greenfield) · partial captcha fold ·
ServiceState = projection + mutable overlay · registry-on-insert for the
derived fields · full-chain-on-every-failure evidence · redaction before
persist · server-side close-gate w/ actor+OCC · seed OpenIssue from the
firehose · phases 1-2 first.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | Scope halved (reframe); 6 decisions locked; 8 outside-voice items folded |
| Outside Voice | Codex | Independent 2nd opinion | 1 | issues_found | 10 findings; 1 cross-model tension (matview) resolved; PII gap surfaced |

- **CODEX:** 10 findings — 8 folded as plan requirements, 2 routed to AskUserQuestion (matview tension → split projection+overlay; PII → redaction-before-persist).
- **CROSS-MODEL:** Agreement on reuse-over-rebuild and on the evidence gap being the highest-value piece. Tension only on ServiceState shape (mutable table vs projection) → resolved to a split.
- **VERDICT:** ENG CLEARED — design reframed to extend existing tables (~2 new vs 4), all decisions resolved, ready to implement phases 1-2.

NO UNRESOLVED DECISIONS
