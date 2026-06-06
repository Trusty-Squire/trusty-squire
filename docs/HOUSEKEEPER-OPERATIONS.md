# Housekeeper operations runbook

Single source of truth for how the housekeeper runs — its egress, its OAuth
session model, the failure taxonomy, and how to diagnose a stuck sweep.

**If you are debugging a sweep or about to change housekeeper behavior, read
"Mental model" and "Diagnosing needs_login" FIRST.** Most "bugs" here are
session state or infra, not code — and the fastest way to make things worse is
to "fix" a working autonomous flow by hand.

> This file is the canonical operational narrative. CLAUDE.md, `harvester.env`,
> and memory hold **values + a link to here**, never the story — so there is one
> place to update when reality changes (the old fragmentation across those files
> is exactly what caused a session to misdiagnose this on 2026-06-06).

## Mental model (read first)

- The housekeeper is **autonomous**. It takes **no human input**. It replays a
  captured recipe (a Skill) and drives the entire flow — including the
  Google/GitHub OAuth interstitial (account chooser, consent) — itself, via
  `browser.startOAuth` (the same handler the universal signup bot uses to sign
  up via OAuth in the first place). **If you find yourself doing a manual login
  to "help" a sweep, you are driving it wrong.**
- It runs from a **source checkout** on the operator box
  (`node apps/mcp/dist/bin.js housekeeper`), NOT on end-user laptops, and is
  excluded from the npm tarball (`apps/mcp/package.json` `files` omits
  `dist/housekeeper`).
- It rides an **established bot Chrome profile** (`~/.trusty-squire/chrome-profile`)
  that holds the Google/GitHub session. That session is established once and
  reused across every sweep.
- **Cardinal rule:** a sweep failing with `needs_login`, or a sudden
  across-the-board failure, is almost always **session state or infra** — NOT a
  missing capability and NOT a code bug. The bot has driven OAuth autonomously
  for a long time. **Diagnose before you change code, flip egress, or
  re-login.** Doing those casually *perturbs* the working session and makes it
  worse.

## Modes

One CLI, three modes:
- `--mode=verify` (default) — replay queued skills to verify + promote them.
- `--mode=discover` — the universal bot signs up at new/demoted services.
- `--mode=heal` — scheduled closed loop: verify → discover → one digest.
  12h systemd user timer (`tools/systemd/`). Design:
  `docs/DESIGN-closed-loop-remediation.md`.

Env vars per mode live in CLAUDE.md ("Housekeeper env" table) — values only.

## Egress model

- The operator box (Tailscale node `trusty-dev-box`) has a **datacenter** direct
  IP (Miami / ReliableSite).
- A **residential exit** is available via an SSH dynamic-SOCKS tunnel to the Mac
  (`macbook-pro-7`, Tailscale `100.104.88.126`, Seoul SK-Broadband home line):
  ```bash
  ssh -D 1080 -f -N -o ExitOnForwardFailure=yes dani@100.104.88.126   # → 127.0.0.1:1080
  ss -tlnp | grep :1080                                               # is it up?
  curl -s --socks5-hostname 127.0.0.1:1080 https://ipinfo.io/json      # → Seoul, KR (residential)
  ```
- Enable with `UNIVERSAL_BOT_PROXY_URL=socks5://127.0.0.1:1080` +
  `UNIVERSAL_BOT_PROXY_ALWAYS=true` (the box's own ASN reads as
  datacenter/unknown, so force it). `harvester.env` carries the current setting.
- **When egress matters:** captcha / anti-bot signup pages block datacenter IPs,
  so residential egress helps `discover` succeed on those services.
- **When egress does NOT matter:** `needs_login` on OAuth replays.
  **Measured 2026-06-06: posthog returns `needs_login` identically on direct
  (Miami) and proxy (Seoul).** Egress is NOT the cause of OAuth `needs_login` —
  do not chase it.
- If a sweep's pages all `page.goto` timeout while `curl` through the same proxy
  works, the tunnel blipped (shared Miami→Seoul hop) — that's `nav_timeout`
  (transient), not the bot.

## OAuth session model + the DON'Ts

- The bot rides the profile's established Google/GitHub session. On an OAuth
  step it clicks the provider button and `startOAuth` drives the
  account-chooser/consent autonomously.
- `loggedInProviders()` (`apps/mcp/src/bot/login-state.ts`) reads a marker file
  (`logged-in-providers.json`); the replay's `click_oauth_button` guard uses it
  as a fast hint. **The marker can drift** — cookies expire, the user logs out
  at the provider — so the marker says "logged in" when the real session is
  dead, or vice versa.
- **To "fix" a `needs_login`, do NOT reflexively:**
  - **`mcp login --force-relogin`** — it **wipes** the working Google cookies and
    forces a fresh session. A fresh session with no remembered consents + a new
    automation context is *more* likely to hit Google's "verify it's you" and
    bounce. (Tried 2026-06-06; did not help, may have hurt.)
  - **Flip egress** — proven above it is not the cause.
  - **Add code to "drive the interstitial"** — the bot already does this. A
    regression here is session state, not missing logic.

## Failure taxonomy

Canonical definitions: `packages/skill-schema/src/failure-taxonomy.ts` (shared
by the registry's demote classifier and the mcp client). Only **rot** advances
a skill's 3-strike demote counter.

| failure_kind | class | means | effect on the skill | what to do |
|---|---|---|---|---|
| `needs_login` | transient | replay couldn't complete the per-service OAuth handshake | none (never demotes); stays pending-review | diagnose session state — do NOT force-relogin / flip egress reflexively |
| `nav_timeout` | transient | page never loaded (proxy blip, cold tunnel, DNS/TLS/reset) | none (added 2026-06-06 so an egress hiccup can't retire a skill) | retry; check the tunnel |
| `step_failed` / `validator_failed` / `extraction_failed` | rot | a recorded step/selector/validator no longer matches the live page | 3 consecutive → pending-review retired (deleted) / active demoted | genuine staleness — rediscover |
| `captcha_blocked` / `anti_bot_blocked` | wall | terminal anti-bot gate | quarantined on the first hit → human pile | manual signup |

## Running sweeps

```bash
set -a; . ~/.config/trusty-squire/harvester.env; set +a     # bearer, registry URL, proxy, etc.
node apps/mcp/dist/bin.js housekeeper --mode=verify --once --full   # drain the verify queue (~20 skills/pass)
#   --limit=N to canary first; --full actually mints a credential; re-run for more slices
```
- **Verify = the drain.** One success promotes a pending-review skill to active;
  3 consecutive ROT failures retire (pending-review→deleted) or demote (active).
- Inspect registry state (admin-bearer): `GET /admin/needs-human`,
  `GET /admin/verifier/queue`, `GET /skills`.

## Diagnosing needs_login (do this BEFORE changing anything)

1. **All OAuth skills or one?** All → global session state. One → that
   skill/service.
2. **Direct vs proxy.** Run one skill each way (`--limit=1`, toggle the proxy
   env). Same result both ways → it is NOT egress.
3. **Is the profile session actually live?** The marker can lie. Confirm the
   real cookie state, not just `logged-in-providers.json`.
4. **Did something recently perturb the session?** A `force-relogin`, a profile
   wipe, a new egress IP, a concurrent Chrome on the profile. If you just did
   one, that is the suspect — **restore the prior state, don't pile on.**
5. **Only after 1-4 point at code** check `attemptOAuthRecovery` /
   `startOAuth` (`apps/mcp/src/bot/replay-skill.ts`, `browser.ts`) against a
   real capture.

## KNOWN-OPEN ISSUE (2026-06-06): OAuth-skill verify bounces on needs_login

The verify sweep returns `needs_login provider=google step=0` for every OAuth
skill (posthog, kinde, cohere, imagekit, …). Established facts:
- Happens on **both** direct (Miami) and proxy (Seoul) egress → not egress.
- Persists after `mcp login` AND `mcp login --force-relogin` — fresh Google
  session, marker = `["google"]` → a valid Google session alone does not fix it.
- Chain: step-0 `navigate` lands on the service login wall →
  `attemptOAuthRecovery` clicks "Sign in with Google" and polls ~30s for the
  round-trip → it doesn't complete. posthog/kinde fail fast (~7s, OAuth button
  not found on the SPA login page); cohere/imagekit poll the full window.
- **Root cause not yet confirmed.** It is session state / OAuth round-trip, NOT
  a known-missing capability — the bot has driven these autonomously before.
  Leading suspicion: the 2026-06-06 `force-relogin` + egress changes disturbed a
  previously-working session; the prior session may have been the good state.
- **Do not** "fix" this by adding interstitial-driving code or flipping egress.
  Work the Diagnosing section first; the working state likely needs restoring,
  not new code.
