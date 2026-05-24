# DESIGN — Harvester Subagent

**Status:** draft, eng-reviewed 2026-05-24
**Owner:** Lunchbox / Bento
**Last updated:** 2026-05-24

## Goal

Run the universal signup bot 24/7 against the top SaaS services to:
1. Surface bugs in the bot before real users hit them.
2. Build up the skill registry so new clients land with a populated set of capabilities, not a cold registry.

## Non-goals

- Hands-free code changes. Subagent proposes; human reviews + merges.
- Cloudflare-protected sites without real-GPU rendering. Routed separately (Phase 5).
- Replacing the existing harvester. This layers on top of it.
- Sub-second latency. This is a slow background process; minutes-to-hours latency is fine.
- Replacing the universal bot's planner or skill-promoter. Subagent only fixes things AROUND them.

## What already exists (reused, not rebuilt)

| Sub-problem | Existing infra | Status |
|---|---|---|
| Queue + cooldown | `tools/harvester/run.mjs` + systemd timer | Reused; quota + budget added in Phase 1 |
| Per-service GitHub issues | wired in run.mjs | Reused; dedup added in Phase 1 |
| Auto-promote on success | rc.14+ | Reused; quarantine flag added in Phase 2 |
| Circuit-breaker (halt sentinel) | wired | Reused; replaced with per-service backoff in Phase 2 |
| Bot failure status codes | `captcha_blocked`, `payment_required`, … | Reused as classifier input |
| Filesystem state | `~/.trusty-squire/` | Reused; new dir `~/.trusty-squire/halts/` for failure-reports |
| systemd timer pattern | `tools/harvester/systemd/` | Mirrored for subagent unit |
| GitHub CLI access | `gh` on PATH | Reused via subagent allowlisted Bash |
| npm release pipeline | `release.yml` auto-publishes staging | Reused unchanged; harvester pulls `@next` dist-tag |

## Recommended architecture

**Two processes, sharing state via the filesystem.**

```
┌──────────────────────────────┐      ┌────────────────────────────────┐
│  HARVESTER (existing)         │      │  SUBAGENT (new)                │
│  systemd timer / 10 min       │      │  systemd timer / 5 min         │
│  single-shot, exits           │      │  shell prefilter → claude -p   │
│                               │      │                                │
│  ┌─────────────────────────┐  │      │  ┌──────────────────────────┐  │
│  │ pick next service       │  │      │  │ halt sentinel exists? ───┼─┐│
│  │ run universal bot       │  │      │  │   no  → exit 0           │ ││
│  │ on failure:             │  │      │  │   yes → spawn claude     │ ││
│  │   write halts/<ts>.json │◄─┼──────┼──┼──── reads ───────────────┘ ││
│  │   incr per-svc backoff  │  │      │  │ ingest failure-report      ││
│  │ on success: auto-promote│  │      │  │ classify (rule → LLM)      ││
│  │   to registry           │  │      │  │ if code_bug: propose fix   ││
│  └─────────────────────────┘  │      │  │ open draft PR (cap 3)      ││
│        │                      │      │  │ log to state/runs.jsonl    ││
│        │ writes               │      │  │ on success: clear halt     ││
│        ▼                      │      │  └──────────────────────────┘ │
│  ~/.trusty-squire/            │      │                                │
│    halts/<ts>-<svc>.json      │      │  PreToolUse hook gates:        │
│    backoff-state.json         │      │   - Edit/Write → state/+proposals/ only │
│    halted (sentinel)          │      │   - Bash → allowlist patterns  │
└──────────────────────────────┘      └────────────────────────────────┘
                                                    │
                                                    │ Telegram POST on
                                                    │ daily digest + crash alerts
                                                    ▼
                                         @lunchboxfortwo
```

### Harvester (existing — extend, don't replace)
- `tools/harvester/run.mjs`, single-shot, fired by systemd timer every 10 min.
- Picks next pending service from `services.yaml`, runs one signup, updates per-service GitHub issue, exits.
- **Pulls `@trusty-squire/mcp@next` dynamically** (drops `HARVESTER_MCP_VERSION` env pin). Each run resolves to the latest staging-rc; the resolved version goes into the failure-report so we keep reproducibility despite the dynamic tag.
- **Per-service backoff** (not just global halt): each service has its own `consecutive_failures` counter in `~/.trusty-squire/backoff-state.json`. After 3 consecutive failures the service is paused for 24h. Global halt sentinel fires only on SYSTEMIC failures (budget exceeded, all services failing, etc.).
- **Quota + budget enforced in-process** (added Phase 1):
  - Per-service: max 1 attempt per 24h (look human-scale to upstream).
  - Per-day: stop all runs when total LLM spend exceeds `HARVESTER_DAILY_BUDGET_USD` (default $5).
  - GH-issue de-dup: lookup existing `(service, classification)` issue before opening new one.
- **Failure-report writer**: on every halt-eligible failure (3rd consecutive on a service OR systemic), writes `~/.trusty-squire/halts/<ts>-<service>.json` (schema below) and sets the global halt sentinel if systemic.
- **Auto-promote** posts captured skills to the registry as `status: pending-review` (not `active`) — human flips to active after quarantine review. Quarantine catches skills that encode credentials, brittle selectors, paid-account assumptions.

### Subagent (new — `tools/harvester-subagent/`)

- **Claude Code in headless mode**, spawned by a systemd timer every 5 min via a **5-line shell prefilter** that exits 0 if no halt sentinel — saves ~288 no-op Claude invocations/day:

  ```bash
  #!/bin/bash
  [ -f ~/.trusty-squire/harvester-halted ] || exit 0
  exec claude -p --max-turns 30 "<dispatch-prompt>"
  ```

- **Tight permission model via PreToolUse hook** in `.claude/settings.json`:
  - **Edit/Write** allowed ONLY for paths under `tools/harvester-subagent/state/`, `tools/harvester-subagent/proposals/`, `.pr-staging/`.
  - **Bash** allowed ONLY for explicit command patterns: `gh pr create/view/comment/list`, `git status/log/diff/show` (read-only git), specific `node tools/harvester-subagent/...` invocations, `curl https://registry.npmjs.org/...`.
  - Everything else (sed/awk/tee/apply_patch/`git push`/`git commit` outside the PR flow) rejected with a clear error.
  - This is enforced by a hook script at `tools/harvester-subagent/preflight-hook.sh` that inspects each tool call.

- **Dispatch prompt** (per invocation): "Read `tools/harvester-subagent/state/*`. Halt sentinel is present; load the latest `~/.trusty-squire/halts/<ts>-<service>.json` (single structured failure-report — DO NOT scrape logs/screenshots/GH-issue trail directly). Classify the failure. If `code_bug`, produce a fix proposal. Open a draft PR (max 3 open) or update an existing one. Log outcome to `state/runs.jsonl`. On any side-effect failure, fire a Telegram alert via the digest helper."

- **Failure-report.json schema** (this is the ONLY data the subagent ingests for the failed run):
  ```json
  {
    "ts": "2026-05-24T17:21:33Z",
    "service": "railway",
    "signup_url": "https://railway.com/login",
    "mcp_version_resolved": "0.6.14-rc.33",
    "bot_status": "captcha_blocked",
    "error_message": "turnstile challenge did not resolve",
    "classification": "environment",
    "consecutive_failures": 3,
    "recent_attempts": [
      { "ts": "...", "status": "...", "step_trail": [...], "duration_s": 142 }
    ],
    "debug_artifacts": [
      "/home/lunchbox/proj-ts/.debug/1779643741117-captcha-after-timeout.png"
    ],
    "captured_planner_output": "...",
    "github_issue_url": "https://github.com/Trusty-Squire/trusty-squire/issues/16"
  }
  ```
  The subagent loads images only when the failure type warrants it (selector / captcha forensics); text-heavy failures stay text-only to keep context budget bounded.

- **For `code_bug`-classified failures only**: opens a **draft** PR against `staging`, prefixed `[harvester-subagent]`. PR description includes: failure-report excerpt, proposed diff, base SHA, expected test command, link to the rejected-fixes history.
- **State tracked in `tools/harvester-subagent/state/`** (gitignored): `open-prs.json`, `rejected-fixes.json`, `last-seen-rc.txt`, `telegram-chat-id.txt`, `runs.jsonl` (append-only audit log).
- **Resumes the harvester** (clears halt sentinel) when a new `@next` rc is published since the halt timestamp AND at least one of the subagent's open PRs has merged. Recorded in `last-seen-rc.txt` to detect "new publish."

### Identity
PAT under the user's own GitHub account (`Lunchbox / lunchboxfortwo`), stored as `GH_TOKEN` in the systemd unit's env file (mode 0600). Scopes: `repo` for PR-create + read. Simpler than a dedicated GitHub App; user accepts that subagent commits and PR comments appear as authored by them. **Trade-off:** PAT is broader than ideal (codex flagged this); a fine-grained PAT or App migration is a TODO once Phase 4 stabilizes.

### Why Claude Code over the Anthropic SDK directly
- Uses the user's Claude Max subscription credits instead of per-token API spend.
- Tool ecosystem (Bash, Read, Edit, Write, `gh` CLI, project context via CodeGraph + CLAUDE.md) is already wired — no reimplementation.
- Headless mode (`claude -p`) is explicitly supported for automation.
- Spawning subagents (Explore, general-purpose) for failure classification comes for free.

### Constraints introduced by the choice
- Permission allowlist + PreToolUse hook for Edit/Write/Bash (not `--dangerously-skip-permissions`).
- Subscription-quota cap: max 5 fix-proposal invocations per day before back-off. Subagent burning the user's Max quota is a real failure mode.
- Per-invocation startup cost (~5-15s context init) gated by the prefilter — paid only on real halts.

### Why two processes, not one
| | Harvester | Subagent |
|---|---|---|
| Cadence | every 10 min | event-driven (on halt, gated by shell prefilter) |
| Cost / invocation | ~$0.0006 (Gemini Flash) | $0.50–$5 (Claude) |
| Failure mode | expected, normal | should page (Telegram alert) |
| Output | GitHub issues, failure-reports, draft skills | draft PRs, runs.jsonl |
| Reliability | tolerate single-run failures | crash-loud (every side-effect wrapped + alerted) |

Conflating them gives both jobs worse defaults.

## Review ownership

- **All subagent PRs**: just the user. Daily triage.
- **Draft mode is mandatory.** Subagent never opens ready-for-review PRs. User promotes manually.
- **Cap: 3 open subagent PRs at once.** New proposals block until at least one is reviewed.
- **Auto-merge: never.** `release.yml` ships every staging push to npm.
- **Merge gates beyond drafts** (Phase 4): before user can promote a subagent PR to ready-for-review, CI must pass: targeted unit tests, harvester fixture eval (small set of "known good replays" still pass), pack/publish smoke (npm pack the tarball, verify install). Rollback path: every rc has a previous rc; revert via `git revert` on staging is the documented path.
- **Rejected fixes go in `state/rejected-fixes.json`.** Subagent reads this before proposing.
- **Human review bottleneck is explicit.** If user falls behind triage, the 3-PR cap throttles new proposals naturally. Subagent never "helps" by closing your draft PRs.

## Phased rollout

### Phase 1 — observation WITH guardrails (week 1)
- Hand-curate `services.yaml`: 13 → 50 services.
- **Add safety guardrails** (in run.mjs in-place edits): per-service 24h quota, daily $5 LLM budget cap, GH-issue dedup.
- **Switch harvester to `@trusty-squire/mcp@next`** (drop env pin).
- Add daily digest: `tools/harvester/daily-digest.mjs` → Telegram bot to @lunchboxfortwo.
- Run harvester 24/7. systemd unit + timer already exist; just enable.
- **No subagent yet.** Goal: see what failure patterns actually show up at 50-service scale with guardrails on.
- **State module**: extract `tools/harvester/state.mjs` (atomic JSON read/write, lockfile) — both harvester and subagent will use it later.

### Phase 2 — classify the noise + per-service backoff (week 2)
- **Per-service backoff**: replace global "halt after 3 consecutive failures" with per-service counter; only systemic conditions (budget exceeded, all services failing) set the global halt sentinel.
- Per-failure classification in `tools/harvester/classify.mjs`:
  - Rule-based first (table below); LLM-classify only when rules abstain (cap: 10/day).
- **failure-report.json writer** in run.mjs (the structured contract subagent will consume in Phase 3).
- **Skill quarantine**: auto-promoted skills land as `pending-review`, not active. Human flips to active after spot-checking.
- **Eval-fixture collection starts**: every halt's failure-report is archived into `tools/harvester-subagent/eval/fixtures/` so Phase 3's eval suite has real data to grade against.

  | Bot status | Classification |
  |---|---|
  | `captcha_blocked` / `anti_bot_blocked` / HTTP 5xx | `environment` |
  | `payment_required` / `phone_verification` / `sms_required` | `external_block` |
  | `verification_not_sent` | `environment` (re-eval if persists >7d) |
  | `selector_not_found` / planner errors / `extraction_failed` | `code_bug` (with caveat — see classifier notes) |
  | skill replay `step_failed` | `upstream_change` |
  | generic timeout, no specific signal | **LLM-classify** |

  *Classifier note (codex caveat):* `selector_not_found` is not always a bug — it can also be UI drift, auth-wall changes, anti-bot, or planner nondeterminism. The classifier flags it as `code_bug` but the subagent's first job is to verify via fresh-capture before proposing a fix. Repeated failure DOESN'T prove code bug.

### Phase 3 — subagent dry-run + eval suite (week 3-4)
- Build `tools/harvester-subagent/` (run.sh prefilter, ingest.mjs, propose.mjs, github.mjs, state.mjs, prompts/, eval/, systemd/).
- PreToolUse hook script (Edit/Write path scoping + Bash allowlist).
- Subagent emits proposals to **disk only** — `tools/harvester-subagent/proposals/<date>/<failure-signature>.md` with: failure-report excerpt, proposed diff, base SHA, evidence, rationale.
- **Eval suite built IN PARALLEL with prompt iteration**: ~10 curated failure-report.json fixtures from Phase 2 archive + reference "good" diffs. Each prompt-tweak runs the eval; quality bar is "≥70% reference-diff match."
- Human eyeballs proposals daily; opens PRs manually from any that look right. Frontmatter tracks `status: pending | accepted | rejected | edited`.
- Goal: validate prompt + classification + Bash-hook + Edit-hook before letting subagent touch GitHub.

### Phase 4 — subagent lite, real PRs (week 5+)
- Promote dry-run proposals into real draft PRs.
- Cap of 3 open subagent PRs enforced.
- Rejected-fix memory active.
- Auto-resume harvester after `@next` advances + ≥1 subagent PR landed.
- **Promotion gate to this phase**: ≥70% of Phase 3 dry-run proposals manually accepted by user as-is over 4 weeks. Eval suite agrees with user judgment ≥80% of the time.
- **Crash handling live**: every side-effect wrapped in try/catch; outcome logged to `state/runs.jsonl`; any failure fires a Telegram alert (deduped by `component+failure_sig+service+stage` key).

### Phase 5 — scale to 200, multi-machine (when Phase 4 is stable)
- Expand `services.yaml` to 200 (source pool: Product Hunt API, "awesome-saas" lists, Indie Hackers tools directory).
- Route Cloudflare-protected services to a separate Mac-based harvester (real GPU, real Chrome fingerprint).
- **Central queue coordination** via the registry API (not FS state — codex was right that two boxes can't share `state/*.json`). Add a `/harvester/lease` endpoint: each box leases a service, runs it, releases lease on completion. Halts coordinated centrally.

## File layout

```
tools/
├── harvester/                            (existing, extended Phase 1+2)
│   ├── run.mjs                           (in-place edits: @next, quota, budget, dedup, backoff, failure-report writer)
│   ├── services.yaml                     (expand 13 → 50 → 200)
│   ├── classify.mjs                      (NEW Phase 2 — rule-based + LLM-fallback)
│   ├── state.mjs                         (NEW Phase 1 — atomic JSON IO; shared with subagent)
│   ├── daily-digest.mjs                  (NEW Phase 1 — Telegram POST)
│   ├── daily.mjs                         (existing)
│   └── systemd/
│       ├── harvester.service
│       └── harvester.timer
└── harvester-subagent/                   (NEW Phase 3)
    ├── README.md
    ├── run.sh                            (shell prefilter — only spawns claude on halt)
    ├── ingest.mjs                        (loads halt failure-report.json + referenced .debug PNGs)
    ├── propose.mjs                       (claude prompt construction + invocation)
    ├── github.mjs                        (gh PR create/view/comment via allowlisted Bash)
    ├── preflight-hook.sh                 (PreToolUse hook: Edit/Write path scope + Bash allowlist)
    ├── prompts/
    │   ├── classify-failure.md
    │   └── propose-fix.md
    ├── eval/                             (NEW Phase 3 — curated fixtures + reference diffs)
    │   ├── fixtures/<failure>.json
    │   └── references/<failure>.diff
    ├── proposals/<date>/                 (NEW Phase 3 — dry-run output)
    ├── state/                            (gitignored)
    │   ├── open-prs.json
    │   ├── rejected-fixes.json
    │   ├── runs.jsonl                    (append-only audit log)
    │   ├── last-seen-rc.txt
    │   └── telegram-chat-id.txt
    ├── settings.json                     (Claude Code permission allowlist + PreToolUse hook reference)
    └── systemd/
        ├── harvester-subagent.service
        └── harvester-subagent.timer
~/.trusty-squire/                          (runtime state — NOT in repo)
├── halts/<ts>-<service>.json             (NEW Phase 2 — failure-report contract)
├── backoff-state.json                    (NEW Phase 2 — per-service consecutive_failures)
└── harvester-halted                      (existing — global systemic halt only)
docs/
└── DESIGN-harvester-subagent.md          (this doc)
```

## Test plan (per phase)

| Phase | What's testable | How |
|---|---|---|
| 1 | state.mjs atomic IO; quota logic; budget cap; GH-issue dedup; Telegram digest format | Unit (vitest), fixture-based |
| 2 | classify.mjs rule table; per-service backoff state machine; failure-report.json schema (zod validate against samples) | Unit + schema snapshot |
| 3 | PreToolUse hook (path scope + Bash allowlist) — table tests of allowed/denied; ingest.mjs against sample reports; **propose-fix eval suite** (10 fixtures, reference diffs); state.mjs crash recovery | Unit + eval (real Claude call, ~$2/run) |
| 4 | github.mjs against throwaway test repo; end-to-end "halt → PR opened → merged → resumed" integration; merge-gate check | Integration |
| 5 | Central queue lease endpoint; multi-box coordination; failover when one box is offline | Integration |

**The propose-fix eval is the load-bearing test.** Without it, the Phase 3→4 "≥70% acceptance" promotion gate is vibes-based. Built alongside the first prompt iteration, not after.

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Upstream account-flag from too-frequent signups | high | 1-per-24h per-service quota; long pauses on flagged services; per-service backoff isolates flaky targets |
| Legal/ToS exposure from automated account creation across 50-200 SaaS | medium | Explicit acceptance: this is a research/dogfooding tool, not production-scale fraud. Alias prefixes + per-service caps + acceptance of upstream's decision to ban any individual signup. No retry on bans. TODO: per-service ToS audit checklist. |
| Email-alias namespace bloat / login lifecycle | high | `harvester.{slug}.{date}@…` prefix; alias deletion tied to ACCOUNT lifecycle (not pure 30d hygiene) — only delete when the underlying SaaS account is known-defunct or the skill is demoted. Bulk-prune only `pending` aliases that never claimed an account. |
| LLM cost runaway | medium | Daily $ cap with hard halt; per-fix-proposal cost cap; per-invocation subscription-quota cap (5 fix-proposals/day) |
| Subagent proposes garbage fixes | high in early phases | Dry-run Phase 3 + eval suite; drafts + human review every time; rejected-fix memory |
| CI publish breakage from bad fix | medium | Drafts don't trigger publish; merge gates beyond drafts (Phase 4); rollback via `git revert` |
| Subagent halts forever waiting for fix-rc | low | Timeout on "waiting for rc" (default 7d) → Telegram alert |
| Subagent crashes silently | low | Every side-effect wrapped + structured outcome to runs.jsonl + Telegram alert with dedup key |
| Repo gets spammed with stale subagent PRs | medium | 3-PR cap; subagent auto-closes own PRs when stale (>14d unmerged) |
| Auto-promoted skills encode credentials / brittle assumptions | medium | Phase 2 skill quarantine (pending-review default; human review before active) |
| Per-service flake stalls whole harvester | high before Phase 2 | Per-service backoff (Phase 2); global halt only on systemic conditions |
| Bash escape hatch defeats Edit/Write scoping | high if not addressed | PreToolUse hook covers BOTH Edit/Write paths AND Bash command patterns (Phase 3) |
| Multi-machine state split-brain | medium (Phase 5+) | Central queue lease via registry API; not FS state |
| Subagent's data ingest format drifts with harvester changes | medium | Structured failure-report.json contract is the boundary; harvester log format changes don't reach subagent |

## NOT in scope (explicit defers)

- **Dedicated GitHub App identity** — accepted PAT trade-off for Phase 1-4; revisit before Phase 5.
- **Hands-free auto-merge of subagent PRs** — never.
- **Multi-tenancy** — this subagent serves one operator account; multi-tenant fan-out is a different design.
- **Real-time alerting** beyond Telegram (PagerDuty, Slack, SMS) — daily digest + crash alerts are the SLA.
- **Web dashboard for subagent state** — `state/*.json` + GitHub PR list + Telegram digest is the UI.
- **Automated rollback of bad fixes** — manual `git revert` is acceptable at this volume.
- **Cross-machine state coordination** before Phase 5 — single-box is fine until we add the Mac.
- **Replacing the universal bot's planner** — out of scope; subagent only fixes things around it.
- **Per-service ToS audit checklist** — TODO, captured as a follow-up; not blocking Phase 1.

## Strategic note (codex called this out)

The subagent's value depends entirely on structured failure-reports + deterministic harvester logs + safe skill quarantine being in place FIRST. Without Phase 1+2 work, the subagent in Phase 3 would be reading scattered data and proposing fixes on incomplete info — automating guesswork. Phasing is non-negotiable: don't start Phase 3 before Phase 2 is solid.

## Open questions (revisit during implementation)

- **Subagent prompt template for `propose-fix.md`** — initial draft + eval-driven iteration in Phase 3.
- **Telegram digest format** — plain text vs structured (one msg per category). TBD.
- **Subagent crash recursion** — what if dispatch crashes consistently? systemd `Restart=on-failure`; if it crashes 3× in 24h, set its OWN halt sentinel and digest-alert.
- **Cost-cap interaction with Max subscription** — subscription credits aren't dollars. 5-invocations cap is a proxy; refine after Phase 3 measures real usage.
- **Per-service ToS policy** — needs first-pass before scaling above 50 services.

## Decision log

- 2026-05-24 — Initial draft. Two systemd processes sharing FS state. Drafts-only PRs, capped at 3.
- 2026-05-24 — **Subagent = Claude Code headless**, not Anthropic SDK. Uses Max subscription credits; tools already wired. PreToolUse hook + 5/day fix-proposal cap.
- 2026-05-24 — **GitHub identity = PAT under user's own account.** Trade-off accepted; App migration is a Phase 5 TODO.
- 2026-05-24 — **Daily digest = Telegram bot**, recipient @lunchboxfortwo.
- 2026-05-24 — **(eng-review D2/D9)** PreToolUse hook scopes BOTH Edit/Write file paths AND Bash command patterns. Bash defaults to deny; specific commands explicitly allowed.
- 2026-05-24 — **(eng-review D3)** Harvester pulls `@next` dist-tag dynamically; `mcp_version_resolved` written into failure-report.json for reproducibility. Subagent clears halt sentinel when new rc publishes AND one of its PRs landed.
- 2026-05-24 — **(eng-review D4)** Structured `~/.trusty-squire/halts/<ts>-<service>.json` failure-report is the sole ingest contract between harvester and subagent. Schema defined above. Subagent does NOT scrape logs/issue trails directly.
- 2026-05-24 — **(eng-review D5)** 5-line shell prefilter as systemd target. Claude only spawns when halt sentinel exists (~288 no-op invocations/day saved).
- 2026-05-24 — **(eng-review D6)** Every subagent side-effect wrapped in try/catch; structured outcome to `state/runs.jsonl`; Telegram alert on any failure (dedup key = component+failure_sig+service+stage).
- 2026-05-24 — **(eng-review D7)** Propose-fix eval suite built IN PARALLEL with Phase 3 prompt iteration. ~10 curated fixtures from Phase 2 archive + reference diffs. Phase 3→4 promotion gate measurable.
- 2026-05-24 — **(eng-review D10)** Quota + $ budget + GH-issue dedup move from Phase 2 → Phase 1 (before 24/7 runs at 50-service scale).
- 2026-05-24 — **(codex fold-ins)** Per-service backoff (not global halt). Skill quarantine on auto-promote. Email alias lifecycle tied to account state. systemd hardening checklist. Telegram dedup key. Merge gates beyond drafts. Multi-machine via central registry coordination. Legal/ToS risk row added. Human-review bottleneck explicit.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | outside-voice | Independent 2nd opinion | 1 | issues_found | 20 items raised; 7 folded as decisions, 9 as gap fold-ins, 4 as TODOs/deferrals |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 10 decisions resolved (D1-D10); architecture / code-quality / tests / perf reviewed |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not applicable (backend/infra plan) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not applicable |

- **CODEX:** 20 items raised; substantive tensions on D2 (Bash hardening), D3 (reproducibility), D10 (phase ordering) all resolved into doc updates. Strategic concern ("subagent may be wrong first move") addressed by hard-gating Phase 3 on Phase 2 completion.
- **CROSS-MODEL:** Eng review and codex both agree the design is shippable AS REVISED. Single biggest disagreement on D7 (eval timing) folded as clarification rather than redesign.
- **UNRESOLVED:** 0 unresolved decisions.
- **VERDICT:** ENG + OUTSIDE-VOICE CLEARED — ready to implement Phase 1.
