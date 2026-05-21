# Skill Promoter — Design Doc

**Status:** Draft for review
**Owner:** TBD
**Target release:** 0.7.0
**Depends on:** 0.6.13 (universal bot fixes), existing `onboarding-capture.ts`, `registry-api`
**Supersedes:** the implicit "manual adapter authoring" assumption baked into `packages/adapters/`

---

## TL;DR

Today every `provision_any_service` run is amnesiac: the universal bot rediscovers
the signup URL, the OAuth provider, the post-verify navigation path, and the
credential selector from scratch every single time. We already capture each
successful run's full state-stream into `apps/mcp/corpus/onboarding/` via
`onboarding-capture.ts`, but that data sinks into a directory nobody reads.

This doc proposes the **Skill Promoter**: a one-way pipeline that ingests
captures from successful runs, synthesizes a structured Skill record, validates
it via a clean replay, and publishes it to `registry-api`. Subsequent
`provision_any_service` calls check the registry first and replay the skill in
~30 seconds instead of cold-pathing through the LLM planner for ~6 minutes.

The skill format is intentionally a strict subset of the adapter manifest, so
that a well-performing skill can be hand-promoted to an authored adapter without
rewriting the data model. This is the institutional-memory layer the codebase
has been quietly building toward — TODOS.md flags it; `corpus/onboarding/`
implies it; `eval-onboarding.ts` is half-built atop it.

---

## Quickstart

The happy path from "I want Railway to be fast" to "Railway is on Tier 2"
in five commands. Assumes 0.7.0 is installed; you have a running signup
to learn from; and the registry is reachable.

```bash
# 1. Enable capture before the original signup
export TRUSTY_SQUIRE_ONBOARDING_CAPTURE=~/.trusty-squire/corpus/onboarding

# 2. Run a signup (creates ~/.trusty-squire/corpus/onboarding/railway/<run-id>/)
#    Either via your agent (provision_any_service) or directly:
mcp call provision_any_service '{"service": "Railway"}'
# … signup completes, credential lands in vault, capture lands in corpus

# 3. Promote: synthesize → validate → dry-mode replay-test → publish
pnpm skill:promote railway
# → ✅ Skill published: railway@v1 (skill_id=01HZX9…, captures=3 rounds)
#    Replay-test: dry-pass (4 steps walked, no credential creation)

# 4. Verify the skill exists in the registry
pnpm skill:show railway
# → { service: "railway", version: "v1", status: "active",
#     steps: [...], credential: {...}, replays: { succeeded: 0, failed: 0 } }

# 5. Trigger another signup — this one uses the skill (~30s, not ~6min)
mcp call provision_any_service '{"service": "Railway"}'
# → router hits the registry, replay-skill walks the graph, credential extracted
```

**Time to first promoted skill:** ~5 minutes once you have a successful
capture.

**What "dry-pass" means in step 3:** the promoter walked every step's
text-match against the live page, confirmed each one resolved, but
stopped before clicking "Create Token". A real token is not created
during promote-time; only when a user (or agent) actually signs up.

**If the capture is incomplete or malformed:**
```bash
pnpm skill:promote railway
# → ❌ rejected at Stage 2 (schema)
#    Capture has 3 rounds but no extract step. Synthesizer cannot infer
#    credential spec.
#    Capture moved to ~/.trusty-squire/corpus/skills-failed/<id>/
#    See rejection.json for offending round.
```

**If you want to test against the real signup flow:**
```bash
pnpm skill:promote railway --full
# → creates an actual account on Railway, extracts a real credential.
#   Only works for services that allow re-extraction (Stripe-class).
#   Burns an alias.
```

## Why now

Three things forcing the conversation:

1. **0.6.13 shipped a regex fix for Railway.** It works. But the next time
   Railway tweaks its dashboard, or a new bare-UUID service shows up, we're back
   to a Tier-1 patch. We're not building leverage.
2. **The capture infrastructure already exists.** `onboarding-capture.ts` writes
   one JSON per post-verify round, env-gated by `TRUSTY_SQUIRE_ONBOARDING_CAPTURE`.
   This is the harvester's input format. Nobody's reading from it.
3. **`registry-api` is the right home and is already shipping signed manifests.**
   `apps/registry-api/src/publish.ts` already does manifest validation + signing
   + insertion. A learned skill is just a manifest with a confidence score and a
   mutable lifecycle. The infrastructure to host both is the same code.

The fourth and quietest reason: **every successful run is unrecoverable
training data today.** Capturing the path mechanically — even if we never
fine-tune anything — converts operational success into a versioned, queryable
asset.

---

## Three-tier execution model

The promoter only makes sense in the context of where it sits between the
universal bot and the authored adapters. State that explicitly:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tier 3 — AUTHORED ADAPTER                                           │
│  • Hand-written TypeScript manifest                                  │
│  • Multi-credential, multi-step, fully typed                         │
│  • Signed, pinned, versioned via semver                              │
│  • One ships today: Resend                                           │
│  • Best for: high-traffic services that justify hand-investment      │
├──────────────────────────────────────────────────────────────────────┤
│  Tier 2 — LEARNED SKILL  ← this doc                                  │
│  • Auto-promoted from one or more successful Tier-1 runs             │
│  • Selector hints + replay graph + credential shape                  │
│  • Confidence score: rises with successful replays, falls on failure │
│  • Self-demotes after N consecutive failures (page changed)          │
│  • Stored in registry-api with signature + mutable success metadata  │
│  • Best for: the long tail of services the universal bot can solve   │
├──────────────────────────────────────────────────────────────────────┤
│  Tier 1 — UNIVERSAL BOT (pathfinder)                                 │
│  • Today's flow: LLM-planned, regex-extracted, slow                  │
│  • Runs when no skill exists, OR when a skill fails its DOM check    │
│  • Every successful run is a candidate input to the promoter         │
└──────────────────────────────────────────────────────────────────────┘
```

The router that dispatches between tiers (Section 6 below) is part of this
release. Without it, the promoter outputs go nowhere.

---

## Skill data model

A skill is a **structured replay graph** plus enough metadata to make replay
robust to small page changes.

```typescript
// apps/registry-api/src/types.ts (extended)
export interface Skill {
  // Identity
  service: string;              // canonical name, lowercase ("railway")
  version: string;              // skill schema version, e.g. "1"
  skill_id: string;             // ULID, unique per skill instance

  // Entry points
  signup_url: string;           // verified by replay
  oauth_provider: "google" | "github" | null;

  // The replay graph
  steps: SkillStep[];

  // What we expected the run to produce
  credential: SkillCredentialSpec;

  // Lineage
  source_run_ids: string[];     // the universal-bot runs this skill was learned from
  created_at: Date;
  last_replayed_at: Date | null;

  // Health
  replays_succeeded: number;
  replays_failed: number;
  consecutive_failures: number; // resets on success; ≥3 demotes the skill
  status: "active" | "demoted" | "superseded";
}

export type SkillStep =
  | { kind: "navigate"; url: string }
  | { kind: "click_oauth_button"; provider: "google" | "github"; text_match: string }
  | { kind: "click"; text_match: string; role_hint?: "button" | "link" | "tab" }
  | { kind: "fill"; label_hint: string; value_template: string }  // "${TOKEN_NAME}"
  | { kind: "extract_via_copy_button"; near_text_hint: string }
  | { kind: "extract_via_regex"; pattern_name: string };          // for prefix-known shapes

export interface SkillCredentialSpec {
  type: "api_key" | "oauth_token" | "secret";
  shape_hint: "uuid" | "prefix:re_" | "prefix:sk_" | "opaque" | "username_password";
  env_var_suggestion: string;   // RAILWAY_API_KEY
  // Sanity-check the extracted value before vault write. NOT the
  // primary extraction mechanism — that's the step list above.
  post_extract_validator: {
    min_length: number;
    max_length: number;
    shape_regex?: string;
  };
}
```

### Three principles in this shape

1. **No raw CSS selectors.** Every targeting is by `text_match`, `label_hint`,
   `near_text_hint`, or `role_hint`. CSS selectors are brittle across redesigns
   (Sentry shipped a Tailwind migration mid-2024 that broke 11 hand-written
   adapters in production-internal logs). Text-based targeting survives most
   redesigns because the visible vocabulary is what humans navigate by, and
   designers don't change "Create Token" to "Fabricate Authentication
   Authorization" between sprints.
2. **Each step is independently validatable.** Before the runner clicks "Create
   Token," it confirms a button with that text is in the inventory. If not, that
   one step falls back to the LLM planner with the rest of the skill intact.
   This means a skill can survive partial DOM changes — only the changed step
   is re-pathed. The recovered step's new text/selector is captured as a
   candidate skill update.
3. **Credential extraction is part of the graph, not a global regex pass.**
   The skill says exactly which copy button to click or which on-page text node
   contains the value. This is what fixes the multi-credential disambiguation
   problem: Stripe's skill would have two `extract_via_copy_button` steps with
   distinct `near_text_hint`s ("publishable key" vs "secret key").

---

## The promoter pipeline

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ universal bot   │──▶│ corpus/         │──▶│ promoter        │
│ signup_success  │   │ onboarding/     │   │                 │
└─────────────────┘   │   <service>/    │   │ 1. Synthesize   │
                      │   <run-id>/     │   │ 2. Validate     │
                      │   r0.json       │   │ 3. Replay-test  │
                      │   r1.json …     │   │ 4. Sign         │
                      └─────────────────┘   │ 5. Publish      │
                                            └────────┬────────┘
                                                     │
                                                     ▼
                                            ┌─────────────────┐
                                            │ registry-api    │
                                            │ POST /skills    │
                                            └─────────────────┘
```

Five stages, each independently testable.

### Stage 1 — Synthesize

Read all `r*.json` captures from `corpus/onboarding/<service>/<run-id>/`. The
captures already contain `state` (url/title/html/screenshot) and `inventory`
(ranked DOM elements with `visibleText`, `ariaLabel`, `role`, `selector`) and
the `observed` planner decision per round.

For each round, emit a `SkillStep`. Rules:

| `observed.kind` | Emit                                       | Hint source |
|-----------------|--------------------------------------------|---------------------|
| `navigate`      | `{ kind: "navigate", url }`                | the observed URL                          |
| `click`         | `{ kind: "click", text_match, role_hint }` | the inventory element matching the selector — pull its `visibleText`/`ariaLabel` |
| `fill`          | `{ kind: "fill", label_hint, value_template }` | the matching input's nearest `<label>` text or `placeholder` |
| `extract`       | `{ kind: "extract_via_copy_button", near_text_hint }` if a Copy button is in the same inventory; else `extract_via_regex` | section heading nearest the credential value |
| `done`          | (skill end marker)                         | —                                          |

The synthesizer is deterministic and pure — same captures in, same skill out.
Lives in `apps/mcp/src/bot/promote-to-skill.ts` (host-side, ships with the
`@trusty-squire/mcp` npm package).

### Stage 2 — Validate

Schema validation only. Zod schema in `packages/adapter-sdk` (alongside
existing manifest schemas — they share the validator infrastructure already).
Rejects obviously-broken outputs: missing credential spec, no steps, illegal
step kinds, validators that would never match anything plausible. This is
cheap and catches synthesizer bugs.

### Stage 3 — Replay-test

**This is the load-bearing stage.** A skill is not allowed to land in the
registry until it has been replayed against a fresh browser session and
produced a credential that passes its own validator.

```typescript
async function replayTest(skill: Skill, fresh: BrowserController): Promise<ReplayOutcome> {
  for (const step of skill.steps) {
    const ok = await stepValidates(step, fresh);  // cheap DOM probe
    if (!ok) return { kind: "step_failed", at: step };
    await executeStep(step, fresh);
  }
  const credential = await extractByCredentialSpec(skill.credential, fresh);
  if (!skill.credential.post_extract_validator.matches(credential)) {
    return { kind: "validator_failed", got: credential };
  }
  return { kind: "ok", credential };
}
```

A skill that fails replay-test is **kept on disk** (in
`corpus/skills-pending/`) for human inspection but **not published**. This is
the safety gate that keeps a bad capture from poisoning the registry.

For services that require a fresh account per run (most), the replay-test must
share the same OAuth session as the original capture. This is fine — the bot
already has session state in `~/.trusty-squire/chrome-profile/`. The replay
just re-uses it.

### Stage 4 — Sign

Same `ManifestSigner` as the existing manifest publish flow
(`apps/registry-api/src/signer.ts`). Skills are signed exactly like adapters.
This matters because:
- Consumers (the universal-bot router) verify signatures before replay. A
  tampered skill record can't redirect a signup to a phishing URL.
- Lineage stays auditable: who promoted this skill, when, from which run.

### Stage 5 — Publish

`POST /skills` to `registry-api`. Idempotent on `(service, skill_id)`. If a
skill already exists for the service, the new one is published alongside the
old one with an incremented internal version, and the old one is marked
`superseded` after the new one's `replays_succeeded` ticks past 3 (rolling
deployment to absorb a bad capture).

---

## The router (Tier 2 dispatch)

The skill promoter is useless without something that reads from the registry.
Ships in the same release.

```typescript
// apps/mcp/src/tools/provision-any.ts
export async function provisionAnyService(input: ProvisionInput) {
  const skill = await registryClient.getSkill(input.service);

  if (skill !== null && skill.status === "active") {
    const result = await replaySkill(skill, browser, llmFallback);
    if (result.kind === "ok") {
      await registryClient.recordSkillReplay(skill.skill_id, "success");
      return finalizeCredential(result.credential);
    }
    // Step failed → log the failure, fall through. The next stage tries
    // the universal bot, and on success that success becomes a candidate
    // for a NEW skill version (possibly superseding this one).
    await registryClient.recordSkillReplay(skill.skill_id, "failure", result);
  }

  return await universalBot.signup(input);
}
```

`replaySkill` is **partially-resumable**: when a single step fails its
pre-validation DOM check, it falls back to the LLM planner for *that step
only*, captures what the planner did, and continues. The diff between the
skill's expected step and the planner's actual step is written back to the
capture directory as a "skill update candidate" — input to the next promoter
run.

This is the self-healing property. A small page change (button text "Create
Token" → "New token") triggers a single LLM call to repath one step, and the
next promoter run updates the skill.

---

## Lifecycle and confidence

Every skill carries running counters:

| Counter | What it means | Effect |
|---|---|---|
| `replays_succeeded` | full end-to-end replay landed a credential | trust grows |
| `replays_failed` | replay aborted before credential | trust shrinks |
| `consecutive_failures` | resets on success | ≥3 → status: "demoted" |

A `demoted` skill is **not used** by the router — the next signup goes
straight to the universal bot. A demoted skill's source capture data is kept
around so the next promoter run can attempt to synthesize a new skill from
both old + new captures.

A skill with `replays_succeeded ≥ 10` and zero failures in its last 5 replays
is a candidate for **promotion to Tier 3** (authored adapter). The promoter
emits a draft TypeScript adapter manifest pre-filled with the learned values
and opens a PR. Manual review, typing pass, tests, then merge. This is the
long-term path from "amnesia → skill → adapter."

---

## What this does *not* solve

Explicitly out of scope, to keep the release honest:

1. **Multi-credential extraction.** Stripe-with-publishable-and-secret-keys is
   representable in the skill data model (two `extract_via_copy_button` steps
   with distinct hints), but the universal bot still emits only one credential
   per run today. The promoter can't learn what it doesn't capture. Multi-cred
   support requires extending `UniversalSignupBot.signup()` to return an array,
   which is a separate piece of work (call it 0.8.0).

2. **Cross-service skill reuse.** Each skill is service-scoped. We won't learn
   "all Vercel-style services have a Create Token button in /account/tokens"
   — that pattern abstraction is a Tier-0 concern (the universal bot's
   planner prior), separate from Tier-2 codification.

3. **The OAuth-button-detection bug we hit during 0.6.13 testing.** Local-tsx
   builds don't see the profile's logged-in providers. That's a dev-loop bug,
   not a runtime bug, and not what this release fixes.

4. **Backfill from historical runs.** The corpus directory has captures from
   prior signups that succeeded. We *could* run the promoter against those to
   seed the registry. We're punting that to a follow-on chore: the seed run
   should happen with the promoter fully validated against fresh data first.

---

## Failure modes and their handling

| Failure | Promoter behavior |
|---|---|
| Synthesizer produces invalid skill | rejected at Stage 2, capture moved to `corpus/skills-failed/` with reason |
| Replay-test fails | rejected at Stage 3, capture kept in `corpus/skills-pending/` |
| Replay-test produces a credential but its shape doesn't match `validator` | rejected — likely the skill picked the wrong UUID on the page; the synthesizer fix is to read the planner's `reason` field more carefully |
| Skill replays succeed but extract returns the wrong value (user reports a 401) | manual demote via CLI: `pnpm skill demote <service>`. The skill record holds the demotion + reason. |
| Page changes and one step's text breaks | router falls back to LLM for that step, succeeds, writes a skill-update candidate. Next promoter run picks it up. |
| Page changes and multiple steps break | `consecutive_failures` hits 3, skill auto-demotes, next signup is full Tier-1 path. The new universal-bot success becomes seed data for a new skill version. |

The promoter has **no automatic publish loop that runs without human
oversight in the first release.** It runs on `pnpm skill:promote <service>`
explicitly. Auto-promotion (every successful capture immediately tries to
publish) is a setting we turn on after we've watched the manual path run
clean for a month.

---

## CLI surface

Full spec for every `pnpm skill:*` command that ships in 0.7.0. Each
entry lists the verb, the flags, the exit codes, the JSON output shape
(when `--json` is set), and which finding it resolves. This is the
contract the implementer follows.

### Conventions

- **Verbs follow `noun:verb` pattern.** `skill:promote`, `skill:list`,
  `skill:show`, etc. Mirrors `pnpm` conventions in the existing
  monorepo (`registry:publish`, `gen:skill-docs`).
- **All commands accept `--json`.** Output is one JSON object or array
  per invocation; pipe-friendly. Without `--json`, output is
  human-readable with ANSI colours.
- **Exit codes are stable.** `0` = success, `1` = generic failure,
  `2` = invalid invocation, `3` = auth/config error, `4` = registry
  unreachable, `5` = validation rejection, `6` = replay-test rejection,
  `7` = signature failure. Scripts can switch on these.
- **All commands honour `TRUSTY_SQUIRE_REGISTRY_URL`** (default:
  `https://registry.trustysquire.com`). Override for local dev or
  staging.

### Commands

#### `pnpm skill:promote <service> [--flags]`

Synthesize a skill from `corpus/onboarding/<service>/` and publish it.
The primary command. (D3, D9, T3)

| Flag | Default | Effect |
|---|---|---|
| `--run-id=<id>` | latest run | Pick a specific capture |
| `--from-pending` | off | Retry a capture in `corpus/skills-pending/` |
| `--dry-run` | off | Synthesize + validate + replay-test, but **don't publish** |
| `--skip-replay-test` | off | Skip Stage 3 entirely. Use only when you've validated manually. |
| `--full` | off | Run full-mode replay-test (creates a real account). Opt-in per design D3. |
| `--force` | off | Republish even if validation/replay-test rejects (writes a warning to the skill metadata) |
| `--service-url=<url>` | inferred | Override the captured `signup_url`. Useful when the original capture used a wrong-but-working URL. |
| `--json` | off | Machine-readable output |

**Exit codes:** `0` published / `5` schema rejection / `6` replay-test
rejection / `7` signature failure / `4` registry unreachable.

**JSON output shape (success):**
```json
{
  "ok": true,
  "skill_id": "01HZX9...",
  "service": "railway",
  "version": "v1",
  "captures_used": ["run-abc123"],
  "replay_test": { "kind": "dry-pass", "steps_walked": 4 },
  "published_at": "2026-05-21T04:12:33Z"
}
```

**JSON output shape (rejection):**
```json
{
  "ok": false,
  "stage": "replay-test" | "schema-validation" | "synthesis" | "signature",
  "error_kind": "ambiguous_text_match" | "credential_spec_missing" | ...,
  "message": "human-readable",
  "offending_step": 3,
  "expected": "...",
  "actual": "...",
  "synthesizer_version": "1",
  "replay_test_log_path": "/home/.../skills-pending/01HZX9.../replay.log"
}
```

#### `pnpm skill:list [--flags]`

List all skills in the registry.

| Flag | Default | Effect |
|---|---|---|
| `--status=<active\|demoted\|pending\|all>` | `active` | Filter by status |
| `--service=<svc>` | all | Filter by service |
| `--limit=<n>` | 50 | Pagination cap |
| `--json` | off | Machine-readable |

**Exit codes:** `0` always (an empty list is success).

#### `pnpm skill:show <service> [--flags]`

Print the full skill record for a service.

| Flag | Default | Effect |
|---|---|---|
| `--version=<v>` | active | Pick a specific version (else current active) |
| `--include-replays` | off | Append the last 50 replay outcomes |
| `--json` | off | Machine-readable |

**Exit codes:** `0` found / `1` not found / `4` registry unreachable.

#### `pnpm skill:diff <service> <v1> <v2> [--flags]`

Semantic diff between two skill versions of the same service. The diff
is over the step graph + credential spec, not the raw JSON.

| Flag | Default | Effect |
|---|---|---|
| `--json` | off | Machine-readable diff |

**Output:** a unified-diff-style view of the step graph, with
text-match changes highlighted. Useful for "what did the new version
of Railway's skill change?"

**Exit codes:** `0` differences shown / `1` versions identical /
`2` version not found.

#### `pnpm skill:edit <service> [--flags]`

Open the current active skill in `$EDITOR`. On save, re-validate, re-sign,
and republish as a new version. Used to hand-fix a broken skill without
re-capturing.

| Flag | Default | Effect |
|---|---|---|
| `--version=<v>` | active | Edit a specific version |
| `--dry-run` | off | Don't publish, just validate the edits |

**Exit codes:** `0` published / `5` validation rejection / `2` no edits
made.

⚠️ **Security note:** edits to `signup_url` or `oauth_provider` fields
require human-review gate (C11). The CLI prints a warning and the
registry holds the skill in `pending-review` status until an operator
runs `pnpm skill:approve-review <skill_id>`. Other field edits
auto-publish.

#### `pnpm skill:demote <service> [--flags]`

Manually demote a skill. The router will skip it on future calls.

| Flag | Default | Effect |
|---|---|---|
| `--reason="..."` | required | Free-text reason, stored in skill metadata |
| `--version=<v>` | active | Demote a specific version |

**Exit codes:** `0` demoted / `1` already demoted / `4` registry
unreachable.

#### `pnpm skill:reactivate <service> [--flags]`

Undo a demotion. Resets `consecutive_failures` to 0.

| Flag | Default | Effect |
|---|---|---|
| `--version=<v>` | latest demoted | Reactivate a specific version |

**Exit codes:** `0` reactivated / `1` not demoted (no-op) / `4`
registry unreachable.

#### `pnpm skill:replay-test <service> [--flags]`

Re-run Stage 3 (replay-test) against the currently published skill.
Useful when you suspect a page change broke the skill and want to
confirm before users hit it.

| Flag | Default | Effect |
|---|---|---|
| `--full` | off | Run full-mode (creates real account) |
| `--version=<v>` | active | Test a specific version |
| `--json` | off | Machine-readable |

**Exit codes:** `0` replay-test passes / `6` fails / `4` registry
unreachable.

#### `pnpm skill:delete <service> --version=<v> [--flags]`

Hard-delete a skill version. Requires `--confirm` because this is
irreversible.

| Flag | Default | Effect |
|---|---|---|
| `--version=<v>` | **required** | Which version to delete |
| `--confirm` | **required** | Confirms intent |

**Exit codes:** `0` deleted / `2` missing required flag / `1` not found.

#### `pnpm skill:backfill [--flags]` (0.7.1, not 0.7.0)

Walk every directory under `corpus/onboarding/` and attempt to promote
each. Used once after 0.7.0 ships clean to seed the registry from
historical captures.

| Flag | Default | Effect |
|---|---|---|
| `--dry-run` | off | Synthesize + validate only; report which would publish |
| `--continue-on-error` | off | Don't abort the batch on first failure |
| `--json` | off | Machine-readable summary |

**Exit codes:** `0` all succeeded / `1` some failed (see output) /
`5` all failed.

#### `pnpm skill:approve-review <skill_id> [--flags]`

Operator-only command to approve a `pending-review` skill (one with
edited `signup_url` or `oauth_provider`). Requires an env-set operator
token.

| Flag | Default | Effect |
|---|---|---|
| `--reject --reason="..."` | off | Reject instead of approve |

**Exit codes:** `0` approved / `1` rejected / `3` operator token
missing / `2` no review pending for that skill_id.

### Discoverability

- `pnpm skill:help` → prints the full table above with one-line summaries
- `pnpm skill:promote --help` → command-specific help
- Tab-completion for service names from the registry (deferred to 0.7.2)

### What's NOT in 0.7.0

- `pnpm skill:trace <provision_id>` — given a signup correlation ID,
  reconstruct which skill version was used, which steps ran, which
  failed. Deferred to 0.7.2. (D8)
- `pnpm skill:audit` — operator command showing the audit log for a
  service's skill history. Deferred to 0.7.2.
- Tab-completion. 0.7.2.

## Concrete deliverables for 0.7.0

In rough dependency order:

1. **Skill schema + Zod validator** — `packages/adapter-sdk/src/skill.ts`.
   Mirrors the existing manifest schema patterns. (~150 LoC)
2. **Synthesizer** — `apps/mcp/src/bot/promote-to-skill.ts`. Pure function:
   captures in, skill out. Unit-tested against synthetic capture fixtures.
   (~300 LoC + ~400 LoC tests)
3. **Replay engine** — `apps/mcp/src/bot/replay-skill.ts`. Walks a skill,
   executes each step against a browser, falls back to LLM per-step. Returns
   `ReplayOutcome`. (~250 LoC + ~300 LoC tests)
4. **Registry endpoints** — `apps/registry-api/src/routes/skills.ts`.
   `GET /skills/:service`, `POST /skills`, `POST /skills/:id/replay-outcome`.
   Mirrors the existing manifest routes. Prisma migration adds the `skills`
   and `skill_replays` tables. (~200 LoC + ~250 LoC tests)
5. **CLI** — `pnpm skill:promote <service>`. Wires Stages 1–5 end-to-end.
   (~100 LoC)
6. **Router integration** — modify `apps/mcp/src/tools/provision-any.ts` to
   check the registry first. Falls back to universal bot on miss or demotion.
   (~80 LoC + integration tests)

**Total: ~1100 LoC of new code, ~1000 LoC of tests, no changes to the
universal bot's planner or extractor.** The universal bot remains the
canonical Tier-1 path; this work is strictly Tier-2 additive.

---

## Open questions

Genuinely open, not rhetorical:

1. **Should the registry's skill table be a separate Prisma model from
   manifests, or a unified `Adapter` table with a `tier` discriminator?** The
   data shapes are 80% overlapping. A unified table simplifies the router but
   couples the schemas — a manifest schema change forces a skill schema
   migration. I lean unified, with `tier: "skill" | "manifest"` as a column,
   but want a second opinion.

2. **Replay-test session reuse.** A replay-test that creates a real account
   on Railway every time will rate-limit. Options:
   - Skip replay-test for OAuth-only services (trust the synthesizer; it's
     deterministic from captures we already know worked).
   - Run replay-test in a "dry mode" that walks every step but stops just
     before the final credential-creating click.
   - Reuse the original signup's OAuth session for the replay.
   I lean toward the dry-mode option as the default with a `--full` flag for
   the careful path.

3. **Where do skill version bumps come from?** If two captures of the same
   service produce semantically-identical skills, that's no version bump. If
   one captures a new step (Railway adds an MFA prompt), is that a v1→v2 or a
   net-new skill? My instinct: it's the same skill at a new internal version
   number, and the runner tries the highest-numbered active version first.

4. **Should the promoter be in `apps/mcp/` (ships with the npm package) or
   in `apps/api/` (server-side, doesn't need to ship to every user's
   machine)?** I have it in `apps/mcp/` above because the captures live on
   the user's machine and the promoter needs to read them. But that means
   every user runs the promoter logic, which is dead weight for users who
   never trigger it. Counter-argument: the promoter only runs on `pnpm
   skill:promote`, which is a developer command, not a user command. The
   user-facing path is the router, which IS in `apps/mcp/`. So this is
   probably fine. Want a sanity check.

---

## What ships after this

The roadmap once 0.7.0 lands:

- **0.7.1** — backfill: run the promoter against existing captures in
  `corpus/onboarding/`, hand-curate any that fail replay-test.
- **0.7.2** — auto-promote mode: every successful universal-bot run
  immediately attempts skill synthesis + replay-test. No human gate. Watched
  for a release cycle before being default-on.
- **0.8.0** — multi-credential extraction in the universal bot (`signup()`
  returns `ExtractedCredential[]` not `Record<string, string>`). Skill schema
  already supports it; only the bot's output shape needs to change.
- **0.9.0** — adapter promotion: skills with ≥10 successful replays and a
  long zero-failure window get an auto-drafted `packages/adapters/<service>/`
  PR.
- **1.0.0** — by this point most popular services run on Tier 2 or 3. The
  universal bot becomes the rare-path explorer for genuinely new services.
  The institutional memory loop is closed.

---

## GSTACK REVIEW REPORT

Generated by `/autoplan` on the 0.6.13 commit. Codex unavailable (binary
missing); all dual voices ran Claude subagent only — tagged
`[subagent-only]`.

### Phase 1 — CEO Review

**Mode:** SELECTIVE EXPANSION

**Premise gate** (REQUIRES USER CONFIRMATION):
- **P1: "Institutional memory is the right product direction"** — strong
  (TODOS.md P1 + P1.1 already commit). Accept.
- **P2: "A skill is a strict subset of an adapter manifest"** — **false**.
  Adapter manifests are TypeScript modules with `defineAdapter()`; skills
  are structured JSON with text-based selectors. Parallel schemas, not
  sub/superset. Rephrase to "skills share lifecycle + signing
  infrastructure with adapters."
- **P3: "Replay-test catches bad skills before publish"** —
  **structurally broken**. Real signups consume their alias and can't be
  replayed. Dry-mode is the only feasible default.
- **P4: "Text-based targeting survives most redesigns"** — **unmeasured**.
  Before shipping: diff `inventory.visibleText` for 5 services across 2
  weeks of captures. <70% stable → schema is wrong.

#### CEO Dual Voices Consensus

| Dimension | Claude (subagent) | Codex | Consensus |
|---|---|---|---|
| 1. Premises valid? | NO — 3 of 4 unproven or false | [codex-unavailable] | NO |
| 2. Right problem to solve? | DISAGREE — bottleneck is failed signups + key-reuse, not signup latency | [codex-unavailable] | DISAGREE |
| 3. Scope calibration correct? | NO — full graph when URL row (P1.1) ships same thesis at 1/15th LoC | [codex-unavailable] | NO |
| 4. Alternatives sufficiently explored? | NO — three lighter alternatives dismissed without analysis | [codex-unavailable] | NO |
| 5. Competitive risks covered? | DISAGREE — Anthropic Computer Use / Browserbase shipping generic replay would subsume | [codex-unavailable] | DISAGREE |
| 6. 6-month trajectory sound? | NO — likely <15% cache hit rate; P3 keystone means agents reuse keys, not re-provision | [codex-unavailable] | NO |

**0/6 confirmed, 6/6 raise concerns. → USER CHALLENGE.**

#### CEO Findings (consolidated)

| ID | Severity | Finding | Fix |
|---|---|---|---|
| **C1** | HIGH | Premise 2 ("skill ⊆ adapter manifest") is wrong; schemas are parallel | Rewrite as "shared infrastructure" |
| **C2** | CRITICAL | Stage 3 replay-test as designed is incoherent — signups consume the token on first read | Dry-mode default; `--full` opt-in |
| **C3** | MEDIUM | Text-based targeting fails on ambiguous text (two "Create" buttons) | Specify disambiguation: nearest-ancestor-section-heading, then DOM order, LLM fallback |
| **C4** | HIGH | Doc treats `signup_url` as a skill field but TODOS.md P1.1 says it should be its own living registry | Unify per option D: single registry table; +200 LoC saves future migration |
| **C5** | CRITICAL | Validator catches shape mismatches, not semantic ones — wrong UUID would pass | Credential validator requires sentinel: known-good prefix OR HTTP test against service `/whoami`-equivalent |
| **C6** | MEDIUM | No caching story for `registryClient.getSkill()` | In-process LRU on MCP client, 5min TTL, cache-bust on replay failure |
| **C7** | HIGH | Per-step LLM fallback only triggers AFTER step 0 succeeds; wrong `signup_url` aborts the whole replay | Treat URL as step 0; fall back to `KNOWN_DOMAINS` + `guessSignupUrl` + Google search |
| **C8** | HIGH | Schema not forward-compatible with multi-credential (0.8.0) | Ship `credentials: SkillCredentialSpec[]` from day one; single-element default |
| **C9** | MEDIUM | No rate-limit on `POST /skills/:id/replay-outcome` | Rate-limit by account, 60/min |
| **C10** | MEDIUM | No ops story (force-demote, alerting, backup/restore) | Add "Operations" subsection with CLI surface |
| **C11** | CRITICAL | Signed skills catch external tampering but not internal — compromised promoter could publish phishing URL | Human-review gate for `signup_url` and `oauth_provider` changes; auto-publish other fields |
| **C12** | CRITICAL | Replay-test runs in user's local browser with OAuth session — malicious nav could exfiltrate token | Sandbox replay-test in separate browser context with no ambient credentials |
| **C13** | MEDIUM | Migration story for `KNOWN_DOMAINS` undefined | Registry wins; hardcoded map becomes fallback when registry unreachable |
| **C14** | LOW | Skill version not propagated into final SignupResult | Add `skill_id` + `skill_version` to result tail |
| **C15** | MEDIUM | "30s replay" assumes happy path; 3 failed steps + LLM fallback = 3min | Instrument percentiles (p50, p95), not headline number |
| **C16** | LOW | Demoted skills accumulate as dead weight | Delete-on-successor-publish, 90-day grace |
| **C17** | HIGH | No runbook for "skill broken in prod, what do I do?" | Add "Runbooks" subsection |

---

### Phase 2 — Design Review

**SKIPPED.** No UI scope. Backend infrastructure only (CLI + endpoints +
router).

---

### Phase 3 — Eng Review

**Scope challenge result:** Doc estimates ~1100 LoC + ~1000 LoC tests.
Subagent flagged as **2× under**. Realistic: ~2200 LoC + ~2000 LoC tests.

#### Architecture (ASCII dependency graph)

```
┌────────────────────────────────────────────────────────────────────┐
│  USER MACHINE                                                      │
│                                                                    │
│  ┌────────────────┐   reads     ┌──────────────────────────────┐   │
│  │ universal bot  │────────────▶│ corpus/onboarding/<svc>/     │   │
│  │ (existing)     │  writes     │  <run-id>/r*.json            │   │
│  └────────────────┘             └──────────────────────────────┘   │
│         │                                  │                       │
│         │ post-success                     │ read on demand        │
│         ▼                                  ▼                       │
│  ┌────────────────┐             ┌──────────────────────────────┐   │
│  │ provision-any  │             │ promote-to-skill.ts (NEW)    │   │
│  │ tool router    │             │  Stages 1-5                  │   │
│  │ (MODIFIED)     │◀────────────│                              │   │
│  └────────────────┘   cache     └──────────────────────────────┘   │
│         │                                  │                       │
│         │ GET /skills/:svc                 │ POST /skills          │
│         ▼                                  ▼                       │
└─────────│──────────────────────────────────│───────────────────────┘
          │              HTTPS               │
┌─────────▼──────────────────────────────────▼───────────────────────┐
│  REGISTRY-API (Fly.io)                                             │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Existing: manifest publish + signer + validator              │  │
│  │ NEW: routes/skills.ts, skills table, skill_replays table     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**Coupling analysis:**
- Promoter depends on capture format → version it, reject old versions.
- Replay engine on `BrowserController` → stable, low risk.
- Router on registry availability → must fail-open. C6 cache covers
  transient failures.
- Shared schema (`packages/adapter-sdk`) → pin a major version; both
  sides reject unknown minor versions.

#### Eng Dual Voices Consensus

| Dimension | Claude (subagent) | Codex | Consensus |
|---|---|---|---|
| 1. Architecture sound? | DISAGREE — trust boundary inversion (unsigned captures → signed publish) | [codex-unavailable] | DISAGREE |
| 2. Test coverage sufficient? | NO — ~1000 LoC tests with no spec for what they cover | [codex-unavailable] | NO |
| 3. Performance risks addressed? | NO — no cache, no rate-limit, no percentiles | [codex-unavailable] | NO |
| 4. Security threats covered? | NO — phishing-via-skill (C11), token-exfil-via-replay (C12) unaddressed | [codex-unavailable] | NO |
| 5. Error paths handled? | NO — rejection records unstructured | [codex-unavailable] | NO |
| 6. Deployment risk manageable? | YES — additive, skill can be deleted from registry without code change | [codex-unavailable] | YES |

**1/6 confirmed.**

#### Eng Findings

| ID | Severity | Finding | Fix |
|---|---|---|---|
| **E1** | CRITICAL | Trust boundary inversion — local captures unsigned; hand-edits propagate to signed output | Capture-format integrity hash chain in `onboarding-capture.ts`; promoter verifies before synthesis |
| **E2** | HIGH | Shared schema in `packages/adapter-sdk` between MCP and registry-api; drift = client-side pass, server-side reject | Version Zod schema; both sides pin major version; registry rejects unknown minor with clear message |
| **E3** | MEDIUM | `consecutive_failures` race condition under concurrent replays | Atomic increment in store layer (Postgres `UPDATE … SET consecutive_failures = consecutive_failures + 1`) |
| **E4** | HIGH | Replay-test session reuse (Open Q2) unresolved — structural blocker | Dry-mode default, `--full` opt-in; codify in design before implementation |
| **E5** | MEDIUM | Replay engine estimate ~250 LoC is 2-3× under given per-step LLM-fallback integration | Re-estimate to ~600 LoC |
| **E6** | HIGH | Skill demotion is permanent until manual reactivate; no monitoring | Registry-api emits webhook/notification on demotion; ops dashboard |
| **E7** | MEDIUM | Forward-compatibility with multi-credential | Same fix as C8: ship as array from day one |
| **E8** | LOW | `replays_succeeded`/`replays_failed` not split by step | Per-step counters; defer to 0.7.2 |

#### Eng Test Diagram

| Path | Test type | Mentioned? | Action |
|---|---|---|---|
| Synthesizer: empty/malformed/missing-cred capture | Unit | NO | Add |
| Synthesizer: deterministic output (golden file) | Unit | NO | **Critical** |
| Replay: step text-match unambiguous resolution | Unit + fixture | NO | **Critical** |
| Replay: step text-match has 2+ matches → LLM fallback | Integration | NO | **Critical** |
| Replay: full graph against deterministic page fixture | Integration | NO | **Critical** |
| Replay: credential validator rejects wrong-shape | Unit | YES | OK |
| Replay: credential validator passes wrong-content | **NO TEST** | NO | **C5 — must add** |
| Registry: POST /skills idempotency | Unit | NO | Add |
| Router: registry unreachable → fall-through | Integration | NO | Add |
| Router: skill cache TTL expiry | Unit | NO | Add |
| Provenance: source_run_ids resolvable post-publish | Integration | NO | **D1 — critical** |

---

### Phase 3.5 — DX Review

**Mode:** DX POLISH

#### Developer Journey Map

| Stage | Action | Friction today | Friction after 0.7.0 |
|---|---|---|---|
| 1. Discover | "How do I make Railway not take 6min?" | Read source | Read doc + Quickstart (D9) |
| 2. Setup | Get capture data | N/A | Need to have set `TRUSTY_SQUIRE_ONBOARDING_CAPTURE` during the original run — **trap, unimproved** |
| 3. Promote | `pnpm skill:promote railway` | N/A | One command — good |
| 4. Verify | Inspect what was published | N/A | `pnpm skill:show` missing from deliverables — **gap** |
| 5. Replay | Trigger signup | `provision_any_service` | Same call → uses skill |
| 6. Debug | Trace what happened | Stare at steps[] | source_run_ids point to local files only — **gap (D1)** |
| 7. Fix | Patch broken step | N/A | `pnpm skill:edit` missing — **gap (D3)** |
| 8. Demote | Pull bad skill | N/A | `pnpm skill demote` (mentioned, undefined) |
| 9. Re-promote | Republish | N/A | Workflow undocumented |

**TTHW:**
- **Doc as-shipped:** 60+ min (read source to find env var, capture format, CLI flags)
- **With DX fixes:** 5 min target

#### DX Dual Voices Consensus

| Dimension | Claude (subagent) | Codex | Consensus |
|---|---|---|---|
| 1. Getting started < 5 min? | NO | [codex-unavailable] | NO |
| 2. API/CLI naming guessable? | DISAGREE — inconsistent verbs | [codex-unavailable] | DISAGREE |
| 3. Error messages actionable? | NO — failure-modes prose, not machine-parsable | [codex-unavailable] | NO |
| 4. Docs findable & complete? | NO — schema in doc not code; flags unspecified | [codex-unavailable] | NO |
| 5. Upgrade path safe? | YES — additive | [codex-unavailable] | YES |
| 6. Dev environment friction-free? | NO — signing key + registry auth undefined | [codex-unavailable] | NO |

**1/6 confirmed.**

#### DX Findings

| ID | Severity | Finding | Fix |
|---|---|---|---|
| **D1** | CRITICAL | Capture upload at publish missing — `source_run_ids` point to local laptop dirs that won't exist 6 months later | Content-hash captures into registry-api as sidecars; reference by hash |
| **D2** | CRITICAL | Structured rejection records absent in `corpus/skills-failed/` and `skills-pending/` | Mandatory `rejection.json` sibling: `{stage, error_kind, message, offending_step?, expected?, actual?, synthesizer_version, replay_test_log_path}` |
| **D3** | HIGH | Full CLI surface unspecified | Spec all commands: `skill:promote | list | show | diff | edit | demote | reactivate | replay-test | delete` with flags (`--dry-run | --json | --service | --run-id | --from-pending | --force`) and exit codes per error family |
| **D4** | HIGH | Schema in doc, not code | Zod `.describe()` on every field; auto-generate `docs/skill-schema.md` |
| **D5** | HIGH | No per-step provenance | Each `SkillStep` carries `provenance: { run_id, round_index }` |
| **D6** | HIGH | "Skill update candidate" write-back unspecified | Spec the file path and Zod schema |
| **D7** | MEDIUM | `GET /skills/:id/replays` endpoint missing | Add for failure-trail debugging |
| **D8** | MEDIUM | No correlation ID through the stack | Propagate `provision_id` from MCP entry through capture filename and replay-outcome |
| **D9** | MEDIUM | Quickstart section missing | Add to top of doc |
| **D10** | MEDIUM | No `--dry-run` flag in doc | Essential for CI; add to spec |

#### DX Scorecard

| Dimension | Score |
|---|---|
| 1. Getting started | 2/10 |
| 2. CLI ergonomics | 3/10 |
| 3. Error messages | 2/10 |
| 4. Documentation | 4/10 |
| 5. Escape hatches | 2/10 |
| 6. Debuggability | 3/10 |
| 7. Discoverability | 4/10 |
| 8. Upgrade safety | 8/10 |
| **Overall** | **3.5/10** |

Architecture is strong; developer surface is "read the source." Most
fixes are <30 min of writing but must be done BEFORE the 1100 LoC
implementation.

---

### Cross-Phase Themes

Three concerns surfaced in 2+ phases independently — high-confidence
signal:

**Theme 1 — Replay-test is structurally broken as designed.** Flagged
by CEO (Premise 3), Eng (E4), and the doc itself (Open Q2). Dry-mode
is the only feasible default.

**Theme 2 — Schema lives in the doc, not in code.** Flagged by Eng
(test gaps for synthesizer determinism) and DX (D4). Load-bearing for
both failure debugging and developer onboarding.

**Theme 3 — P1.1 URL registry duplicated, not unified.** Flagged by
CEO (C4) and confirmed against TODOS.md. Building separately creates a
future migration.

---

### USER CHALLENGES (require explicit approval)

**Challenge 1 — Scope: full skill graph vs. URL row alone**

- **RESOLVED — option A (full Skill Promoter).** User confirmed
  conviction play: institutional memory is the moat; first-time signup
  volume across a growing user base justifies the cache even if
  individuals don't repeat. ~2200 LoC realistic effort; ~6 weeks of P3
  deferral accepted.
- **Subagent recommended:** ship P1.1 alone (~150 LoC) as 0.7.0; measure
  repeat-provision rate; defer full graph.
- **Override rationale:** strategic moat + training-data harvester +
  multi-credential path (0.8.0) all depend on the full schema landing
  now. Premise 1 (institutional memory) is the user's pre-existing
  TODOS.md direction, not a new bet.

**Challenge 2 — Schema: separate vs. unified table**

- **RESOLVED — option A (unified table with `tier` discriminator).**
  User confirmed. The router is the hottest endpoint; single-query
  routing wins. Promotion (skill → manifest) becomes a column flip,
  not a data move. Accept the cost of touching the shared Prisma
  model on each skill schema iteration.
- **Subagent recommended:** split tables, shared Zod base.
- **Override rationale:** "skill IS an adapter at lower confidence"
  framing is load-bearing for the doc's whole convergence narrative.
  Splitting tables breaks that abstraction. Migration churn is
  acceptable cost given the unified model.

**Challenge 3 — Replay-test default mode**

- **RESOLVED — option A (dry-mode default, `--full` opt-in).** User
  confirmed. Dry-mode catches DOM-shape failures cheaply on every
  promote; full-mode is opt-in for Stripe-class services that allow
  re-extraction. Option C (production-as-validation via confidence
  ladder) is trivially added later on top of the existing demotion
  counter — ~30 LoC if needed.
- **All subagents confirmed.**

---

### TASTE DECISIONS

| # | Decision | Recommendation | If wrong |
|---|---|---|---|
| **T1** | Promoter location (Open Q4) | ✅ RESOLVED — `apps/mcp/`, gated subcommand. Matches `/scrape` + `/skillify` mental model; captures stay local | — |
| **T2** | Backfill timing | ✅ RESOLVED — 0.7.1 chore, after one clean fresh-service promote validates the loop end-to-end | — |
| **T3** | Demoted-skill GC | ✅ RESOLVED — delete-on-successor-publish, 90-day grace. Mirrors container registry lifecycle policies. Two crons (soft-delete nightly, hard-delete weekly) | — |

---

### Implementation Tasks (aggregated across phases)

**Pre-implementation gate** (must complete before any code):

- [x] **T1 (P1)** — ✅ DONE. Premises confirmed via the 6-decision review pass; P1 accepted, P2-P4 flagged as caveats in the report.
- [ ] **T2 (P1, human: ~1 day / CC: ~2 hours)** — Measure repeat-provision rate. ⚠️ OPTIONAL after Challenge 1 resolved (option A); kept as a useful instrumentation task but no longer a scope-blocker.
- [x] **T3 (P1)** — ✅ DONE. §"Quickstart" + §"CLI surface" added to design doc (D3, D9)
- [x] **T4 (P2)** — ✅ DONE. All four Open Questions resolved through the 6-decision review pass (see "USER CHALLENGES" + "TASTE DECISIONS" in the review report).

**Phase 1 — Schema + capture integrity** (~400 LoC):

- [ ] **T5 (P1)** — `packages/adapter-sdk/src/skill.ts` with `.describe()` on every field (D4)
- [ ] **T6 (P1)** — Capture format integrity hash chain in `onboarding-capture.ts` (E1)
- [ ] **T7 (P1)** — Versioned capture format

**Phase 2 — Synthesizer** (~500 LoC):

- [ ] **T8 (P1)** — `promote-to-skill.ts` with golden-file determinism tests
- [ ] **T9 (P1)** — Structured rejection records at `corpus/skills-failed/<id>/rejection.json` (D2)

**Phase 3 — Replay engine** (~600 LoC):

- [ ] **T10 (P1)** — `replay-skill.ts` with text-match disambiguation (C3)
- [ ] **T11 (P1)** — Per-step LLM fallback writes skill-update-candidate (D6)
- [ ] **T12 (P1)** — URL is step 0 in replay graph (C7)
- [ ] **T13 (P1)** — Dry-mode replay-test default, `--full` opt-in (C2, E4)
- [ ] **T14 (P1)** — Sandboxed replay-test browser context (C12)

**Phase 4 — Registry endpoints** (~400 LoC):

- [ ] **T15 (P1)** — `POST /skills` + `GET /skills/:service` with Prisma migration
- [ ] **T16 (P1)** — `POST /skills/:id/replay-outcome` + `GET /skills/:service/replays` (D7)
- [ ] **T17 (P1)** — Atomic increment on `consecutive_failures` (E3)
- [ ] **T18 (P1)** — Rate-limit replay-outcome by account, 60/min (C9)
- [ ] **T19 (P1)** — Capture upload at publish, content-hashed sidecars (D1)
- [ ] **T20 (P2)** — Webhook on demotion (E6)

**Phase 5 — Router integration** (~200 LoC):

- [ ] **T21 (P1)** — Modify `apps/mcp/src/tools/provision-any.ts`
- [ ] **T22 (P1)** — In-process LRU cache, 5min TTL (C6)
- [ ] **T23 (P1)** — Fail-open to universal bot
- [ ] **T24 (P1)** — Propagate `provision_id` correlation ID (D8)
- [ ] **T25 (P2)** — Surface `skill_id` + `skill_version` in SignupResult (C14)

**Phase 6 — Security gates** (~150 LoC):

- [ ] **T26 (P1)** — Human-review gate for `signup_url` and `oauth_provider` changes (C11)
- [ ] **T27 (P1)** — Credential validator with sentinel field (HTTP test against service `/whoami`) (C5)

**Phase 7 — CLI** (~300 LoC):

- [ ] **T28 (P1)** — Full CLI surface (D3)
- [ ] **T29 (P1)** — Flag consistency (D3)
- [ ] **T30 (P1)** — Error taxonomy enum with distinct exit codes (D2)

**Phase 8 — Unified URL registry** (P1.1 merger):

- [ ] **T31 (P1)** — Merge P1.1 URL registry into Skill schema; KNOWN_DOMAINS becomes fallback (C4, C13)

**TODOS.md updates needed:**
- Mark P1 as "Design doc in flight; awaiting premise confirmation + repeat-provision measurement"
- Mark P1.1 as "Merged into P1's skill schema; do not implement separately"
- Add: "Replay-test default mode: dry. Full-replay is `--full` opt-in"
- Add: "Capture-format integrity hash chain required before synthesizer trusts a corpus"

---

### Status: DONE_WITH_CONCERNS

**Bottom line:** Right strategic instinct (institutional memory,
capture-and-codify, three-tier model), but ahead of its evidence (no
repeat-provision measurement) and underspecifies the developer surface
(no Quickstart, no CLI flag spec, no error taxonomy). Three of four
premises are challenged.

**Recommended action:** before any implementation, complete T1-T4
(premise confirmation, repeat-provision measurement, Quickstart, Open
Question resolution). Then implement in phase order. Realistic effort:
**~2200 LoC + ~2000 LoC tests** (2× the doc's estimate).

---

## Why this is the right shape

Three properties worth being explicit about:

1. **The promoter is a one-way pipeline.** Captures → skills → registry.
   There is no backward edge. This makes the system easy to reason about,
   easy to roll back (delete the bad skills, captures are intact), and easy
   to debug (every skill has a `source_run_ids` field pointing back to its
   provenance).

2. **The data model is the same shape at every tier.** A skill IS an
   adapter at lower confidence with mutable success metadata. This makes
   promotion (Tier 2 → Tier 3) a tooling task, not a data migration task.
   When the time comes to hand-author Stripe's adapter, we start from the
   skill that exists in the registry.

3. **The universal bot is unchanged.** This release doesn't touch the
   planner, the extractor, or the regex library. Everything new is additive
   infrastructure. If 0.7.0 ships and we hate it, removing it is a code
   delete — no rollback dance.

The forcing question I'd want answered before LGTM: **once we've shipped the
promoter, what's the first service we use it on?** I'd suggest Railway — we
have the failing case fresh, we know the path, and proving Railway can go
from 6-minute Tier-1 to 30-second Tier-2 is the demo this release needs.
