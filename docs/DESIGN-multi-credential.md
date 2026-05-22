# Multi-Credential Extraction — Design Doc

**Status:** Draft  
**Scope:** 0.7.x follow-on, additive to the Skill Promoter (`docs/DESIGN-skill-promoter.md`)  
**Author:** Bento  
**Premise:** Some SaaS signups emit *multiple* credentials. Twitter is the canonical case (5 keys: API Key, API Key Secret, Bearer Token, Access Token, Access Token Secret). Stripe ships publishable + secret. OpenAI emits org ID + project ID + API key. The bot and skill registry today assume one extracted credential per service.

---

## TL;DR

The schema is already an array (`Skill.credentials: SkillCredentialSpec[]`) — that part is sound. Every layer above and below the schema assumes single-cred: the planner prompt, the synthesizer, `ReplayOutcome.ok.credential: string`, the vault write, the post-verify loop's `extractCredentials()`.

The risk of changing all those layers to be multi-aware is **regression of the single-credential signups that work today** (Railway, Postmark, IPInfo, OpenRouter, Sentry, …). Even tiny prompt changes can drift the LLM on existing pages.

**Design principle: side-by-side dispatch, not type-union expansion.**

- New step kinds (`extract_via_copy_button_named`, `extract_via_regex_named`) — old kinds untouched.
- New outcome variant (`ok_multi`) — old variant untouched.
- New planner action shape (`extract_named`) — old action shape untouched.
- Synthesizer branches on capture content (`>1 extract round → multi path, else → single path`).

Plus a **planner shadow-test harness** in CI that replays the existing single-cred capture corpus against every new prompt version and fails if any single-cred page emits the multi action shape.

Three weeks of work, gated so single-cred regressions can't slip past CI.

---

## The actual regression risk

Where does regression creep in if we naively expand the existing single-cred path to handle multi?

1. **Planner prompt drift.** Today the post-verify planner emits `{kind: "extract"}` when it sees a credential. If the prompt is changed to "extract each credential by label", an LLM on a single-cred Railway page could:
   - Treat the user's email + the API key as two credentials and emit two extract actions
   - Misread a field label and emit `{produces: "secret_key"}` when there's only an api_key
   - Stay in the extract loop looking for a second credential that doesn't exist
2. **Step canonical bytes.** Skills are signed over canonical JSON. Adding a field to `extract_via_copy_button` — even an optional one with a default — changes the canonical bytes of every existing skill that gets re-canonicalized through the new schema. Signature mismatch → registry rejects valid old skills.
3. **Synthesizer drift.** If the synthesizer learns "if multiple extract rounds → multi-cred", a captured run with a stray retry-extract round could be classified as multi. False positives are catastrophic: they change `credentials[]` from one to many, breaking vault writes downstream.
4. **Vault write semantics.** Today: one extracted value lands at one env var. If multi-cred is atomic ("all five or none"), the single case becomes "atomic bundle of 1" — same write, different failure mode. A retry on a partial write of one credential could land in a different state under the new code path.
5. **Bot post-verify loop assumes `api_key`.** `extractCredentials()` returns `{api_key?: string, username?: string}`. If we make it return `Record<string,string>`, every caller in the bot stops compiling, and any silent coercion (e.g. `cred.api_key ?? ""`) becomes a latent bug.

Items 1 and 3 are LLM behavior — type systems can't catch them. Items 2, 4, 5 are mechanical and can be contained by the right code shape.

---

## Design principle: side-by-side dispatch

The cheapest way to make single-cred immune to multi-cred changes is to give multi-cred a **parallel set of types** at every boundary, so the compiler enforces "decide which path you're on" at every dispatch point.

Concretely:

| Boundary | Single path (untouched) | Multi path (new) |
|---|---|---|
| Skill step kinds | `extract_via_copy_button`, `extract_via_regex` | `extract_via_copy_button_named`, `extract_via_regex_named` |
| Planner action shape | `{kind: "extract"}` | `{kind: "extract_named", credential_label, produces}` |
| Bot extract result | `{api_key?, username?}` (today's shape) | `Record<string,string>` keyed by `produces` |
| Replay outcome | `{kind: "ok", credential: string}` | `{kind: "ok_multi", credentials: Record<string,string>}` |
| Vault write | `vault.writeCredential(env_var, value)` | `vault.writeCredentialBundle({env_var → value})` |
| Validator (per-cred) | `post_extract_validator` (unchanged) | `post_extract_validator` per-cred + optional `bundle_sentinel` at Skill level |

Every callee of these boundaries handles both branches explicitly via discriminated unions; the compiler refuses to merge them silently.

**Backward compatibility:**

- Every existing single-cred skill keeps replaying byte-identically. Its `extract_via_copy_button` steps don't get touched.
- A skill with one credential never enters the multi-path code at any layer. The synthesizer's branch condition (`captures contain more than one extract round AND credentials extracted have distinct labels`) gates entry.
- The planner emits the new action shape *only* when triggered by visible page features (multiple Copy buttons OR multiple credential-shaped strings labeled with distinct phrases like "key" + "secret"). On a Railway-class single-cred page, the trigger never fires.

**Cost:** code duplication at the dispatch boundaries. Both paths share the deep helpers (`extractCredentialCandidates`, `extractApiKeyFromText`, `tryCopyButtonExtraction`) but have separate executors. Worth it for the safety budget.

---

## Schema additions

All optional/additive. Existing skills validate unchanged.

### 1. Named credentials in `SkillCredentialSpec`

```ts
SkillCredentialSpec {
  // NEW: stable identifier within this skill. Lowercase snake_case.
  // For single-cred skills, defaults to "api_key" on read if absent
  // (preserves canonical bytes of existing skills).
  name?: string

  // Existing fields untouched:
  type: "api_key" | "oauth_token" | ...
  shape_hint: ...
  env_var_suggestion: ...  // "TWITTER_API_KEY_SECRET" etc.
  post_extract_validator: ...
}
```

The `name` field is the stable key extract steps reference. Twitter's `credentials[]`:

```json
[
  { "name": "api_key",            "env_var_suggestion": "TWITTER_API_KEY",            ... },
  { "name": "api_key_secret",     "env_var_suggestion": "TWITTER_API_KEY_SECRET",     ... },
  { "name": "bearer_token",       "env_var_suggestion": "TWITTER_BEARER_TOKEN",       ... },
  { "name": "access_token",       "env_var_suggestion": "TWITTER_ACCESS_TOKEN",       ... },
  { "name": "access_token_secret","env_var_suggestion": "TWITTER_ACCESS_TOKEN_SECRET",... }
]
```

### 2. New extract step kinds

```ts
SkillStep =
  | { kind: "navigate", ... }              // unchanged
  | { kind: "click", ... }                 // unchanged
  | { kind: "extract_via_copy_button", near_text_hint }       // unchanged
  | { kind: "extract_via_regex", pattern_name }               // unchanged
  | { kind: "extract_via_copy_button_named",                  // NEW
      near_text_hint: string,
      produces: string }   // references credentials[].name
  | { kind: "extract_via_regex_named",                        // NEW
      pattern_name: string,
      produces: string }
```

Old kinds remain. New kinds only appear in multi-cred skills. Same `produces` value can never appear twice in one skill (schema enforced).

### 3. Skill-level bundle sentinel

```ts
Skill {
  ...
  // NEW: optional. When present, replay validates by signing a
  // single HTTP request with the named credentials. Replaces
  // per-credential sentinel checks for the multi case — Twitter's
  // keys are only useful as a set.
  bundle_sentinel?: {
    url: string                    // e.g. "https://api.twitter.com/2/users/me"
    auth_scheme: "oauth1_signed"   // sigv4 / oauth2_bearer_plus_secret etc.
                                   //  added per service as needed
    required_credentials: string[] // names of credentials that must
                                   //  all be present to make the call
    timeout_ms: number
  }
}
```

The schema accepts but does not require this for multi-cred skills. A skill without a bundle sentinel falls back to per-cred shape validation (cheap, less precise).

### Why this preserves single-cred byte-equivalence

- Existing skills don't have a `name` on `credentials[0]` → reader defaults to `"api_key"`. No write-back to the skill record. Canonical bytes unchanged.
- Existing skills don't have `bundle_sentinel`. Canonical bytes unchanged.
- Existing skills only contain `extract_via_copy_button` and `extract_via_regex` step kinds. Canonical bytes unchanged.

The signed-envelope verifier (`verifySkillSignature` per Phase 6) is byte-comparing against the same canonical JSON it always was.

---

## Planner strategy

The planner gets a *single* prompt change: a new section at the end that describes the multi-cred case and the trigger.

```
Multi-credential pages (Twitter, Stripe, OpenAI, AWS IAM, GCP):

A page is multi-credential when ANY of these hold:
  - Two or more Copy buttons are visible near distinct labels
    (e.g. "Copy API Key", "Copy API Key Secret")
  - Two or more visible strings match credential shapes AND each
    sits beside a distinct label phrase
  - The page explicitly enumerates "Your keys" or "Tokens" with
    multiple rows

On multi-credential pages, emit:
  {"kind": "extract_named",
   "credential_label": "<verbatim visible label, e.g. 'API Key Secret'>",
   "produces": "<lowercase snake_case derived from label>"}

ONE per credential. After emitting all credentials visible on this
page, return "done" to terminate. If you missed a credential, the
final post-done page scan will catch it.

On single-credential pages — every page that does NOT match the
above triggers — keep emitting the OLD shape: {"kind": "extract"}.
This is the unchanged single-credential path.
```

The prompt change is additive. The single-cred path's instructions are unchanged. The planner sees the new section only as new vocabulary; on a single-cred page (Railway, Postmark, IPInfo), the trigger conditions don't hold and the planner reverts to `{"kind": "extract"}`.

**Verification:** the shadow-test harness (next section) runs every single-cred capture through the new prompt and asserts the planner still emits the old shape on every round.

### Final post-done page scan (multi only)

After the planner emits `done` on a multi-cred page, the bot runs one final sweep: extract every credential-shaped string the planner *might* have missed, log them as `unclaimed_credentials` in the run trail, and surface them to the operator. This is a safety net for the planner stopping early — not authoritative, but flagged for review.

---

## Synthesizer

The synthesizer decides "single or multi" based on the capture content:

1. Count extract rounds in the chain.
2. If 1 → single path (today's `inferCredentialSpec`, today's `credentials: [spec]`).
3. If >1 → multi path:
   - Each extract round becomes one `extract_via_*_named` step
   - Each step's `produces` is derived from `credential_label` (lowercased snake_case)
   - One `SkillCredentialSpec` per distinct `produces`
   - Validator inferred per-cred from shape; bundle_sentinel left unset (operator adds via `skill edit`)

The branching point is **one location** (`promoteToSkill`). All shared helpers (chain verification, capture parsing, shape inference) work on both paths.

Failure case: if extract rounds emit *the same* `produces` twice, the chain is malformed. Reject with `error_kind: "duplicate_credential_produces"`. This means the planner labeled two credentials the same — operator triage decides whether to relabel and republish.

---

## Replay engine

A new `ReplayOutcome` variant:

```ts
ReplayOutcome =
  | { kind: "ok", credential: string, via: ... }      // unchanged
  | { kind: "ok_multi",                                // NEW
      credentials: Record<string, string>,             //  produces → value
      via: Record<string, "copy_button" | "regex"> }
  | ...other unchanged variants
```

The replay engine branches on step kind:

```ts
if (step.kind === "extract_via_copy_button" || step.kind === "extract_via_regex") {
  // existing single-cred logic, returns { kind: "ok", credential }
}
if (step.kind === "extract_via_copy_button_named" || step.kind === "extract_via_regex_named") {
  // new multi-cred logic, accumulates into credentials map
  // returns { kind: "ok_multi", credentials } only after all named extracts complete
}
```

The router (`tryReplayLearnedSkill` in `provision-any.ts`) handles `ok_multi` as a new explicit branch — *not* a fallback through the `ok` case. The compiler enforces this: the discriminated union doesn't allow silent coercion.

The bundle sentinel runs as a post-extract step, after all named extracts have produced values. If the skill carries a `bundle_sentinel`, the engine signs a request with the named credentials and calls the configured URL. On 2xx, the bundle is valid. On non-2xx or timeout, the outcome flips to `{kind: "validator_failed", reason: "bundle_sentinel returned HTTP N"}`.

---

## Vault: atomic bundle write

The vault today writes one credential per call. For multi-cred we need atomic semantics: either all of Twitter's 5 credentials land, or none of them do (no partial state). Two options:

**Option A — DB transaction.** The vault writer wraps the N writes in a transaction; one fails, all roll back. Cleanest semantically, requires the vault store to support transactions (Prisma does).

**Option B — Bundle row.** Store the bundle as a single JSON blob keyed by service. The agent SDK reads the blob and surfaces individual env vars. Simpler write, less ergonomic on the read side (every consumer parses JSON).

Recommended: **Option A**. The agent SDK's existing `read(env_var)` API works unchanged. The write side gets a new `writeCredentialBundle(records: Record<string,string>)` method, which the multi-path calls. The single path keeps calling `writeCredential` — untouched.

---

## Shadow-test harness (the regression net)

**Purpose:** every change to the planner prompt or synthesizer is gated by a CI test that proves single-cred services don't drift to the multi action shape.

**Inputs:** the existing capture corpus. Today we have captures for Railway, Postmark, Sentry, OpenRouter, IPInfo, Resend. Each capture is a chain of rounds with `state` (URL, title, html, screenshot) + `inventory`.

**The harness:**

```ts
// apps/mcp/src/bot/__tests__/planner-shadow.test.ts

describe("planner shadow-test — single-cred regression net", () => {
  for (const service of SINGLE_CRED_CORPUS) {
    it(`every round of ${service} emits the single-cred action shape`, async () => {
      const rounds = loadCaptureCorpus(service);
      for (const round of rounds) {
        // Re-run the post-verify planner against this round's state.
        // Use a deterministic mock LLM that returns the captured
        // `observed` action when given the captured state — OR a real
        // LLM call gated behind RUN_LLM_SHADOW=true env (slow, costs).
        const action = await replanRound(round);

        // Assert: no new-shape actions on a known single-cred page.
        expect(action.kind).not.toBe("extract_named");
        // Assert: the round's observed action is replayable under
        // the new prompt (the planner doesn't choke).
        expect(["click","fill","extract","navigate","done","wait","check","scroll"])
          .toContain(action.kind);
      }
    });
  }
});

const SINGLE_CRED_CORPUS = [
  "railway",
  "postmark",
  "sentry",
  "openrouter",
  "ipinfo",
  "resend",
] as const;
```

**Two modes:**

1. **Cheap mode (always-on CI):** uses a deterministic mock that maps `(state.html, inventory)` → `observed` from the capture file. Asserts the planner's parsing layer accepts the new prompt and that no synthetic `extract_named` slips into the validation. Catches schema/prompt regressions, not LLM drift.
2. **LLM mode (gated, weekly):** sets `RUN_LLM_SHADOW=true`, makes real LLM calls against the same fixtures, asserts the action shape stays single-cred on every round. Costs ~$5/run (≈40 rounds × $0.13 per multi-modal call). Detects model drift between prompt versions.

**Verdict gate:** if any single-cred fixture emits `extract_named`, CI fails with a clear "the new prompt caused planner drift on <service>" message. The harness names the offending round + state so the operator can see which page tripped it.

**Where it sits:** `apps/mcp/src/bot/__tests__/planner-shadow.test.ts`. The capture corpus lives in `corpus/onboarding/<service>/<run-id>/`. The harness loads from disk — no network in cheap mode.

**Status before multi-cred lands:** harness ships *first*, exercises the current prompt, every existing capture passes. This becomes the baseline. Then the multi-cred prompt change goes in; harness either passes (single-cred safe) or names the regressing service.

---

## Twitter end-to-end walkthrough

Concrete picture of how the design plays out for the canonical multi-cred case.

### Signup flow (universal bot)

1. Bot navigates to `developer.twitter.com/portal/dashboard`, signs in via OAuth.
2. Creates a project + app (standard onboarding steps).
3. Lands on the app's Keys & Tokens tab. The page shows:
   - "API Key" row with a value + Copy button
   - "API Key Secret" row with a value + Copy button
   - "Bearer Token" section with a value + Copy button
4. Post-verify planner sees the inventory: 3 Copy buttons near distinct labels. **Multi-cred trigger fires.** Planner emits:
   ```json
   {"kind": "extract_named", "credential_label": "API Key", "produces": "api_key"}
   ```
5. Bot extracts via the existing Copy-button logic (`tryCopyButtonExtraction`), keyed by `near_text_hint: "API Key"`. Stores value in `extracted["api_key"]`.
6. Planner re-plans, emits the next: `{"kind": "extract_named", "credential_label": "API Key Secret", "produces": "api_key_secret"}`.
7. Loop continues until planner emits `{"kind": "done"}`.
8. Bot scrolls to the Access Tokens tab, opens it. Planner sees 2 more Copy buttons.
9. Loop continues. Eventually planner returns `done` with all 5 credentials in `extracted{}`.
10. Final post-done page scan flags any credential-shaped string not in `extracted{}` — for Twitter, expected to be empty.
11. Bot calls `vault.writeCredentialBundle({TWITTER_API_KEY: ..., TWITTER_API_KEY_SECRET: ..., ...})`. Atomic.

### Skill record (after promotion)

```json
{
  "schema_version": 2,
  "skill_id": "01TWX9...",
  "service": "twitter",
  "version": "v1",
  "signup_url": "https://developer.twitter.com/portal/dashboard",
  "oauth_provider": "google",
  "steps": [
    { "kind": "navigate", "url": "https://developer.twitter.com/portal/dashboard" },
    { "kind": "click_oauth_button", "provider": "google" },
    { "kind": "click", "text_match": "Create Project", "role": "button" },
    { "kind": "fill", "text_match": "Project name", "value_template": "$PROJECT_NAME" },
    { "kind": "click", "text_match": "Create", "role": "button" },
    { "kind": "click", "text_match": "Keys and tokens", "role": "tab" },
    { "kind": "extract_via_copy_button_named", "near_text_hint": "API Key", "produces": "api_key" },
    { "kind": "extract_via_copy_button_named", "near_text_hint": "API Key Secret", "produces": "api_key_secret" },
    { "kind": "extract_via_copy_button_named", "near_text_hint": "Bearer Token", "produces": "bearer_token" },
    { "kind": "click", "text_match": "Access Token", "role": "section" },
    { "kind": "extract_via_copy_button_named", "near_text_hint": "Access Token", "produces": "access_token" },
    { "kind": "extract_via_copy_button_named", "near_text_hint": "Access Token Secret", "produces": "access_token_secret" }
  ],
  "credentials": [
    { "name": "api_key", "type": "api_key", "shape_hint": "opaque", "env_var_suggestion": "TWITTER_API_KEY", "post_extract_validator": { "min_length": 20, "max_length": 50 } },
    { "name": "api_key_secret", ..., "env_var_suggestion": "TWITTER_API_KEY_SECRET", ... },
    { "name": "bearer_token", ..., "env_var_suggestion": "TWITTER_BEARER_TOKEN", ... },
    { "name": "access_token", ..., "env_var_suggestion": "TWITTER_ACCESS_TOKEN", ... },
    { "name": "access_token_secret", ..., "env_var_suggestion": "TWITTER_ACCESS_TOKEN_SECRET", ... }
  ],
  "bundle_sentinel": {
    "url": "https://api.twitter.com/2/users/me",
    "auth_scheme": "oauth1_signed",
    "required_credentials": ["api_key", "api_key_secret", "access_token", "access_token_secret"],
    "timeout_ms": 3000
  }
}
```

### Replay flow

1. Router calls `tryReplayLearnedSkill("twitter")` → registry returns the skill above.
2. Dry-mode walk: every step pre-validates against the live page. Every `extract_via_copy_button_named` step's `near_text_hint` is checked for visibility. Bundle sentinel is NOT called in dry mode.
3. Full-mode walk: steps execute. Each named extract accumulates into `credentials{}`. After the last named step, `bundle_sentinel` makes an OAuth1-signed call to `/users/me` with the 4 named creds. On 200 → `{kind: "ok_multi", credentials, via}`. On 4xx → `{kind: "validator_failed", reason: "bundle_sentinel returned HTTP 401"}`, which the router posts back to the registry → counts as a failure → eventually auto-demotes.
4. Vault writes the 5 entries atomically.
5. Agent SDK reads `process.env.TWITTER_API_KEY` etc.

---

## Phased rollout

Each phase is shippable independently; nothing in this list breaks single-cred when it lands.

### Phase A — Shadow-test harness (1 day)
Ship the regression net *first*. Captures the current planner behavior as the baseline. Every change after this is gated by it.

### Phase B — Schema additions (0.5 day)
Add optional `name` to `SkillCredentialSpec`, new step kinds, optional `bundle_sentinel`. All backward-compatible. Existing skills validate unchanged. No prompt or executor changes yet — just type definitions.

### Phase C — Synthesizer multi-cred branch (1.5 days)
`promoteToSkill` learns the "if >1 extract rounds → multi path" branch. Single-cred captures continue to produce single-cred skills. Tests: synthesize Twitter from a hand-built 3-round multi-extract corpus; assert `credentials.length === 3`, all `produces` values distinct, all step `produces` reference real credential names.

### Phase D — Replay engine multi outcome (2 days)
New `ok_multi` variant, executor branches on step kind, router branches on outcome variant. The vault gets the new `writeCredentialBundle` method (transaction). Single-cred replay path untouched.

### Phase E — Planner prompt expansion (1 day)
Add the multi-cred section to the post-verify planner prompt. Shadow test gates this — if any single-cred fixture emits `extract_named`, this phase fails.

### Phase F — Bundle sentinel (2 days, per auth scheme)
Implement the OAuth1 signing for Twitter. Validator runs against `/users/me`. Per-scheme modules grow as we add Stripe (basic auth), AWS (sigv4), etc.

### Phase G — Final page scan (0.5 day)
After `done`, sweep the page for credential-shaped strings not in `extracted{}`, log to step trail. Safety net for planner stopping early.

**Estimated total:** ~8.5 days of focused work, including tests. Closer to 12 with iteration on the Twitter signup (their dev portal is its own anti-bot challenge).

---

## Open questions

1. **Multi-cred shape inference for the synthesizer.** When a capture has 3 extract rounds with copy buttons but the planner labeled them inconsistently ("API key" vs "API Key" vs "Api Key Secret"), how robust is `produces` derivation? Probably needs normalization — lowercase, strip punctuation, collapse spaces to underscores. Tested with at least 5 real services before shipping.

2. **What about partial extraction?** If the bot gets 4 of Twitter's 5 credentials and fails on the 5th (page glitch, planner skip), do we:
   - **Reject the run entirely.** Strict — operator has to retry from scratch.
   - **Save partial + flag.** Pragmatic but operator can't easily resume; what does the agent SDK do when `TWITTER_ACCESS_TOKEN_SECRET` is missing?
   - **Save partial + transparent retry.** Bot detects 4 of 5, navigates back to the section with the missing one, re-extracts.
   
   Recommended: **save partial + flag with `unclaimed_credentials` list**, status `failed_partial`. Operator can re-run with a hint. Vault stays empty on partial — atomic-or-nothing on the write side.

3. **Bundle sentinel auth schemes.** OAuth1 (Twitter) is meaningful work. SigV4 (AWS) is more work. We can ship multi-cred without bundle sentinels (just per-credential shape regex), but that loses the "wrong creds" detection that's the whole reason sentinels exist (Railway 0.6.13 class bug). 
   
   Recommended order: ship OAuth1 first (covers Twitter), defer SigV4 until AWS IAM is on the roadmap, add `bearer_plus_basic` (covers Stripe-class: bearer + secret key) third.

4. **Replay of a multi-cred skill when the page changes count of credentials.** Twitter v2 → v3 might add a 6th credential type, or remove one. The skill's step list is fixed; if step 11 says "extract_named near 'Access Token Secret'" and Twitter renamed it, replay fails on that step. Standard skill-staleness path: 3 consecutive failures → auto-demote → next run falls through to universal bot → bot re-captures → promoter creates v2. The mechanism already exists; nothing multi-specific needed here.

5. **Vault read API for multi-cred.** The agent SDK reads single env vars today (`process.env.TWITTER_API_KEY`). Multi-cred works trivially through the same API since each credential lands at its own env var. No SDK change needed. Worth confirming with the runtime team before assuming.

6. **Capture format for multi-cred runs.** The onboarding-capture writes one file per round. A multi-cred run has more rounds → more files. The chain integrity hash still works (each round's `prev_hash` matches the previous round's `content_hash`). No format change needed; just more files per service.

---

## Known limitations of this design

- **The planner must label credentials consistently.** If it labels the same credential differently across captures (Day 1: "API Key Secret", Day 2: "API key secret"), the synthesizer produces two different `produces` values, and the skill is wrong. Mitigation: normalize labels before deriving `produces`; emit a synthesizer rejection on duplicate normalized values.
- **No support for credentials behind a "reveal" interaction.** Some services (e.g. Postmark's signing secret) hide the value until a "Reveal" or "Show" button is clicked. Today's `extract_via_copy_button` already handles this (the planner emits a `click` before `extract`). Multi-cred extends the same — `click` then `extract_via_*_named` — no special handling needed.
- **No bundle sentinels for OAuth2.** OAuth2 credentials are usually a client_id + client_secret pair where the validator is "exchange these for an access token, then call /whoami with that". That's a 2-step validator the schema doesn't currently model. Multi-cred for OAuth2 services would extract correctly but skip bundle validation. Acceptable for first ship.
- **Skill versioning at multi-cred boundary.** Bumping a skill from single-cred to multi-cred (a service added a second key) is a major version bump (v1 → v2). The registry's review gate (Phase 6 T26) catches `signup_url` and `oauth_provider` changes but not credential count changes. Could be added as a follow-up — the review gate already exists.

---

## Status: DRAFT — awaiting review

**Premises to confirm:**
- The user has multi-cred services in the queue (Twitter is the immediate ask; what's next? Stripe? AWS? OpenAI?).
- The regression risk on single-cred is the dominant concern (yes, stated explicitly).
- The shadow-test approach is acceptable as the primary safety mechanism.

**Recommended action:** before any phase ships, run the **Phase A shadow-test harness** against the current planner prompt on every existing capture. If all single-cred fixtures pass under the unchanged prompt, the baseline is established and Phases B-G can land in order behind that gate.

If the shadow test reveals existing prompt fragility — i.e. an existing single-cred fixture sometimes emits a weird action even today — fix that *before* expanding the prompt vocabulary. The shadow test is the gate.
