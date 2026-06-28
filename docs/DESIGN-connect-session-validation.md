# DESIGN — Connect / session-validation state machine

Status: **approved** (2026-06-27). Supersedes the GitHub-status handling in
`apps/web/app/install/page.tsx` and the provider logic in
`apps/mcp/src/install/cli.ts`.

## The problem

The connect flow conflates two different things both rendered as "connected":

1. **Account identity link** — you signed into trustysquire.ai with this
   provider at some point. Server-side (`whoami.identities`), permanent.
2. **Bot session liveness** — the bot's own Chrome profile can actually *act as
   you* on the provider's site right now. Local cookies in the bot profile.

The confirm page drives the provider pills from **#1**, but **#2** is what
actually matters for doing work. The **bot owns the browser**, so it is the only
component that can validate #2 — and the flow never consults it for the GitHub
pill. Consequences observed:

- `--force-relogin=github` clears **#2** (the bot's cookies) but the page reads
  **#1**, so GitHub flips to "connected" the instant Google completes — the
  clear is ignored. force-relogin can't force anything.
- GitHub is **hard-gated behind a required Google step**, so you cannot relogin
  GitHub independently — the only first-load button is Google.
- The noVNC ceremony runs even when **no human login is needed** (Google session
  live + GitHub auto-filled from the link = nothing was ever typed). Theater.

The root inversion: the flow asks a stale server checkbox ("ever linked GitHub?")
instead of asking the bot ("can I act as you on github.com right now?").

## Principle

**The bot validates each provider's SESSION (it owns the browser). A login is
surfaced ONLY when that provider's session is genuinely invalid. Google is the
required gate — but "gate" means the session must be *valid*, not that you
re-login every time; a valid session passes the gate silently.
`--force-relogin=<provider>` forces a clean + identity-choosable login for
exactly that one provider.**

## State machine

"Valid" below = the **bot navigated to the provider and confirmed a live
session** (`detectActiveProviderSessions`, the rc.18 validating path), NOT the
account link.

| Situation (no force-relogin)        | Ceremony                                              |
|-------------------------------------|------------------------------------------------------|
| Google ✗ **and** GitHub ✗           | Raise web for both — Google required, GitHub optional |
| Google ✗ only                       | Raise web for **Google only**; GitHub hidden          |
| GitHub ✗ only (Google ✓)            | **Skip** the ceremony (GitHub is optional) + print a notice (below) |
| Both ✓                              | Skip entirely (already connected)                     |

| force-relogin                       | Ceremony                                              |
|-------------------------------------|------------------------------------------------------|
| `--force-relogin`                   | Clear both; raise web for both (Google required, GitHub optional) |
| `--force-relogin=google`            | Clear Google; raise web for **Google only**, with the account chooser so you pick the identity |
| `--force-relogin=github`            | Clear GitHub; if Google ✓ → raise web for **GitHub only** (Google's gate auto-passes, no redundant Google login); if Google ✗ → Google first, then GitHub |

Throughline: **the ceremony only happens when something genuinely needs a human
login; an already-valid provider's gate passes silently; force-relogin forces a
real, identity-choosable login for exactly the provider named.**

## The "skipped but dead" notice

When connect skips the ceremony because Google is valid + the session is bound,
but a provider (e.g. GitHub) validated as **dead**, print one line:

> GitHub session is dead — run `npx @trusty-squire/mcp connect --force-relogin=github` to refresh.

Silent-skip is fine. Silent-and-you-can't-tell-it's-dead is the lie we are
killing — so a dead session is always surfaced, even when we don't act on it.

## What changes, by layer

**CLI (`apps/mcp/src/install/cli.ts`)** — the brain.
- Validate **every** provider up front (`detectActiveProviderSessions` already
  validates per-provider). Compute, per provider: valid? + force-relogin'd?
- Derive the set of providers that need a login this session:
  - Google needs login iff Google invalid OR force-relogin includes Google.
  - GitHub needs login iff (force-relogin includes GitHub) OR (GitHub invalid AND
    the ceremony is already being raised for Google AND not a scoped relogin that
    excludes it). GitHub never *raises* the ceremony on its own.
- Pass that **login-provider set** to the confirm flow (via install initiate →
  install record), so the page surfaces exactly those steps — and GitHub is no
  longer hard-gated behind Google when Google is already valid.
- Clear the cleared provider(s)' cookies before raising their login so the OAuth
  shows a fresh login / account chooser.
- Print the dead-but-skipped notice.

**API (`apps/api/src/routes/install.ts`)** — carry the signal.
- `install/initiate` accepts a `login_providers` list (which providers the bot
  wants logged in this session) + which is required (google) vs optional.
- `install/<token>/state` returns it so the page can render from it.

**Web (`apps/web/app/install/page.tsx`)** — render the CLI's intent, not the link.
- Surface only the steps in `login_providers`. If it's `[github]` (Google
  valid + force-relogin=github), show **GitHub only** — no Google step.
- The provider pills/step-done reflect **this session's login completion** (did
  the user complete the github OAuth in THIS flow), not `whoami.identities`. The
  account link is used only to know the claim can proceed (an existing bound
  account doesn't force a re-login).
- Drop the hard `disabled={!step1Done}` gate on GitHub when Google isn't part of
  this session's login set.

## Non-goals (for this pass)
- Multi-identity *per provider* beyond what the provider's own account chooser
  offers (we rely on the OAuth account chooser after a cookie clear).
- Auto-driving the github reconnect headlessly — the human still enters
  credentials via noVNC when a login is genuinely required; we just stop
  raising the ceremony when no login is needed.
