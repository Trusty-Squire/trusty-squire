# DESIGN — generalized skill steps as operator guidance

## Problem

The skill registry is the one compounding asset: a from-scratch host-driven
provision takes ~6min, and on complex composite tasks (Firebase + GCP + key
extraction) agents driving cold flail and time out. A per-service prior lifts
those toward ~100% and cuts the time. But the registry does not accumulate from
real provisions: nothing in the operate_* flow publishes, so `resolveRouteHint`
returns undefined for almost everything a vibe coder attempts, and the operator
drives the hard composite cold.

Two dead ends we are NOT taking:
- **Blind replay of `steps[]`.** A recorded skill fired step-by-step with no
  re-observation is brittle against DOM drift, timing, and anti-bot. This is why
  replay rots and the verify/demote machinery exists.
- **A bespoke "delta sheet" / new hint artifact.** It required defining "what a
  frontier agent already knows," which is not computable at production time
  (unknown prior, differs by model, drifts). Abandoned as ill-defined.

## Approach

Reuse the existing Skill `steps[]` schema and the capture → `promoteToSkill` →
registry pipeline (which already produces valid, verifier-gated Skills). Make it
work with two changes, one small and one load-bearing:

1. **Generalize the volatile fields at synthesis (small).** Apply a fixed,
   enumerable set of transforms to the fields we already know are per-run
   volatile. This is well-defined (a finite transform list), unlike guessing the
   agent's prior. Headline: the login step records the *available* providers, not
   just the one used.
2. **Consume steps as operator GUIDANCE, not blind replay (load-bearing).** Render
   the generalized steps into the operator's observation and let the host LLM
   drive from them adaptively — observe the live page, act, re-observe. The
   operator is what absorbs drift/timing/anti-bot. A generalized step is a strong
   prior; the same step fired blind is brittle. This is one-third schema,
   two-thirds consumption.

## Fix 1 — generalization transforms (synthesis-time, enumerable)

Applied in `synthesizeSteps` / `promoteToSkill`. Not a judgment call, a fixed list:

- **Login step — record the available set.** `click_oauth_button` today
  (`packages/skill-schema/src/skill.ts:93`) stores a single `provider:
  "google"|"github"` (the one used) and hard-fails to `needs_login` on replay if
  that provider has no session. Change:
  ```diff
    { kind: "click_oauth_button",
  -   provider: "google" | "github",        // the one used, hard-pinned
  +   provider: "google" | "github",        // the PREFERRED one (this run used it)
  +   available: ("google" | "github")[],   // every provider the page offered
      text_match: string }
  ```
  `available` is optional and defaults to `[provider]`, so existing skills parse
  unchanged. The operator prefers `provider`; if it has no live session it falls
  back to any other entry in `available` that does; `needs_login` only when none
  of the available providers has a session.
- **URLs — strip per-run session tokens.** `navigate`/entry URLs reduced to host +
  path, query params dropped (the `psid=` / `redirect_to=` / tenant-id class),
  gated by `isSingleUseUrl`. The synthesizer already generalizes session params
  out of the captured entry URL; extend the same pass to every `navigate` step
  and to `startUrl` (Codex flagged `startUrl` was uncovered).
- **Typed identity values — redact / parametrize.** `fill` values that carry the
  run's identity (email, name, org) become params or redactions. `scrubKnownEmail`
  exists for email; extend to a general identity-literal scrub. Secrets are
  already slot refs, never values.

## Fix 2 — consume steps as operator guidance

Today `steps[]` are consumed by the replay engine (`operate_use` / the housekeeper
verifier), which drives them blind-ish. That path stays for the housekeeper's
verification, but the OPERATOR gets the steps as guidance:

- `resolveRouteHint` (`provision-drive.ts:59`) already fetches the active skill and
  renders it into the operator's first observation via `renderSkillHint`. Widen
  that projection from the current thin summary to the **generalized steps**, as
  advisory prose ("log in with any of {google, github}; the key is on the API
  Keys page; skip the optional billing wizard").
- The operator already treats the hint as a prior, not a command (its tool
  description says "read it and …"). No change to the drive loop. The operator
  observes, adapts, and a stale step just costs a re-look, not a failure.
- `operate_use` (blind replay for the same-user local fast path) is out of scope
  here and is not fed by this work.

## Producer — capture at verified success

To have generalized steps to serve, the operate_* flow must produce the capture
`promoteToSkill` consumes, at verified success. This is the "revive capture" path
(Codex's original recommendation), now safe because the output is consumed as
guidance, not blind-replayed.

- **Hook:** `operate_finish_task kind=credentials` (`provision-drive.ts:554`).
- **Verified-success gate:** produce only when `stored_credential != null` AND
  `blocked_reason == undefined` AND a `verifyPostcondition` check passes
  (`provision-session.ts:1552`, reused on the just-extracted field). A skill from
  an unverified run poisons the registry.
- On the gate passing, run `promoteToSkill` on the capture (with the Fix-1
  generalization) and POST to `/skills` as pending-review; the housekeeper verify
  pass promotes to active on a clean replay. Fire on the awaited gate result, log
  outcome to the finish_task trail with an `[auto-promote]` prefix; never fail the
  parent provision.

```
operate_finish_task (verified success)
      │
      ├─ promoteToSkill(capture)  →  generalize volatile fields  →  POST /skills (pending-review)
      │                                                                    │
      │                                          housekeeper verify replay ─┘  → active
      ▼
resolveRouteHint → renderSkillHint(generalized steps) → operator first observation → operator drives adaptively
```

## Deliverable #1 — measurement

We have anecdote, not data, on how much the prior lifts. Log per provision
`{service, hint_present, outcome, duration_s, turns}` so hint-on vs hint-off
success rate and time-to-success become numbers, bucketed by task shape. Ship it
in the same change; let real provisions size the lift.

## Failure modes

| Path | Behavior |
|---|---|
| No skill for service | `resolveRouteHint` undefined (today's behavior); operator drives cold. No regression. |
| Preferred provider not logged in, another available one is | Operator falls back to the available provider with a session. (Today: hard `needs_login`.) This is the headline robustness win. |
| Step drifted (button moved / renamed) | Operator re-observes and adapts; the step guided the wrong lookup, costs one re-look, not a failure. |
| Per-run URL survived the scrub | Operator navigates to a dead URL. Mitigation: host+path reduction + `isSingleUseUrl` gate + a deny-test. |
| Identity literal in a `fill` value | PII in a shared skill. Mitigation: identity-literal scrub + deny-test. |
| Skill from an unverified run | Poisoned registry entry. Mitigation: the verified-success gate. |

## What already exists (reused)

| Piece | Location | Role |
|---|---|---|
| `steps[]` schema + step kinds | `packages/skill-schema/src/skill.ts` | The carrier; `click_oauth_button` gets the `available` field. |
| Step synthesis + URL param generalization | `promote-to-skill.ts` `synthesizeSteps` | Extend the existing generalization to login + all navigate steps. |
| Hint fetch + render | `resolveRouteHint` / `renderSkillHint` (`provision-drive.ts:59`) | Widen the projection to the generalized steps. |
| Verified-success check | `verifyPostcondition` (`provision-session.ts:1552`) | The producer gate. |
| Verify/promote pipeline | registry `skill-store.ts` | Pending-review → active on clean replay. Unchanged. |

## NOT in scope

- **`operate_use` blind replay.** Left as-is; not fed by this path. Not the moat.
- **Multi-credential skills.** Single credential v1.
- **Signing.** `POST /skills` ignores signatures (verifier is the trust signal);
  no signing work.
- **The composite task→multi-service mapping.** A single service's steps first;
  the 1→N task index (one task → GCP + Firebase skills) is a follow-up.

## Sequencing (corrected by eng review round 2 — Codex)

The review found the spec led with the smallest, least-impactful change (the
OAuth `available[]` field) and under-weighted the real dependency. Corrected
order, and the corrections to overstated claims:

1. **Capture is the bulk, and it does not exist yet.** `promoteToSkill` consumes
   integrity-chained onboarding **case files** (per-round inventory + html +
   extract context), NOT the lean `actionTrace`. `onboarding-capture` is not
   wired into `operate_*` (`provision-session.ts:1440`). So Fix-1/Fix-2 both
   depend on first getting a `promoteToSkill`-grade capture out of the operate_*
   flow: either persist the rich observations the operator already makes each step
   (the observation payload already carries elements/screen), or write an
   `actionTrace → OnboardingCaseFile` translator (lossy). This is the largest
   piece, not a one-liner.
2. **PII scrub is bigger than "extend `scrubKnownEmail`."** Synthesis today
   templatizes only emails + token-shaped fills (`promote-to-skill.ts:930`).
   Display names, org/project/tenant names, `text_match`, `near_text_hint`, and
   URL path segments still leak. URL generalization only drops
   `EPHEMERAL_URL_PARAM` matches (`:1196`), not all query params or path tenant
   ids; `isSingleUseUrl` lives in operator-recipes, not skill synthesis. Real new
   work, gated by deny-tests.
3. **Renderer is a rebuild, not a tweak.** `renderSkillHint` (`skill-hint.ts:57`)
   intentionally discards `click_oauth_button`, filters login clicks, caps the
   breadcrumb at 6, renders one extract hint, omits fills/selects/OTP. "Widen the
   projection to the generalized steps" is a real renderer design.
4. **THEN the OAuth `available[]` change** — schema + `synthesizeSteps` +
   replay/verify + CLI diff + renderer, not just an optional field. And it is
   often un-inferrable: post-auth captures hardcode the single `oauthProvider`
   (`promote-to-skill.ts:244`), so `available` defaults to `[provider]` unless the
   pre-OAuth page (the button menu) was captured. Small benefit until 1-3 land.

Corrections to specific spec claims:
- The verified-success gate cannot "reuse `verifyPostcondition` on the extracted
  field": that function is wired only for `kind=result` + `verify_recipe` and
  checks a recipe snapshot (`provision-drive.ts:577`). Either define a
  credentials-specific postcondition, or accept extraction+vaulting as the gate.
- The registry already serves **pending-review** skills as hints via the host
  fallback (`skills.ts:193`), by design (a hint is advisory). So "verified only"
  is stricter than the current intent; decide deliberately.

## Decisions carried from prior review

- Reuse `steps[]`, do NOT build a new `/hints` artifact (the schema is the
  carrier). The Q1 "retire the replay Skill table" idea is dropped: we are keeping
  and extending it, not replacing it.
- Generalize the volatile fields (well-defined), do NOT compute a "delta" against
  the agent's prior (ill-defined).
- Conflict of two successful runs: last-write-wins biased by measured outcome,
  deferred to the harness.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_open | round 2 re-sequenced the plan; capture dependency is the bulk |
| Outside Voice | Codex (high effort) | Independent 2nd opinion | 2 | issues_found | 8 findings; led-with-wrong-thing + capture-does-not-exist |

Round-2 findings folded: (1) `promoteToSkill` needs rich onboarding case files, not the lean `actionTrace`, and capture is not wired into `operate_*` — this is the bulk of the work, not the OAuth field; (2) `renderSkillHint` discards steps/oauth today — the renderer is a rebuild; (3) `verifyPostcondition` is not wired for `kind=credentials` — needs a credentials-specific gate or accept extract+vault; (4) PII/URL generalization is narrower than the doc implied — real new work; (5) the registry already serves pending-review skills as hints by design.

- **CODEX:** re-sequenced to capture+PII → renderer → OAuth `available[]`, and corrected four overstated "reuse" claims. Absorbed into the Sequencing section.
- **CROSS-MODEL:** the review and Codex agree the OAuth `available[]` change I led with is the least-impactful piece and should be last; the capture pipeline is the load-bearing dependency.
- **VERDICT:** Not CLEARED for implementation. The approach is sound but the sequence was wrong and the largest dependency (operator capture → case file) was under-weighted. Two decisions now open.

**UNRESOLVED DECISIONS:**
- R2-a — Capture approach: persist the rich per-step observations the operator already makes as onboarding case-file rounds, vs. write a lossy `actionTrace → OnboardingCaseFile` translator. Decides the bulk of the work.
- R2-b — Hint trust gate: serve only verified (active) skills as hints, vs. keep the current design that also serves pending-review skills advisorily. The code currently does the latter.
