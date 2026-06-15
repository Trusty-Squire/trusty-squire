# DESIGN — OAuth/consent engine (pre-login refactor, strangler slice 2)

Status: scoping + decision-core extraction in progress (2026-06-15). Owner: bot.
Scope: the universal signup bot's OAuth/consent phase only. The second
strangler-fig slice of the agent.ts de-monolithing (A4 in
`DESIGN-post-signup-nav-search.md`): **nav-search (done) → OAuth/consent (this) →
form-fill/captcha → extraction**.

## Problem

`runOAuthFlow` (`apps/mcp/src/bot/agent.ts`, ~1450 lines) is the single biggest
method in the 12k-line monolith. It interleaves, in one giant `for` loop:
- pure **decision** logic — classify the current Google/GitHub auth state, gate
  the consent scopes, decide the next high-level action;
- heavy **I/O** — captcha solving, clicking affordances, the account chooser,
  challenge handling (number-match, GitHub 2FA, device confirmation), operator
  notifications (Telegram / heightened-auth), OmniAuth POST recovery;
- **security invariants** that MUST NOT regress.

The decision logic is untestable in isolation because it's welded to the I/O.
Most of the *pure* helpers already live in `google-login.ts`
(`classifyGoogleAuthState`, `extractOAuthScopes`, `scopesAreBasic`,
`scrapeGoogleScopePhrases`, `detectActiveProviderSessions`). What's still
monolithic is the **orchestration state machine** that ties them together.

## Security invariants (MUST be preserved by any refactor)

1. **Never type into a provider's login form.** If the page carries a credential
   field (`oauthLoginFormPresent`) or classifies as `needs_login`, the flow
   aborts `needs_login` — it never enters a keystroke. This is THE D4 guarantee.
2. **Scope gate.** Auto-approve consent ONLY when the granted scopes are basic
   (openid/email/profile family). A non-basic or ambiguous scope grant aborts
   `oauth_consent_needs_review` for manual review — never blind-approves a
   dangerous scope. The URL-unreadable path additionally scrapes the DOM for
   scope-grant verb phrases and aborts if any are present.
3. **Bounded.** The walk is capped (`MAX_OAUTH_NAV`); it cannot loop forever.

## The action algebra (extracted from the live state machine)

Each loop pass reads `{url, body}`, then:

```
account-chooser URL?            → CLICK_ACCOUNT_CARD ; reloop
classifyAuthState(url, body):
  not_provider                  → (OmniAuth GET-passthru? RECOVER_OMNIAUTH_POST ; reloop)
                                   else LEAVE_PROVIDER (back on the service app)
  challenge                     → HANDLE_CHALLENGE (number-match / 2FA / device /
                                   operator-tap) → cleared? reloop : ABORT(needs_login)
  needs_login                   → clearProviderLoggedIn ; ABORT(needs_login)
  consent + login-form-present  → ABORT(needs_login)            [invariant #1]
  consent:                       (scope gate — invariant #2)
    scopes basic                → APPROVE_CONSENT (advance)
    scopes null + danger phrases → ABORT(oauth_consent_needs_review)
    scopes null + only-basic DOM → APPROVE_CONSENT (recover)
    scopes non-basic            → ABORT(oauth_consent_needs_review)
  (post-approval re-confirmation, unreadable) → SOFT_ADVANCE (bounded)
```

The terminal outcomes the caller (`runSignup`) dispatches on:
`SignupResult` (needs_login / consent_needs_review / success), the
`OAUTH_FALL_BACK_TO_FORM_FILL` sentinel (login-only OAuth, no account →
re-run form-fill), and `OAuthTryNextProvider`.

## Boundary: a PURE STATEFUL REDUCER vs I/O (revised — eng-review 2026-06-15)

The first cut was action-only pure functions (`planConsentDecision`,
`planOAuthAction`). The eng review (Claude + Codex) found that **too thin** for a
flow that is genuinely a *stateful* machine: the loop carries
`consentAlreadyApproved`, `consentAdvanceWaits`, the `i--` nav-budget trick, and
ordered side effects — none of which an action-only function can express, so the
gnarliest sequencing would stay un-extracted and untested in agent.ts. Verdict:
model the whole thing as a **pure reducer**.

- **PURE (→ `oauth-flow.ts`, unit-tested incl. transitions, no browser):**
  ```
  decideOAuthStep(state, observation) → { action, nextState }
  ```
  - `state`: `{ providerId, consentAlreadyApproved, consentAdvanceWaits,
    omniauthPostTried, allowBlindOAuthConsent, allowExtraOAuthScopes,
    challengeBudgetLeft, … }` — every loop-carried variable.
  - `observation`: `{ url, isChooser, authState, scopes, dangerPhrases,
    domLooksBasicGis, hasLoginForm }` — the I/O-gathered facts (the executor
    reads these from the browser, the reducer never touches a browser).
  - `action` ∈ click_account_card | approve_consent | blind_advance |
    soft_advance | recover_omniauth_post | settle_left_provider |
    handle_challenge | abort(reason) — and carries **side-effect intent**
    (e.g. `abort` carries `clearProviderLoggedIn: true` so the executor performs
    the marker-clear BEFORE aborting; invariant for non-sticky retries).
  - `nextState`: the updated loop state (sets `consentAlreadyApproved`,
    decrements budgets), so the executor stays a dumb apply-loop.
- **I/O (stays in agent.ts as a thin executor):** captcha, clicks, the account
  card, challenge *mechanics* + notifications, OmniAuth POST, snapshots,
  `advanceOAuthConsent`. It gathers the `observation`, calls `decideOAuthStep`,
  executes `action` (+ its side-effect intent), and adopts `nextState`.

### Gaps the reducer MUST cover (from the eng review — both models)

1. **Provider-aware scope policy** — use `provider.scopesAreBasic`, NOT the
   Google-only import. Else GitHub basic scopes (`read:user`, `user:email`)
   regress to review.
2. **`allowExtraOAuthScopes`** — non-basic scopes the user pre-approved
   auto-approve; only truly-unauthorized non-basic scopes → review.
3. **`allowBlindOAuthConsent`** — its own decision path (blind_advance) with the
   bounded hydrate-retry budget (`consentAdvanceWaits`/`MAX_CONSENT_ADVANCE_WAITS`).
4. **`consentAlreadyApproved` soft-advance** — checked FIRST on a post-grant
   unreadable consent page (F16); else the multi-page-consent false-negative.
5. **Two distinct DOM checks** — `scrapeGoogleScopePhrases` (danger → abort) and
   `googleGisConsentIsBasic` (basic → approve) are separate signals, not one
   boolean.
6. **Control-flow contracts** — `not_provider` is `settle_left_provider` (the
   live `break`), NOT a terminal failure; `handle_challenge` success re-classifies
   WITHOUT burning nav budget (the live `i--`). The reducer's `nextState`
   encodes these so the executor can't get them wrong.
7. **Side-effect ordering** — `clearProviderLoggedIn` BEFORE `needs_login` abort
   (and the consent-page-login-form abort) — carried as side-effect intent.
8. **Account-chooser is provider-gated** — `isChooser` only for Google.

## Migration (separate commits — Beck: make the change easy, then make it)

1. **Extract decision core** (this slice's first commit): `oauth-flow.ts` with the
   pure functions above + exhaustive unit tests, INCLUDING the invariant cases
   (login-form → needs_login; non-basic scope → review). NOT wired yet — zero
   behavior change, cannot regress the live path.
2. **Wire behind a flag** (`OAUTH_ENGINE`, default-off): `runOAuthFlow`'s loop
   calls `planOAuthAction` for the branch decision instead of inline `if`s; the
   I/O executors stay. Extract-and-behavior-change stay separate.
3. **Validate** live (pool-free OAuth via a warm robot, or the email-fallback
   path) across the consent / chooser / needs_login / not_provider cases, assert
   the invariants hold, then flip default-on (mirrors nav-search T6).

## Test plan (slice-1, browser-free)

- `isAccountChooser`: chooser URLs true; consent/auth URLs false.
- `planConsentDecision`: basic scopes → approve; non-basic → needs_review;
  null+danger → needs_review; null+basic-DOM → approve; null+nothing → the
  conservative default (needs_review).
- `planOAuthAction`: every authState → its action; the two invariant cases
  pinned (login-form present on a consent page → needs_login; challenge → handle).

## Not in scope (this slice)

- Rewriting the challenge / 2FA / OmniAuth I/O (stays in agent.ts).
- The form-fill and extraction phases (later strangler slices).
- An eng-review (plan-eng-review) is recommended before step 2 (wiring), as the
  consent gate is security-critical — same discipline nav-search got.

## What already exists (reuse, don't rebuild)

- `google-login.ts` — `classifyGoogleAuthState`, `extractOAuthScopes`,
  `scrapeGoogleScopePhrases`, `scopesAreBasic`, `googleGisConsentIsBasic`,
  `detectActiveProviderSessions`. The reducer CONSUMES these (the executor calls
  them to build the `observation`); it does not re-implement them.
- `oauth-providers.ts` — `provider.scopesAreBasic`, `provider.classifyAuthState`
  (provider-aware policy). The reducer takes the provider's predicate, not the
  Google-only one (eng-review gap #1).

## NOT in scope (deferred, with rationale)

- Rewriting the challenge / 2FA / device-confirmation / OmniAuth-POST **I/O**
  mechanics — stays in agent.ts; the reducer only decides `handle_challenge` vs
  abort and owns the budget accounting.
- The form-fill, captcha, and extraction phases — later strangler slices.
- Multi-provider beyond google/github — the provider abstraction already exists;
  no new providers added here.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | 8 issues (1 critical-class: action-only decomposition too thin for a stateful flow), 2 decisions resolved |
| Outside Voice | `/plan-eng-review` (codex) | Independent 2nd opinion | 1 | issues_found | +3 gaps Claude missed (provider scope predicate, control-flow `i--`/`break` contracts, side-effect ordering) + recommended stateful reducer |

- **CODEX:** confirmed the incomplete-model finding and extended it; proposed `decideOAuthStep(state, observation) → (action, nextState)` over action-only. Adopted.
- **CROSS-MODEL:** both models agree the extraction must be completed before wiring; the action-only-vs-reducer tension resolved to the reducer (user-approved).
- **VERDICT:** ENG review — re-architect to a pure stateful reducer covering the 8 gaps, with transition tests, THEN wire behind `OAUTH_ENGINE` (default-off) and live-validate before flip. Extraction-only so far has not touched the live OAuth path. Implement before wiring.

NO UNRESOLVED DECISIONS
