# Multi-provider onboarding

Status: implementing — design dated 2026-05-25, target rc 0.6.15-rc.5.

## Problem

The bot's universal signup path frequently lands on SaaS pages that
only expose OAuth — and frequently only one provider. Some services
(Railway, Vercel, parts of Cloudflare) are GitHub-only; others are
Google-only. Today's `mcp connect` flow asks the operator to sign in
with *one* provider during install. The bot then has exactly one
Chrome session and is structurally unable to complete signups that
need the other provider until the operator runs a separate
`mcp login --provider=<other>`.

Most operators don't know that's the recovery path until they hit
the failure, which surfaces as a vague stderr line in the harvester
output mid-run. They've already burned a queue slot.

## Two concerns, conflated today

Today's CLI fuses two distinct concerns into one prompt:

| Concern | Cardinality | Mutability | What it persists |
|---|---|---|---|
| **TS account identity** | 1 registered, N linked | Set once; link more over time | `Account` row + `OAuthIdentity[]` |
| **Browser session capability** | N (one per provider) | Refresh as cookies expire | Chrome profile cookies + `logged-in-providers.json` |

Account identity is durable, web-scoped, lives on the API. Browser
capability is rotation-prone, local-scoped, lives in the Chrome
profile. They share an OAuth handshake during install only because
the install ceremony bundles "create account" and "seed first
browser session" into one trip through the OAuth IdP — for
operational convenience, not because they're the same thing.

Splitting them clarifies the install flow without losing that
convenience.

## Decisions (CEO-locked 2026-05-25)

1. **Step 2 (add secondary provider) defaults to YES.** One extra
   noVNC sign-in at install time beats surprising the operator
   mid-run. Skippable with `--skip-secondary` for CI scripts.
2. **When a SaaS exposes both Google and GitHub OAuth, the bot
   prefers Google.** Google's OAuth flow is simpler (one click vs.
   GitHub's authorize-then-grant double-confirm in most cases) and
   tends to have lower number-match incidence on warm Chrome
   sessions.
3. **Linking the secondary provider is silent — no extra
   confirmation.** The whole step-2 ceremony runs inside the install
   trust context, where the operator has already proven
   account-creation auth. Adding "are you sure?" friction in the
   only window where the friction equally affects honest operators
   and attackers buys nothing.

## Proposed flow

### `mcp connect` (install) — two interactive steps

```
$ npx @trusty-squire/mcp connect

Welcome to Trusty Squire.
We'll set up: (1) your account, (2) browser sign-ins the bot uses.

▸ Step 1/2 — Your account
  Pick your registration provider. Either works.
    1) Google
    2) GitHub
  > 1
  Opening https://vnc.trustysquire.ai/?p=… (or local browser)
  ✓ Signed in as lunchboxfortwo@gmail.com
  ✓ TS account created · machine token paired
  ✓ Google session seeded in bot's Chrome profile

▸ Step 2/2 — Add GitHub for broader service coverage?
  Some SaaS (Railway, Vercel, parts of Cloudflare) only support
  GitHub OAuth. Add it now so the bot doesn't have to interrupt
  you mid-signup later.
    1) Yes (recommended)      2) Skip — I'll add later
  > 1
  Opening the same noVNC URL… sign in to GitHub.
  ✓ GitHub session added

Done. Connected providers: Google (primary), GitHub.
Skipped one? Add anytime: npx @trusty-squire/mcp login --provider=github
```

### `mcp login --provider=X` — additive command, post-install

Stays the same shape it has today (open browser, wait for the
provider cookies to appear, mark `logged-in-providers.json`),
plus:

- Updates `session.json`'s new `connected_providers` array. This
  is what step-1 preflight reads on a re-run.
- Idempotent. If a session for `X` is already present and valid,
  prints `✓ Already logged in to <X>` and exits 0 without
  spawning Chrome. `--force-relogin` bypasses.

### Install preflight — re-runs don't re-do completed steps

Today's preflight (rc.15) skips the whole install when machine
token + agent session + at least one provider session are present.
That stays. New behaviour: even when preflight passes, if
`connected_providers` is missing one of the two known providers,
the CLI offers to add it (same step-2 prompt). Skippable with
`--skip-secondary`.

This makes `mcp connect` safely idempotent and gives operators a
natural prompt to add the second provider if they originally
chose "skip".

### Bot tiebreak — Google wins when both work

`resolveOAuthCandidates` in `apps/mcp/src/bot/agent.ts` returns the
list of providers the bot has sessions for, in the order
`findFirstOAuthButton` will try them. Sort that array so `google`
comes first when both `google` and `github` are present. One-line
change; no behaviour change for single-provider operators.

### `needs_oauth_provider_session` — actionable hint

When the bot returns the existing `needs_oauth_provider_session`
outcome (the page offers OAuth but the bot has no session for any
of the listed providers), the MCP tool layer's response message
gets a copy-pasteable one-liner that names the missing provider:

```
✗ Railway signup needs GitHub OAuth, but the bot has no GitHub
  session configured.
  Run: npx @trusty-squire/mcp login --provider=github
  Then re-try the provision.
```

vs. today's generic "run `mcp login`".

## Out of scope for rc.5

These are real follow-ups but not blocking the UX improvement:

- **Server-side linking of the secondary OAuth identity to the TS
  account.** Today, `mcp login` only writes Chrome cookies. It
  doesn't POST anything to the API. So the secondary provider's
  identity is NOT recorded in `OAuthIdentity` rows server-side.
  The bot doesn't need that record to function — the machine
  token still resolves to the account.email for alert routing
  (see the heightened-auth notify route shipped in rc.4). But if
  we later want web-side "log in with GitHub" to find the
  Google-registered account, we'd need a small new route to link
  identities by signal coming from the Chrome session (read
  identity from cookies/Preferences, POST to API, server creates
  the OAuthIdentity row). Defer until the web UI actually exposes
  multi-provider login.

- **Browser sessions that go stale before being used.** A user who
  links GitHub at install but doesn't trigger a GitHub-OAuth
  signup for weeks may find the session expired when the bot
  finally needs it. Today's recovery is the same as
  not-connected: the bot returns `needs_oauth_provider_session`,
  the MCP tool surfaces the `mcp login --provider=github` hint,
  the user re-runs. Acceptable for now; revisit if real users
  complain.

- **Three-or-more providers (Microsoft, GitLab, …).** The schema +
  CLI already generalize; just hasn't been needed. Adding a
  provider is a new entry in `OAUTH_PROVIDERS` + login-cookie
  detection rules + minor CLI prompt wording.

## Files this touches

```
apps/mcp/src/install/cli.ts          — step-2 prompt, --skip-secondary, preflight
apps/mcp/src/session.ts              — SessionData.connected_providers
apps/mcp/src/install/ensure-oauth.ts — update connected_providers on success
apps/mcp/src/bot/agent.ts            — Google-first tiebreak in resolveOAuthCandidates
apps/mcp/src/provision_any.ts        — enriched needs_oauth_provider_session message

apps/mcp/src/install/__tests__/      — step-2 default, preflight skip, idempotency
apps/mcp/src/bot/__tests__/          — tiebreak prefers Google
```

## Migration

`session.json` files written by older versions won't have
`connected_providers`. Read path treats absent field as `[]`; first
successful `mcp login` populates it. No migration script needed,
no version gate.
