# DESIGN — Connect identity model: the Google session *is* the connection

Status: **proposed** (locked in design discussion 2026-06-26; not yet built).
Owner: TBD. Companion to `DESIGN-host-planner-perception.md` (the operate-task
surface that made this gap load-bearing).

This document supersedes `DESIGN-multi-provider-onboarding.md` anywhere the two
conflict. That older design split "Trusty Squire account identity" from
"browser session capability"; this design intentionally collapses the primary
identity to the Google session in the bot browser profile.

## Thesis

A user is **connected if and only if a live Google session exists in the bot's
browser profile.** That is the single necessary-and-sufficient human-supplied
condition. Everything else — machine token, agent session token, account
binding, registry URL — is plumbing the software provisions and refreshes
**silently in the background**, keyed off that proven identity. The only thing
that ever forces a human interaction is the Google session being **absent or
dead**.

This inverts today's gate, which treats the *account session* (machine + agent
token) as the connection and the Google login as merely informational.

Important boundary: a local Google cookie/marker is sufficient for **local UX
gating** ("can the bot act as the user?"). It is not sufficient for
**server-side account binding**. Any route that mints or reissues account-bound
tokens must verify the Google identity with the server, not trust a local marker
file.

## Why the current model is wrong

The install/connect preflight (`apps/mcp/src/install/cli.ts` →
`checkAlreadyProvisioned`, `decideProvisioned`) short-circuits the ceremony when
the **account token validates** (`agentTokenStillValid`, a round-trip to
`/v1/vault/credentials`). The bot's Google/GitHub provider markers are
explicitly *informational* — an empty provider list still returns "provisioned"
to avoid treating restored/headless installs as broken.

The result: **"provisioned" means "account-bound," not "able to act as the
user."** Two different meanings of "logged in":

1. **Account session** (machine + agent token) — gates LLM proxy, quota,
   billing. What connect checks today.
2. **Provider session** (Google in the bot profile) — what lets the bot *be you*
   at a third party. Treated as informational today.

This was *close enough* when every provision was a **signup**, because a signup
has a fallback identity: no Google session → fall back to a TS **email alias**
(our own inbox). Missing session = *degraded*, not *blocked*.

The **operate-task** (drive the user's *existing* Stripe / GitHub / etc.) has no
fallback identity — you cannot email-alias into an account that already belongs
to the user's real Google. So the exact state the current gate allows
("connected, but bot profile has no Google session") goes from *degraded* to
**the agent hits a login wall and has to type the user's password + 2FA into a
scoped browser mid-task** — the worst possible moment for a login. The
`provision_*` tools (`provision-session.ts` `startProvisionSession`) only
*report* session state via `detectSessionProviders`; they never establish one.

## Non-negotiable invariants

- **One primary identity.** The Google session in the bot profile is both the
  account anchor and the face the bot wears at third-party sites.
- **No hollow connected state.** A machine/agent token without a Google bot
  session is not "connected"; it is background account plumbing waiting for the
  required browser identity.
- **No local marker as server proof.** `logged-in-providers.json` and
  `connected_providers` are caches/capability hints. They must never authorize
  account creation, pairing, token refresh, billing, quota, or vault access.
- **Provider sessions are browser capabilities.** Web-login GitHub/Google and
  bot-profile GitHub/Google are different browser contexts. Linking one does not
  populate the other.
- **Everyday operation stays silent.** Connect/settings may confirm identity.
  Provision/operate paths should JIT-establish a missing/dead provider session
  only when required, then continue.

## Locked decisions

### D1 — The gate is inverted: Google session = connected

`connected ⟺ live Google session in the bot profile`. The machine token / agent
session token / account binding are provisioned **in the background** around
that identity. An expired machine token is a **silent background reissue**, not a
re-claim ceremony, because the live Google session already proves who they are.

"Need no further verification if live" applies only to local connect UX: a
confirmed Google session cookie/marker lets the CLI avoid a slow navigation
probe. If it turns out stale at provision time, *that* is when re-login is
triggered (JIT) — connect stays optimistic and fast. Server token issuance still
needs a real identity proof.

### D2 — One identity (Option A)

The Google the user logs into is **both** the TS-account anchor **and** the face
the bot wears at third-party signups. One login does double duty: the bot
authenticates Google in its profile, the software reads that identity, and
provisions/looks-up the TS account around it server-side. This collapses today's
*two* separate Google logins (web account sign-in + bot-profile login) into one.

We are **not** supporting "log into TS as Google but have the bot act as a
different Google" — that is the multi-identity juggling this whole model deletes.
(YAGNI; revisit only if a real need appears.)

### D3 — The connect flow: two situations, confirm-on-detect, no remembered flag

There is no durable "the user already confirmed this account" record — that would
be a second source of truth competing with the Google session itself (and could
*drift* from it). The bound identity is simply "whichever Google is live now."
So:

1. **No Google session** → run the Google login. Local browser on a
   laptop/desktop; **noVNC remote login** on a headless box (already exists in
   the install flow). Whoever logs in becomes the bound identity; machine token +
   account provision silently around it.
2. **Session detected** → confirm:
   > *"Detected Google session: `you@gmail.com`. Use this profile, or log into
   > another? (you can switch later via `squire settings`.)"*
   - **Use this** → bind, provision the rest in the background.
   - **Log into another** → log out, run the login for the new account, bind that
     (reuses the existing `--force-relogin=google` machinery: clear provider →
     re-login).
3. **Session expired/dead** → treated as situation 1 (re-login).

The confirm is a feature of the **connect ceremony** (rare, explicit — cheap and
safe to confirm each run, and it can't drift). **Everyday provisioning never
asks** — `provision_start` just acts as whichever Google is live. (That was never
a "connect state"; it's a different code path. The earlier draft's "already
bound, stay silent" state was this path leaking into the connect table — it does
not exist as a connect state.)

### D4 — "id" shown in the confirm

The Google **email** (plus display name / avatar if cheap), read off the
authenticated profile — that is what tells the user "yes, that's my account."

### D5 — Headless is not an obstacle

The old "headless bug" only existed because the prior design tried to *complete
connect without a login*. Establishing a Google session is **not** tied to a
*local* browser:

- Laptop/desktop → local browser login.
- Headless box → **noVNC** remote login (already built).
- Fresh machine / restored `session.json` → re-login, which is *correct* — that
  box genuinely lacks the user's Google session, and a restored machine token
  without it is exactly the hollow "account-bound but can't act" state we reject.

So "Google session required" never strands a headless box; it routes through
noVNC. The decoupling was treating a symptom; this inversion dissolves it.

### D6 — GitHub is the optional cousin, never an anchor

Google is universal and identity-anchoring; GitHub is dev-niche and additive.
They are **not** symmetric.

- **Google** stays the sole connection gate and identity anchor (D1/D2).
- **GitHub is a secondary provider session** — an optional extra face the bot
  wears for services that only/best offer "Continue with GitHub" (Railway,
  Render, Vercel...). It lives in the same bot profile, is established by the same
  login machinery, and is confirmed/switched/removed via the same
  `squire settings` surface — symmetric *as a provider*, but **optional** and
  **never gating "connected."**
- **Added just-in-time:** GitHub stays entirely out of the connect ceremony. The
  first time a provision hits a GitHub-needing service with no GitHub session,
  establish it then (local / noVNC), confirming a cached session the same way as
  Google. Same "no verification if live, re-login if dead" rule.
- **Signup provider preference is unchanged:** Google → email → GitHub
  (`loginSessionGuidance` in `skill-hint.ts`). A present GitHub session is pure
  headroom — reached only when the service wants it.

#### The two GitHubs (do not conflate)

There are two unrelated "GitHubs," in different code and different browsers:

| | Where | What it does |
|---|---|---|
| **Web-login GitHub** | `apps/api/src/auth/oauth-providers.ts`, `oauth-identity-store.ts` | Authenticates *you* to the TS **account/dashboard** (billing, settings) in your normal browser. Links a GitHub identity to your account. |
| **Bot-profile GitHub** | `apps/mcp/src/bot/` (sibling of `google-login.ts`) | A session in the bot's **persistent Chrome profile** that lets the bot *act as you* at a third-party signup. |

The web button **cannot** populate the bot profile (different process, different
browser context). **Keep the optional GitHub in the web login exactly as-is** —
it is orthogonal to the connect gate, doesn't give the bot a GitHub face, and is
free. *Signed into the TS web app with GitHub* ≠ *the bot can act as me on
GitHub*. Nobody should ever wire the web-login GitHub to satisfy the connect gate
or the bot capability — it is the wrong browser context and cannot.

### D7 — `squire settings`

A new **surface** (not new plumbing) to view/switch the bound identity outside of
a re-install: show the current Google (and any GitHub) provider session, allow
switching, allow removing the optional GitHub face. The switch action *is* the
existing `--force-relogin=<provider>` operation (clear provider → re-login).

## Deferred / non-goals

- **GitHub-only user (no Google at all).** Under the locked model they cannot be
  the *anchor*. In practice nearly every developer has a Gmail, so the bar is
  low. Do **not** build "primary identity may be GitHub" until a real GitHub-only
  user appears — and when one does, it is a contained change ("primary identity
  defaults to Google but may be GitHub"), not a redesign. (Mirrors deferring
  multi-cred Phase E until a real multi-cred service appears.)
- **Multi-Google juggling** (D2) — out of scope by decision.

## Current implementation facts

- `apps/mcp/src/install/cli.ts` still treats `agentTokenStillValid()` as the
  preflight gate. `decideProvisioned()` returns provisioned when the machine
  token, agent session token, account id, and vault auth check are present/valid.
  Provider state is printed, not gating.
- `runInstallClaim()` still depends on the browser web app claiming
  `/v1/mcp/install/:code/claim`. That claim is protected by web auth and mints
  the agent session. This is the current account-binding mechanism.
- `ensureOAuthSession()` can establish or confirm a Google/GitHub session in the
  bot Chrome profile. It marks provider presence after a preflight-satisfied or
  completed login.
- `startProvisionSession()` currently calls `detectSessionProviders()` and
  passes the result into `loginSessionGuidance()`. It reports capability; it does
  not establish a missing required provider session.
- `SessionData.connected_providers` and the bot-side provider marker are caches.
  They are useful for fast UX, but they are not proof for server-side account
  binding.

## Implementation plan

### Phase 0 — Make provider liveness explicit

- Add a provider-status helper that returns `{ provider, status, email?,
  displayName?, avatarUrl? }` for the bot Chrome profile. Status values should
  distinguish `absent`, `present`, `stale`, and `unknown`.
- Use cookie/marker presence for the fast path, but verify enough live identity
  to show the email during the connect/settings confirmation.
- Keep `connected_providers` as a cache and rewrite it only after a confirmed
  provider-status probe or successful `ensureOAuthSession()`.

### Phase 1 — Invert the connect gate locally

- Change `connect` preflight so `Already connected` requires a live Google
  bot-profile session. A valid account token without Google should run the
  Google login once, then continue.
- Keep the existing account-token check, but demote it to "do we need background
  token refresh/reissue?" rather than "can we skip connect?"
- Implement the explicit detected-session branch:
  - no Google session: run `ensureOAuthSession({ provider: "google" })`;
  - Google session detected: show email and confirm use vs switch;
  - stale/dead: clear provider and run login.

### Phase 2 — Add server-side identity proof for background account binding

The API needs a new or revised route that accepts a **server-verifiable** Google
identity from the bot-profile flow and returns the account-bound session
plumbing. Do not authorize this from a local provider marker.

Recommended shape:

- CLI initiates a short-lived connect challenge with its machine token.
- Bot Chrome completes a Google OAuth flow against the API using the bot profile.
- API verifies the OAuth callback, resolves/creates the account through the
  existing `oauthIdentityStore`, binds the pending machine token, and issues the
  agent session.
- CLI polls the challenge exactly like the current install claim and receives
  the raw agent token once.

This can reuse the existing pairing-token delivery pattern from
`/v1/mcp/install/initiate` + `/status`, but the claim step should be a
provider-identity claim, not the current web-session claim. The current web claim
route proves "the normal browser is logged into Trusty Squire"; the new route
must prove "the bot profile completed Google OAuth."

### Phase 3 — JIT provider establishment in provisioning/operate paths

- `startProvisionSession()` should establish a required missing/dead provider
  session before composing `loginSessionGuidance()`, instead of merely reporting
  provider state.
- The provider requirement should come from the service/skill where known:
  Google-required, GitHub-required, provider-optional, or email-capable.
- GitHub remains optional and JIT. It should never block `connect`; it should
  only be requested when a service path actually needs it.

### Phase 4 — Settings and migration cleanup

- Add `squire settings` as the human-facing place to inspect/switch the bound
  Google identity and optional GitHub session.
- Migrate existing installs by treating "valid account token but no Google bot
  session" as "needs Google login." This is a visible one-time re-onboard, but it
  is correct: those installs were hollow for operate-task.
- Update or archive `DESIGN-multi-provider-onboarding.md` after this design is
  implemented so the docs do not preserve two competing connection models.

## Code touchpoints

- **`apps/mcp/src/install/cli.ts`** — invert the preflight: gate on a live Google
  provider session, not `agentTokenStillValid`. `decideProvisioned` becomes
  "Google session live?" Machine/agent-token issuance moves to background
  provisioning keyed off the authenticated identity; an invalid/expired machine
  token should trigger reissue, not a human re-claim ceremony.
- **`apps/mcp/src/bot/google-login.ts` / `ensureOAuthSession`** — the single
  interactive step (situations 1/3). Already used by install + the old bot run;
  wire it as the connect gate's only human touch, and into `provision_start` so a
  missing/dead session is established *by the substrate* gracefully rather than
  dumped on the host agent to improvise.
- **`apps/mcp/src/bot/provision-session.ts`** (`startProvisionSession`) —
  on a missing/stale provider session, JIT-establish via `ensureOAuthSession`
  before composing `loginSessionGuidance`, instead of only reporting
  `detectSessionProviders`.
- **Account binding (server)** — `apps/api/src/auth/oauth-providers.ts` +
  `oauth-identity-store.ts` already map a provider identity → account. Add the
  bot-profile OAuth claim surface that feeds verified Google identity into this
  path, binds the machine token, and issues the agent session.
- **`squire settings`** — new CLI surface over the existing
  `--force-relogin=<provider>` action.
- **Web login (`apps/api` OAuth + the web/PWA login UI)** — **no change.** Keep
  the optional GitHub button (D6).

## Remaining design risks

1. **Bot-profile OAuth callback UX.** The API needs to complete OAuth in the bot
   Chrome profile while the CLI waits. The current install page already opens in
   that profile, so the flow is feasible, but the user-facing copy should make it
   clear that this Google is both account and bot identity.
2. **Identity display source.** Showing email in connect/settings requires a
   cheap, reliable identity read. Prefer the verified API callback result after
   Phase 2; before that, any local email scrape should be best-effort and never
   authoritative.
3. **Session staleness taxonomy.** "Cookie present but challenged" needs to map
   to `stale` so connect/settings can ask for re-login while provision/operate
   can JIT recover without host-agent improvisation.
