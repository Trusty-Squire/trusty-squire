# Skill harvester

Drives `provision_any_service` across a curated queue of dev SaaS,
promotes the resulting captures into replayable skills, reports
per-service progress to GitHub issues.

**Status**: Phase A only — `services.yaml` + a `--dry-run` planner.
Phase B (MCP invocation), Phase C (circuit breaker + daily summary),
and Phase D (systemd timer) are not yet implemented.

## Topology

- **Runs on**: chloro, as user `lunchbox`. Single-shot script invoked
  every 10 minutes by a systemd user timer (Phase D — not yet wired).
- **Chrome profile**: `~/.trusty-squire/chrome-profile-harvester/` —
  separate from your daily-driver profile. One-time setup: log into
  Google as methoxine@gmail.com inside that profile.
- **Trusty Squire account**: lunchboxfortwo's session.json. Captured
  credentials land in lunchboxfortwo's vault; the upstream Google
  identity at each SaaS is methoxine. Decoupled by design.
- **GitHub repo**: `Trusty-Squire/trusty-squire`. One issue per
  service, plus daily summary issues. Auth via the `gh` CLI's existing
  session.

## State model

State lives in two places — both intentional:

1. **services.yaml** (this repo, hand-edited) — which services exist,
   declared status (`pending` / `skip` / `hold`), per-service config
   (signup URL, OAuth provider, scope hint). Edited only by operators
   when adding/removing services or marking known-incompatible ones.

2. **GitHub issue labels** (per-service, mutated by the harvester) —
   runtime status of each service's attempts:
   - `status:running` — attempt in progress (set at start, cleared on
     exit). A `running` label outliving the runner means the script
     crashed mid-attempt; harvester treats this as retryable.
   - `status:replay-ok` — service is fully validated (skill promoted +
     replay reproduced the credential). Terminal; never re-attempted.
   - `status:promotion-only` — bot succeeded once and auto-promoted a
     skill, but the follow-up replay-validation step couldn't reproduce.
     Retryable.
   - `status:failed` — last attempt failed. Retryable; the next bot
     ship may have fixed whatever broke.
   - `status:needs-manual` — operator-set. Harvester never picks this
     service automatically. Use for services that need a fix we can't
     ship right away.

   No separate DB. Reading state means `gh issue list --label
   service:<slug>`.

## Per-service issue shape

Title is stable so the same issue is found on every attempt:

```
[skill-harvester] <slug> — <name>
```

Body is rewritten each attempt:

```markdown
**Status**: failed (attempt 3)
**Skill**: <skill_id or "none">
**Last attempt**: 2026-05-23T05:45:32Z (full mode, 30s, kind=ok, via=regex)
**Replays**: succeeded=1 / failed=0 / consecutive_failures=0

## Recent attempts

### Attempt 3 — 2026-05-23T05:45:32Z — FAILED
Outcome: step_failed at index 2 ("select", No select matches label_hint="Region")
Capture trail: …

### Attempt 2 — …
```

Labels: `skill-harvester`, `service:<slug>`, `status:<state>`,
`replay-validated` (once `replay-ok`).

## Daily summary

Created at 00:05 UTC, closed at 23:55 UTC. Title:
`[skill-harvester] daily 2026-05-23`. Body rebuilt from per-service
issue labels — no separate state. Useful as a single-link "what did
the harvester do today" view.

## Circuit breaker

Tracks the count of consecutive failed attempts across the WHOLE queue
(not per-service). State files in `~/.trusty-squire/`:

- `harvester-consecutive-failures` (integer) — incremented on each
  non-`replay-ok` outcome, reset to 0 on `replay-ok`.
- `harvester-halted` (sentinel) — created when the counter hits 3.
  Subsequent runs short-circuit + exit until an operator clears it.

When tripped, a single `[skill-harvester] HALTED` issue is created
(or commented) summarizing the last 3 failures so the operator can
triage in one place.

To resume: delete `harvester-halted` and `harvester-consecutive-failures`,
close the HALTED issue with a "resumed" comment.

## Operator commands

```bash
# Phase A — print what the harvester would do, change nothing.
node tools/harvester/run.mjs --dry-run

# Phase B (not yet implemented) — run one attempt now.
node tools/harvester/run.mjs --once

# Manually mark a service as needs-manual (skip future auto-attempts).
gh issue edit <num> --add-label status:needs-manual --remove-label status:failed
```

## One-time setup

Before Phase B can actually run:

```bash
# Install the harvester's deps (only js-yaml right now).
cd tools/harvester && pnpm install

# Seed the harvester's Chrome profile with methoxine's Google session.
# Drives a real visible browser; you complete the OAuth flow yourself.
sudo -u lunchbox env TRUSTY_SQUIRE_PROFILE_DIR=/home/lunchbox/.trusty-squire/chrome-profile-harvester \
  npx @trusty-squire/mcp@next login --provider=google

# Confirm the harvester pre-flight is green.
sudo -u lunchbox node tools/harvester/run.mjs --dry-run
```

## Why this layout

- **YAML, not JSON, for services**: hand-edited config, comments
  matter ("known broken because Cloudflare runs maximum Turnstile" is
  the kind of note that needs to live next to `status: skip`).
- **GitHub issues, not a separate dashboard**: the harvester needs a
  durable, human-browseable, comment-able record per service. Issues
  are free, every operator already has them open, and labels are a
  no-DB state store.
- **Single-shot script + external timer**: keeps the runner crash-safe
  (every 10 min the systemd timer re-attempts; a hung script gets
  killed by the next tick), avoids long-running state to manage, and
  makes the 10-min cooldown trivially observable.
- **Per-attempt fresh chrome profile copy** (Phase B): each attempt
  works on a snapshot of the harvester profile to avoid cross-attempt
  cookie pollution and reduce profile-corruption risk. The base
  profile (methoxine's Google session) is read-only after the
  one-time setup.
