# DESIGN — operator hints: feed the live operator a map, not a script

## Problem

On complex, long-range provisions (the auth-setup composite: Firebase + GCP
console + key extraction; multi-console chains) agents driving cold flail and
time out. With a per-service hint, field experience is that success climbs toward
~100% and time-to-success drops sharply. On trivial signups (basketball.dev, no
adversarial surface) agents already succeed ~100% with or without a hint, so the
hint adds nothing there.

The hint mechanism already exists and already works. `resolveRouteHint`
(`provision-drive.ts:59`) asks the registry for the service and folds
`renderSkillHint(skill)` into the operator's first observation: login method,
where the key lives, how many credentials.

But it is starved. `renderSkillHint` reads a published **active Skill**, and the
operate_* flow publishes nothing (the auto-promote path died with the autonomous
bot; only operator/housekeeper-curated skills exist). So for almost everything a
vibe coder actually attempts, `resolveRouteHint` returns undefined and the
operator drives the hard composite cold. "The registry is not accumulating" and
"hints are missing on the hard tasks" are the same severed pipe.

## What this is NOT (and why)

This is **not** blind replay. A recorded skill that re-fires "click this target,
type, click" without re-observing is structurally brittle against exactly our
adversaries: DOM drift (the target moved), timing (the element was not
interactive yet), and anti-bot (machine-speed no-look clicking is itself a tell).
Replay buys ~30s by deleting the observe-and-pace loop that makes a from-scratch
provision robust. The verify-and-demote machinery exists because replayed skills
rot. We are not reviving that.

We keep the live operator in the loop (it handles drift, timing, anti-bot) and
give it a **prior**. A stale hint degrades (one wasted look); a stale script
breaks. The objective function is the probability the provision completes, and a
90%-success / 90s operator-with-hints beats a 40%-success / 30s blind replay on
that metric. Reliability is the moat, and it concentrates on the composite tasks
where competitors' agents also fail.

## The hint resolution (the load-bearing design)

A hint must be specific enough to remove exploration cost, vague enough to
survive drift. The resolution rule that threads this: **split specificity by
axis, because the operator validates every hint live.**

```
                 SPECIFIC  ───────────────────────────────►  drift-exposed
  SEMANTIC axis  │ "key is under APIs & Services →            (wrong = one
  (location +    │  Credentials, grab the auto-created        wasted look,
   decisions)    │  browser key; use Google login;           operator re-
                 │  skip the billing wizard"     ◄── DEFAULT  observes)
                 │
  MECHANISM axis │ recalled selector / element id,  ◄── TIE-BREAK ONLY
  (how to act)   │  tagged "as of last run, verify":         (matches a live
                 │  rank CURRENTLY-VISIBLE candidates,        candidate → use;
                 │  never conjure a non-visible target;       no match → drop;
                 │  no coordinates / timing / microcopy       never a silent misclick)
```

- **Be as specific as useful on the SEMANTIC axis.** Which auth method works,
  the named section the credential lives in, the credential's shape, which
  optional detour to skip, the ordered sub-goals of a composite chain. The
  operator re-observes, so a wrong semantic hint costs one re-look, not a
  failure. This is where the exploration cost on composites actually lives.
- **Mechanism is allowed only as a disambiguate-only tie-breaker.** A recalled
  selector / element identity may *rank* among the candidates the operator
  CURRENTLY observes; it may NEVER justify acting on a target that is not
  currently visible. The detail ranks candidates, it never creates them. So a
  stale mechanism hint costs nothing (it matches no live candidate and is
  dropped), while a valid one instantly resolves an ambiguous click (icon-only
  button, repeated label). This is safe because the host LLM operator observes
  and judges before acting, unlike the blind executor that made replay brittle.
  Carry every mechanism field tagged "as of last run, verify". **Drop coordinates
  outright** (they drift with viewport/layout and carry no semantic value to rank
  with). Never store timing, exact microcopy, or per-account / single-use URLs.
  Note: selectors can embed per-account ids (`id="user-12345-row"`), so they
  widen the scrub surface (see producer).

Mental model: a hint is what a knowledgeable human says over your shoulder. It
names landmarks and decisions, never keystrokes. The operator owns perception and
actuation; the hint owns the map.

### Why the lean trace is already close to the right resolution

The operate_* trace targets by **visible text** (`text_match`), not selectors
(`recordTrace`, `provision-session.ts:1458`). So it is already on the semantic
axis. The producer's job is to (a) drop the residual mechanism leakage
(per-account URLs, run-specific label literals), and (b) collapse the per-click
trace into landmark sub-goals. We are demoting an artifact that was over-built for
replay, not inventing a new capture system.

## Hint schema

A hint is a **delta sheet, not a manual** (decision Q2). A frontier agent already
knows the general procedure ("to add Google login you set up Firebase Auth and
enable the Google provider") from training + web search, and re-narrating it back
does not help execution anyway — what trips the agent on a live page is "where is
the button now," which observation handles. So the hint stores only what a smart
agent would not already know or would get wrong:

```jsonc
ServiceHint {
  service: "firebase",                    // slug
  auth: { method: "google_oauth",         // which path survives (empirical, time-specific)
          note: "email signup hits the anti-bot wall; use Google" },
  credential: {
    location: "Project Settings → General → Web API key",   // where it lives in the CURRENT UI
    shape: "AIzaSy… ~39 chars",                              // so the agent knows it when it sees it, and stops
    names: ["web_api_key"]
  },
  gotchas: [                               // the delta sheet — traps + ordering, NOT a procedure
    "skip the billing setup wizard, it is optional (wizard-budget-exhaustion trap)",
    "create the GCP project before the Firebase step or the provider enable dead-ends"
  ]
}
```

There is deliberately NO ordered `steps[]` procedural map: the agent supplies the
procedure from its own knowledge; the registry supplies the corrections. Every
field is semantic and advisory. No selectors, no coordinates, no per-account
URLs.

**Caveat (measured, not designed-around):** the model's prior is frozen at its
training cutoff, so a procedure it confidently remembers can be stale. That is
still a *delta* (a correction in `gotchas`), not a reason to store a map. It just
means deltas matter more for high-UI-churn services — a bucket for the harness,
not a schema change.

## Components

### Producer — `synthesizeHint(session, extracted)` (NEW)

At verified success (see below), build a `ServiceHint` from the lean trace plus
the extraction result. Generalization rules, applied here:

- **Auth method** from which OAuth/email path the trace actually took. Auto-
  extractable from a single success.
- **gotchas are NOT cleanly extractable from one success.** A successful run does
  not announce "I skipped the wizard" or "the provider enable dead-ended until I
  created the GCP project first." So gotchas come from two harder sources, not
  from naive trace collapse: (a) the operator surfacing them when it recovers
  from a dead-end (it knows it backtracked), and (b) failure-vs-success diffing
  over accumulated runs (which the measurement harness already logs). v1 emits
  auth + credential automatically; gotchas start empty and fill from (a)/(b).
  This is the honest hard part of the producer.
- **URL scrub** on anything stored (credential.location pages, any recalled URL):
  reduce to host + path, strip all query params (`psid=` / `redirect_to=` /
  tenant-id class), and gate with `isSingleUseUrl` (Codex flagged `startUrl` was
  not covered). Extend `scrubKnownEmail` to a general identity-literal scrub.
- **credential.location** from where `operate_extract` found the key (the field
  label / page), `shape` from the extracted value's prefix + length (never the
  value), `names` from the store keys.
- **Mechanism tier (optional, A/B-gated, off by default)** — when emitted, attach
  to a step the recalled stable selector / element identity (never coordinates),
  scrubbed of per-account ids, tagged with the run date. The measurement harness
  gates it on; consumed under the disambiguate-only rule above.

### Consumer — `renderSkillHint` → `renderServiceHint` (CHANGE)

`resolveRouteHint` already wires the fetch. Point it at the hint record and
render the `ServiceHint` into the operator's first observation as advisory prose.
The operator already treats the hint as a prior, not a command (the tool
description says "read it and …"), so no behavior change to the loop.

### Registry — a hint-only artifact (NEW, the main net-new infra)

`POST /skills` stores replay Skills and gates on `validateReplayGraph`. A
`ServiceHint` is not a replay graph and would be rejected. Decision needed
(open question Q1): either (a) a new lightweight `hint` record type + `GET/POST
/hints/:service` + store, or (b) relax the Skill model to accept a hint-only
entry with no replay steps. (a) is cleaner and keeps the brittle replay path out
of the way; it is the bulk of the new server work.

### Verified-success hook

`operate_finish_task kind=credentials` is the hook, but Codex is right that it is
not currently a verified success: it extracts + vaults + closes, with no
postcondition check. Add: a hint is produced only when `stored_credential != null`
AND `blocked_reason == undefined` AND a `verifyPostcondition`-style check passes
(`provision-session.ts:1552` already exists; reuse it on the just-extracted
field). Producing a hint from an unverified run would poison the map.

## Deliverable #1 — measurement, before investment

We have a believed mechanism with strong anecdotes on hard tasks and **no data**
(the sample is too thin to quantify the lift). So the first thing built is the
instrumentation, in the same change as the producer:

- Log per provision: `{service, complexity, hint_tier: none|semantic|
  semantic+mechanism, outcome: success|fail, duration_s, turns}`.
- This yields hint-on vs hint-off success rate and time-to-success, bucketed by
  task complexity, so the lift becomes a number. Feed the pipe and measure it
  together; let the accumulating real provisions tell us how much to invest in
  richer hints.
- **First A/B: the mechanism sublayer.** Ship semantic-only as the default, then
  A/B add the disambiguate-only mechanism tier and measure whether it lifts
  success/time or drags the operator toward stale targets. This settles, with
  data, the open argument over whether recalled selectors help or anchor — rather
  than guessing. `hint_tier` is the A/B arm.

```
ServiceHint produced ──► registry ──► resolveRouteHint ──► operator first observation
        ▲                                                         │
        │ synthesizeHint(session, extracted)                      │ drives live (observes,
        │ at verified success                                     │ paces, handles drift)
  operate_finish_task ◄──────────────────────────────────────────┘
        │
        └─ provision-outcome log {complexity, hint_present, success, duration} ──► lift metric
```

## Failure modes

| Path | Behavior |
|---|---|
| No hint for service | `resolveRouteHint` returns undefined (today's behavior); operator drives cold. No regression. |
| Stale hint (section moved) | Operator re-observes, the named landmark is gone, it explores that one step. Degrades, not breaks. |
| Hint carries a per-account URL that slipped the scrub | Operator navigates to a dead tenant URL. Mitigation: landmark_path is host+path only + `isSingleUseUrl` gate; deny-test on the producer. |
| Hint produced from an unverified run | Poisoned map served to the next user. Mitigation: the verified-success gate above. |
| Identity literal (name/org) in a step label | PII in a shared record. Mitigation: identity-literal scrub in `synthesizeHint`; deny-test. |
| Service with no non-obvious delta | Producer would emit an empty/trivial hint, no lift. Mitigation: emit nothing when auth is the obvious default AND the key is at the obvious place AND there are no gotchas. A hint exists only when it carries a real delta. This replaces the old `simple/composite` gate (Q2). |

## NOT in scope

- **Blind replay / `operate_use` / full replay `Skill` production.** Set aside as
  not-the-moat and structurally brittle. Not removed, just not fed by this path.
- **`promoteToSkill` / onboarding-capture corpus.** The hint does not need
  capture rounds or `SkillStep` synthesis. Left for the housekeeper's own use.
- **Multi-credential hints.** v1 single credential; the schema allows `names[]`
  but the producer emits one.
- **Signing.** `POST /skills` ignores signatures (the verifier is the trust
  signal); a hint endpoint inherits the same posture. No signing work.

## What already exists (reused)

| Piece | Location | Role |
|---|---|---|
| Hint fetch + inject | `provision-drive.ts:59` `resolveRouteHint` | Already wires registry → operator first observation. |
| Hint render | `renderSkillHint` | Projects a record into operator prose; re-target to `ServiceHint`. |
| Semantic trace | `recordTrace` `provision-session.ts:1458` | Targets by visible text, already on the semantic axis. |
| Email scrub + single-use gate | `scrubKnownEmail:1443`, `isSingleUseUrl` | Extend to general identity + landmark URLs. |
| Postcondition check | `verifyPostcondition:1552` | Reuse as the verified-success gate. |
| Extraction | `extractCredentials` | Source of `credential.location/shape/names`. |

## Decisions (resolved 2026-06-30)

- **Q1 — dedicated `/hints` record + store, NOT a hint-only Skill entry.**
  Retiring the replay path is a **strangler, not a delete**: the Skill table is
  the *current* hint source (`renderSkillHint`) and the housekeeper still uses it.
  Order: (1) build `/hints` + store, (2) migrate hint-relevant fields out of the
  curated active Skills into `/hints`, (3) repoint `resolveRouteHint` at `/hints`,
  (4) confirm hints still serve, (5) THEN retire the Skill table, onboarding-
  capture corpus, `promoteToSkill`, and `operate_use`. Retiring before step 4
  blanks the live hint path and breaks the housekeeper.
- **Q2 — delta sheets, not procedural maps; the task→hint MAPPING is the real
  work.** No fat `steps[]` (above). The harder, first-class piece this surfaces:
  `resolveRouteHint` today keys off ONE service URL slug, but a composite task
  ("add Google login") has no single URL — it decomposes across GCP + Firebase +
  the app. So a **task → hints index** that recognizes intent and returns the
  right delta sheet per leg is needed, and it is bigger than the hint storage. The
  old `simple/composite` labeling question dissolves: a hint exists only when it
  carries a real delta (see failure modes), so there is nothing to gate on
  complexity.
- **Q3 — last-write-wins biased by measured outcome, deferred.** Reconciliation
  of two disagreeing successful runs waits until the harness (deliverable #1) is
  logging success/time, so "better measured outcome" is a real signal.

## Components (additional)

### Task → hint index (NEW, the Q2 work)

Recognize the provisioning task's intent and the host(s) the operator is on, and
return the delta sheet(s) for each leg. For a single-service signup this is the
current URL-keyed lookup. For a composite it is a 1→N mapping (one task → hints
for GCP + Firebase). This is the larger build the delta-sheet decision pulls
forward; the storage is the easy half.

## Review outcome (plan-eng-review + Codex, 2026-06-30)

This spec is a rewrite. The prior version ("auto-promote the operator-recipe to
the registry as a replay Skill") was wrong on its core premise. The eng review +
the Codex outside voice established:

- `OperatorRecipe` ≠ registry `Skill`; `POST /skills` consumes a `Skill`
  synthesized by `promoteToSkill` from capture rounds, and no Recipe→Skill
  converter exists. The recipe is lossier than capture rounds.
- `POST /skills` has no auth gate and ignores signatures; the verifier is the
  only trust signal, so it protects replay quality, not PII.
- Replay brittleness (operator field experience) is structural, not a fixable
  bug: blind replay deletes the observe/pace loop that handles drift, timing,
  and anti-bot.

The resolution of all three: stop producing replay Skills. Produce lightweight
**hints** for the live operator instead, at the resolution defined above, and
measure the lift before investing further.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | core premise wrong → full rewrite; 6 findings folded |
| Outside Voice | Codex (high effort) | Independent 2nd opinion | 1 | issues_found | found the Recipe≠Skill schema gap + no-auth POST /skills + replay lossiness |

Findings folded into the rewrite: (1) `OperatorRecipe` ≠ registry `Skill`, no converter — pivoted off replay Skills entirely; (2) `operate_finish_task kind=credentials` is not a verified success — added a `verifyPostcondition` gate; (3) PII scrub only covers email — added identity-literal scrub + deny-test; (4) `entry_url`/`startUrl` instability — landmark URLs are host+path only behind `isSingleUseUrl`; (5) fire-and-forget vs reported outcome contradiction — produce on the awaited verified gate, log separately; (6) replay brittleness is structural (operator field evidence) — blind replay set out of scope.

- **CODEX:** surfaced the load-bearing schema gap the first-pass review missed; its recommendation (don't build a Recipe→Skill translator) was absorbed and then superseded by the hint reframe (produce neither a recipe nor a Skill).
- **CROSS-MODEL:** first-pass review favored promoting the recipe; Codex favored reviving capture for `promoteToSkill`; the user's field evidence on replay brittleness overrode both — the artifact is a hint, not a replay script.
- **VERDICT:** ENG review complete, spec rewritten and self-consistent, all 3 open decisions resolved (Q1 dedicated `/hints` + strangler retirement of the replay Skill path; Q2 delta sheets not maps, with the task→hint index as the real build; Q3 last-write-wins biased by measured outcome, deferred). Ready to scope implementation — the task→hint index is the largest piece, gotcha extraction is the honest hard part.

NO UNRESOLVED DECISIONS
