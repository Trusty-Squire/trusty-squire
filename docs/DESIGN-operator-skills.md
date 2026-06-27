# DESIGN — User-saved operator workflows as skills

**Status:** Phase A (thin local MVP) locked via `/plan-eng-review` (2026-06-27).
Phase B (registry/schema integration) deferred with rationale below.

## Problem

The operate surface (`operate_*`) can drive arbitrary credential-gated, often
multi-console tasks — proven end-to-end this session: "add Google OAuth" (create
a GCP OAuth client, seal the secret, carry it into the OAuth Playground, get a
token) and a project teardown. But every run re-plans from scratch (~minutes,
many LLM calls). Signups already have a closed loop that fixes this — a success
is captured, synthesized into a Skill, and replayed in ~30s. Operator workflows
have no such loop.

**Thesis:** let a user save a *successful* operator run as a replayable skill by
asking the Squire to remember it (gamut.co-style: teach once, replay), explicitly
triggered (`operator remember <name>`), recalled by name (`operator use <name>`).

**Why this beats building Phase 2's composable recipe layer now:** you can't
design a composition abstraction from N=1. User-saved workflows let recipes
*accumulate from real runs*; the abstraction reveals itself later. And it
**dissolves the two-thesis tension** — a saved operator workflow IS a skill, so
operator runs FEED OF#1 (active-skill count) instead of competing with it.

## The two genuinely novel parts (everything else is reuse)

1. **Postcondition-verify.** Today's Skill schema has NO postcondition — a signup
   skill just ends when a key is extracted (success == a key came out). An operator
   workflow ("add Google OAuth") needs an explicit, machine-checkable success
   signal or replay silently "succeeds" on a run that didn't work — the
   anti-false-green principle (`isCredentialNoise` / `no_legit_credential`) one
   level up. Two kinds, both proven this session:
   - `execute_capability` — re-run the capability and observe (drove the OAuth
     login → token, synchronous).
   - `observe_artifact` — poll an external surface until present (e.g. the app on
     the Play listing; async, would ride the paced verifier in Phase B).
2. **Rail-replay on a churny SPA.** Operator targets are heavy SPAs (the GCP
   console) whose refs/DOM churn every observation (we hit stale-ref errors and
   generation-advancing refs all session). Literal click/coordinate playback
   would rot in days.

## What's already built (reuse, do not rebuild)

| Need | Existing piece |
|---|---|
| Text-based, redesign-survivable targeting | `skill.ts` — every step targets DOM by `text_match`/`label_hint`/`near_text_hint`/`role_hint`, "never raw CSS selectors. 'Create Token' survives a Tailwind migration." The rail-vs-playback call is already settled in the schema's favor. |
| The rail itself | `skill-hint.ts:renderSkillHint` — emits *"a MAP, not a script. Drive toward it; fall back to your own judgment if the live page diverges."* injected at `operate_start`. The operator-recipe rail is a direct analog. |
| Sealed transfer | `provision-session.ts` — `extract{into_slot}` → session slot → `type_secret`; value never leaves the browser/MCP boundary. Validated end-to-end this session. |
| Session action audit | the `provision-audit` markers per action (extend to retain a replayable trace). |

## Architecture decisions (resolved)

- **Rail, not playback** — inherit the schema's text-targeting + the
  `renderSkillHint` "MAP not script" mechanism. Replay = the host planner
  re-drives toward the goal using the trace as steering, NOT graph-replay through
  `replay-skill.ts` (which treats `navigate` as a hard nav with "no SPA
  soft-navigation handling" — exactly what bit us on the GCP console).
- **No shared-schema change in Phase A** — the operator-recipe is its OWN local
  artifact, not a `Skill`. Avoids the major `schema_version` bump that new step
  kinds (`allow_host`, `type_secret`, `verify_postcondition`) would force on a
  closed discriminated union, before the shape is proven.
- **Named recall, no goal-matching** — `use <name>` is explicit. Goal→skill
  auto-matching is deferred (Phase B).
- **Postcondition is the anti-false-green gate** — replay confirms ONLY if the
  captured success_signal holds; else it falls back to the universal planner,
  same as a signup skill falls back to the bot on a rail-miss.

## Data flow

```
  REMEMBER (after a successful operate run)
  ┌──────────────────────────────────────────────────────────────┐
  │ operate session (live)                                        │
  │   • retained action trace (text-targeted, sealed-slot refs)   │
  │   • host declares: goal + postcondition                       │
  └───────────────┬──────────────────────────────────────────────┘
                  │  operate_remember{ name, goal, postcondition }
                  ▼
        ~/.trusty-squire/operator-recipes/<name>.json
        { goal, allowed_hosts, trace[], secrets[slot-refs only], postcondition }

  USE (next time)
  ┌──────────────────────────────────────────────────────────────┐
  │ operate_use{ name } → operate_start with rail hint            │
  │   renderOperatorRecipeHint(recipe) → "MAP not script"         │
  │   host re-drives toward the goal (planner-on-rails)           │
  │   sealed steps replay THROUGH extract{into_slot}/type_secret  │
  └───────────────┬──────────────────────────────────────────────┘
                  ▼
        verifyPostcondition(session, recipe.postcondition)
          execute_capability → re-run+observe   observe_artifact → poll
                  │
          confirmed? ── yes ──▶ result{confirmed:true, evidence}
                  └── no ──────▶ fall back to universal planner (no false-green)
```

## The operator-recipe artifact (local, Phase A)

`~/.trusty-squire/operator-recipes/<name>.json`:

```jsonc
{
  "name": "add-google-oauth",
  "schema_version": 1,
  "goal": "Create a Google OAuth web client and prove it issues a token",
  "allowed_hosts": ["console.cloud.google.com", "developers.google.com", "accounts.google.com"],
  "trace": [
    { "intent": "open GCP credentials", "action": { "kind": "goto", "url_template": "https://console.cloud.google.com/auth/clients/create?project=${PROJECT}" } },
    { "intent": "pick Web application type", "action": { "kind": "click", "text_match": "Web application" } },
    { "intent": "add Playground redirect URI", "action": { "kind": "type", "target_text": "URIs", "value": "https://developers.google.com/oauthplayground" } },
    { "intent": "create the client", "action": { "kind": "click", "text_match": "Create" } },
    { "intent": "mint + seal the client secret", "action": { "kind": "extract", "into_slot": "oauth_secret", "value_pattern": "^GOCSPX-" } },
    { "intent": "cross into the Playground", "action": { "kind": "allow_host", "host": "developers.google.com" } },
    { "intent": "type the sealed secret", "action": { "kind": "type_secret", "slot": "oauth_secret", "target_text": "OAuth Client secret" } },
    { "intent": "authorize + exchange", "action": { "kind": "click", "text_match": "Authorize APIs" } }
  ],
  "secrets": [ { "slot": "oauth_secret", "sealed_from": "GCP client secret", "stored": false } ],
  "postcondition": {
    "kind": "execute_capability",
    "describe": "Playground issues an access token after consent",
    "success_signal": { "field_text": "Access token", "min_value_len": 40 }
  }
}
```

- **trace** = intent + text-based target (no refs, no coordinates) → survives SPA churn.
- **secrets** = slot references only; raw values NEVER written to disk.
- **postcondition** = explicit + machine-checkable.
- `${PROJECT}` / `${EMAIL_ALIAS}` style templates parameterize per-run identity.

## Scope — Phase A (build now)

Files (kept to ~4, under the complexity smell threshold):

1. `apps/mcp/src/bot/operator-recipe.ts` (new) — recipe Zod schema, local read/write
   (`~/.trusty-squire/operator-recipes/`), `renderOperatorRecipeHint`,
   `verifyPostcondition` (pure where possible).
2. `apps/mcp/src/bot/provision-session.ts` — retain a per-session action trace;
   `rememberRecipe(session, name, goal, postcondition)`; `verifyPostcondition`
   driver (execute_capability re-run / observe_artifact poll).
3. `apps/mcp/src/tools/provision-drive.ts` — `operate_remember{name, goal,
   postcondition}` (or `remember_as` on `operate_finish_task`) + `operate_use{name}`
   (start with the rail) + postcondition check folded into the terminal.
4. `apps/mcp/src/bot/__tests__/operator-recipe.test.ts` — recipe round-trip;
   `renderOperatorRecipeHint` shape; `verifyPostcondition` pass/fail (pure); the
   **iron test**: sealed-slot refs persist but raw secret values NEVER appear in
   the written recipe.

**Acceptance:** `operate_remember` the GCP OAuth trace (already captured this
session) → `operate_use add-google-oauth` on a fresh project → reaches a token →
postcondition confirms. A rail-miss falls back to the planner with no false-green.

## Test plan

- Pure: recipe parse/round-trip; hint render is a "MAP not script" breadcrumb;
  postcondition `execute_capability` confirms only on a real success_signal;
  `observe_artifact` confirms only when the artifact is present.
- Security iron test: a recipe built from a session that sealed a secret stores
  the SLOT ref, and the raw value appears nowhere in the JSON.
- E2E (manual, one task): GCP add-Google-OAuth remember → use → token + confirm.

## Deferred — Phase B (with rationale)

Graduate the proven shape into the closed loop ONLY after Phase A holds — at which
point the right step kinds + postcondition format are KNOWN, so the schema bump is
confident, not a guess.

- **Shared-schema step kinds** (`allow_host`, `type_secret`, `verify_postcondition`)
  + the major `schema_version` bump.
- **Synthesizer generalization** — `promote-to-skill.ts` past signup vocabulary
  (operate ProvisionAction → SkillStep), or a parallel operator-skill synthesizer.
- **Registry skill kind** + publish/verify path for operator skills.
- **SPA-soft-nav handling** in `replay-skill.ts` (or migrate signups to the
  planner-on-rails path so there's one replay model, not two).
- **Goal-keyed matching** — match a request's goal to a saved skill (vs signup's
  service-URL keying). Embedding similarity or an explicit goal registry.
- **Replay-success telemetry + auto-demotion** for operator skills (mirror the
  signup `replays_succeeded/failed` + `VERIFIER_FAILURE_THRESHOLD`).

## Open questions (resolved-for-A / deferred-to-B)

| Question | Phase A answer |
|---|---|
| Capture-postcondition format | explicit `{kind, describe, success_signal}` on the recipe; host declares it at remember-time. |
| Rail-replay vs playback boundary | rail only (text-targeting + render-hint); no literal playback ever. |
| Synthesizer generalization | none in A — local recipe, no synthesizer; B decides extend-vs-parallel. |
| Replay telemetry + auto-demotion | none in A (local, single user); B. |
| Goal→skill matching | named recall in A; goal-matching is B. |
