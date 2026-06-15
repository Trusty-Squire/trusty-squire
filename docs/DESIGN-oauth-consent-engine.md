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

## Boundary: pure decision vs I/O

- **PURE (→ `oauth-flow.ts`, unit-tested, no browser):**
  - `isAccountChooser(url)` — the chooser-URL test.
  - `planConsentDecision({ scopes, dangerPhrases, domLooksBasic })` →
    `approve | needs_review | … ` — the scope gate (invariant #2) as one pure
    function. Reuses `scopesAreBasic`.
  - `planOAuthAction({ authState, isChooser, hasLoginForm, consentDecision, … })`
    → the high-level action enum above. The state→action mapping.
- **I/O (stays in agent.ts as a thin executor):** captcha, clicks, the account
  card, challenge handling + notifications, OmniAuth POST, snapshots. These call
  the pure planner and execute its verdict.

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
