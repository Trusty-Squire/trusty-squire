# Autonomous Self-Improving Provision Loop

The provision bot runs as a fully autonomous loop that **maximizes skills in the
registry** and **lifts the virgin-signup success rate** over time, surfacing to a
human **only** when it hits a DOM/outcome it has never classified. This doc defines
the loop, the provision state machine, the per-state retry policy, and the single
escalation condition. The promotion half (success → registry skill) is in
[`../AGENTS.md`](../AGENTS.md) → "Skill-Promotion Pipeline".

## Objective functions (what the loop optimizes for)

Two metrics define "better"; every run reports both and the dashboard trends
them (see `CLAUDE.md` → "Objective Functions"):

1. **OF#1 — skills in the registry** (active-skill count). Grown by
   discover→auto-promote.
2. **OF#2 — discovery success rate** the housekeeper sees
   (`discover_succeeded / discover_attempted` per pass).

**Where they surface:**
- **Digest** — each heal pass emits one `heal_digest` notifier event whose
  `objectives` field carries OF#1 (`skills_active`, returned by the registry
  at heartbeat time) + OF#2 (the pass's discover counts). The Telegram + log
  notifiers render them on a `📊 OBJECTIVES` line. Daily timer → ~1 digest/day.
- **Dashboard** — `GET /admin` → the **Objective functions** panel: the live
  skill count + latest discovery rate, plus a run-over-run trend table. Each
  `HealRun` row stamps `skills_active` / `discover_attempted` /
  `discover_succeeded` so the trend is real history, not a single point.
- **Daily engine** — the systemd timer runs `--mode=heal --once
  --from=tools/housekeeper-services.yaml --limit=100`: verify + a curated
  ~100-service discover sweep, daily (`tools/systemd/`).

## The loop

`mcp housekeeper --mode=heal` (`apps/mcp/src/housekeeper/orchestrator.ts`
`runHealLoop`) chains, on a daily systemd timer:

1. **verify** — replay active skills; demote/retire the rotten (see the failure
   taxonomy), keeping the registry honest.
2. **discover** — run a virgin provision against uncovered services; on success,
   auto-promote a new skill (AGENTS.md pipeline).
3. **digest** — one operational summary per pass (not an escalation).

Each provision outcome is classified into ONE named **ProvisionState**, and the
loop applies that state's **policy**. The whole point: every state except one is
handled autonomously.

## Provision state machine

`packages/skill-schema/src/provision-state.ts` — `classifyProvisionState(signals)`.
DOM-free: callers pass pre-computed signals (e.g. `already_signed_in` from
`detectAlreadySignedIn`, `awaiting_email` from `expectsVerificationEmail`, the
terminal `failure_kind`, `http_status`, `body_text`). Precedence:
`success > rate_limited > email_pending > (terminal kind) > authenticated > virgin`.

| State | Means | Entry signal |
|---|---|---|
| `success` | a usable credential was produced | credential present/validated |
| `virgin` | fresh signup form, no live session | default mid-flow read |
| `authenticated` | already-signed-in dashboard | `detectAlreadySignedIn` |
| `email_pending` | awaiting an emailed link/OTP | `email_otp_required` / awaiting-email page |
| `rate_limited` | service throttling | `rate_limited` kind / HTTP 429 / page text |
| `transient` | retryable oauth/nav/timeout/planner/blip | `KNOWN_TRANSIENT_KINDS` |
| `wall` | known-unrecoverable (captcha/anti-bot/phone/SMS/billing/SSO) | `WALL_STATE_KINDS` + taxonomy `wall` |
| `infra` | our-side inbox/email delivery failure | taxonomy `infra` |
| `rot` | replay-only skill staleness | taxonomy `rot` |
| **`unknown`** | matched NO classifier — a never-seen state | non-empty kind in no set |

`unknown` carries a stable **signature** (`unknownStateSignature`: url path +
sorted top-N element fingerprints) so repeats of the SAME novel state share an
attempt count and a DIFFERENT novel state is its own fresh count.

## Per-state retry policy

`packages/skill-schema/src/provision-policy.ts` — `PROVISION_POLICY`. The loop
consults this instead of ad-hoc bails. **Exactly one state has `surfaces: true`.**

| State | Action | Attempts | Surfaces? |
|---|---|---|---|
| `success` | promote (if virgin + uncovered) / record | 1 | no |
| `virgin` / `authenticated` | drive the flow | 1 | no |
| `email_pending` | poll inbox, then retry; else degrade to infra | 2 | no |
| `rate_limited` | exponential backoff + requeue (cap 30 min) | 3 | no |
| `transient` | retry | 3 | no |
| `wall` | mark unservable, log reason, skip | 1 | **no (auto-skip)** |
| `infra` | note in digest; never demote the skill | 1 | no |
| `rot` | advance the 3-strike demote counter | 3 | no |
| **`unknown`** | retry on same signature, then escalate | 3 | **yes — the only surface** |

## The single escalation condition

`unknown_state_detected` after `UNKNOWN_ESCALATION_THRESHOLD` (3) attempts on the
**same** `(service, signature)`:

- The orchestrator counts attempts in a persistent store
  (`apps/mcp/src/housekeeper/unknown-state-store.ts`) so the count survives the
  ~12h gap between passes.
- On the 3rd attempt it fires ONE `unknown_state` notifier event (telegram /
  github-issue / log) with the service, failure kind, attempt count, and trace —
  then marks it escalated so it never pings twice.
- **No other state ever fires this.** Walls auto-skip, transient/email/rate
  auto-retry, rot auto-demotes. That is the "no human except an unclassifiable
  state" guarantee, and it's asserted in tests (`provision-state.test.ts`:
  exactly one state surfaces; `unknown-state-store.test.ts`: escalate once at 3).

When you get an `unknown_state` ping: add a classifier branch in
`provision-state.ts` (or fix the bot) so the state becomes a known one — then the
loop handles it autonomously and the github issue auto-closes.

## Why this shape (vs the original "named flows in the skill schema" ask)

The four named states are **runtime** conditions, not skill-recipe variants:
`virgin`/`authenticated` is a runtime branch (`detectAlreadySignedIn`),
`email_pending`/`rate_limited` are transient failure states. Skills stay flat
single-flow recipes (the registry-maximizing artifact); the state machine + policy
own behavior. The only schema touch is an optional `entry_state` tag recording
which state a recipe was discovered in.

## Known follow-up

`rate_limited` is detected from an explicit kind or HTTP 429 today; the
body-text path (`RATE_LIMIT_TEXT_RE`) is wired in the classifier but the discover
layer does not yet feed the final page text in. Emitting a `rate_limited` failure
kind from the bot on a 429 closes that gap.
