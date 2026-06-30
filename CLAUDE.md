# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this
repository. Concise and precise. Keep it current.

## Project Overview

**Trusty Squire** is a credential broker that lets AI agents (Claude
Code, Cursor, Codex, Goose, Cline, Continue) provision SaaS services on behalf
of a user, within a user-signed spending mandate. The MCP server runs
on the user's machine; an API on Fly.io handles persistence and
orchestration.

**One provisioning path:**

**Interactive operator driver** — the host agent plans each step with
`operate_start`, `operate_observe`, `operate_act`, `operate_extract`,
and `operate_finish_task`/`operate_finish`; Trusty Squire supplies the scoped
browser, DOM/screenshot observations, vault extraction, and registry hints.
Account-bound, vault-backed. Provisioning is free during beta (no signup quota).
Closed-loop with the skill registry: successful runs publish a Skill that
subsequent provisions replay in ~30s instead of the ~6min a from-scratch
host-driven run takes.

The hand-authored manifest + mandate-engine path was sunset in 0.8, the
old async signup tool was removed from the public MCP surface, and the
**autonomous self-driving "universal bot" (`agent.ts`) was retired** — the
host agent now does the planning over the operator-driver toolkit, so there
is no in-process LLM planner or circuit breaker to maintain. The operator
driver covers every service the team would have written a native adapter
for, faster than the manifest work paid for itself.

**Tech stack:** TypeScript monorepo, pnpm workspaces, Fastify API,
Playwright (headless Chromium), Prisma + Postgres, MCP SDK,
Resend for inbound + outbound mail.

## Objective Function (what this project optimizes for)

**There is one objective function: maximize the probability that the
project successfully executes the signup/provision the user actually
asked for.** Every run, and most feature work, should move this up and
nothing else down.

- "The signup the user needs" is the unit — not an abstract registry
  count. For a simple service that's one account+key. For a **composite
  navigation case (e.g. provisioning GCP) it is a nested chain of
  multiple provisions** that all have to land for the task to count as
  done; the objective is the probability the *whole* chain completes,
  not any single hop.
- The skill registry and the auto-promote loop are **means, not the
  end** — a published skill matters only because replaying it raises the
  success probability (and cuts a ~6min from-scratch run to a ~30s
  replay) on the next request for that service. Grow the registry when
  it lifts that probability; don't optimize skill count for its own sake.

**How it's driven + monitored:** every host-driven provision capture
feeds **auto-promote on real provisions** (`provision_*` captures), which
publishes a skill on a virgin success. The daily **verify pass**
(`ts-housekeeper`, now its own repo
`Trusty-Squire/trusty-squire-housekeeper`) keeps the registry honest —
promote skills that still work, demote ones that don't — so replay stays
a reliable contributor to the success probability rather than a source of
silent failures.

## Current State

### Production, deployed, verified end-to-end
- **API on Fly** (`trusty-squire-api.fly.dev`) — Fastify + Prisma,
  v16+ shipped.
- **Email verification — the user's own inbox.** Signups are user-owned:
  the operator reads the verification code/link from the user's own Gmail
  through their signed-in browser session (`operate_await_verification`),
  behind a JIT consent gate. The Squire-alias inbound-mail subsystem
  (`packages/inbox`, the resend-inbound webhook) was retired in 1.0.1 —
  no aliases are minted and nothing receives inbound mail server-side.
  Operator-side OTP still arrives via the bot's own Gmail over IMAP
  (`operator-otp-poller.ts`, see `OPERATOR_IMAP_*` below). Resend is
  still used for **outbound** notification mail.
- **Postgres persistence (Fly Postgres `trusty-squire-db`).** One database,
  `trustysquire` ← `apps/api/prisma` (`AUTH_DATABASE_URL`) →
  `MachineToken`, `PairingToken`, `LLMUsageEvent`, `CaptchaEvent`,
  `VaultAuditEvent`. (The second `trustysquire_inbox` database was dropped
  with the inbound-mail retirement.)
- **Retention cron** (hourly, in-process). Bodies → null at 7d,
  metadata → delete at 90d, pairing tokens → delete at 1h, LLM events
  → delete at 30d. Structured JSON log per run.
- **Operator-driver toolkit** (`apps/mcp/src/bot/` — bundled into the mcp
  package, no longer a separate npm package). NOT an autonomous bot: the
  **host agent** (Claude Code / Codex / etc.) plans each step via the
  `operate_*` MCP tools; this toolkit supplies the scoped browser, the
  observation/extraction/replay primitives, and the anti-detection layer.
  The self-driving `agent.ts` planner + its 15-call circuit breaker were
  retired with the `retire-universal-bot` work — planning now lives in the
  host agent, not in-process. What the toolkit provides:
  - Stealth (`playwright-extra` + stealth plugin) patches ~17
    client-side tells (navigator.webdriver, etc.).
  - **Browser-automation fingerprinting is mitigated by `patchright`**
    (a maintained Playwright fork that closes the CDP-level tells the
    stealth plugin can't — `Runtime.enable`/mainWorld/webdriver/viewport).
    **Default-ON since 2026-06-08** (`BOT_CDP_HARDENED`, opt out with
    `=0`); `getChromium()` in `browser.ts` loads it and falls back to the
    baseline only if patchright isn't installed. `stealthProfile` reports
    `cdp_hardened` vs `baseline`. So **do NOT re-diagnose a block as
    "automation fingerprinting" without first confirming patchright did
    NOT load** — that class of tell is already addressed.
  - **Tier 1 captcha bypass: behavior simulation** (bezier mouse,
    variable typing with thinking pauses, post-load dwell, hover
    hesitation). No model, no per-solve cost. Handles invisible-mode
    Turnstile + reCAPTCHA v3 scoring.
  - **Tier 2 captcha handling: click-and-wait** for visible Turnstile
    and reCAPTCHA v2 checkboxes. Detects widget by iframe URL, clicks
    at checkbox position via humanized path, polls for response token
    (`cf-turnstile-response` or `g-recaptcha-response`) populated, up
    to 30s timeout. Returns `captcha_blocked` on timeout so the MCP
    tool can surface a clear status to the user.
  - User-inbox verification read (`operate_await_verification` reads the
    code/link from the user's own signed-in Gmail behind a JIT consent
    gate), verification-link click, and post-verify navigation primitives
    the host agent drives via `operate_*`.
  - DOM/screenshot observation + vault-backed credential extraction +
    operator-recipe replay (`operate_use`) the host agent composes per step.
- **Single-tier install flow.** `npx @trusty-squire/mcp connect` does
  three things in one command:
  1. Issues a machine token (bot-internal credential for the operator
     inbox-OTP service).
  2. Opens a browser so the user signs in (Google/GitHub) and confirms
     the machine — binds the install to the account, writes the
     account-bound `agent_session_token` to the local session file.
  3. Runs the one-time OAuth login (the `mcp login` flow folded in —
     Google/GitHub session into the bot's Chrome profile; non-fatal,
     `--skip-browser` opts out for CI). Headed (laptop/desktop) is the
     recommended environment; a headless box does a one-time remote-
     browser login (noVNC).
  Every install is account-bound — there is no anonymous tier.
  Provisioning is free during beta (the signup quota + `402 payment_required`
  paywall were removed; see `docs/BUSINESS-MODEL.md`). See the 2026-05-18
  streamlined-oauth-onboarding CEO plan (now combined with the 2026-05-19
  single-tier collapse).
  - **0.6.0 — install preflight (rc.15).** Re-installs with a valid
    session file + bot Google session skip the browser dance entirely
    and just rewrite the MCP config. Pass `--force-relogin` to bypass.
  - **0.6.0 — writeConfig env merge (rc.21/rc.22).** All five host
    agents now merge env on top of any previously-set vars rather
    than replacing wholesale. A re-install that omits a flag (e.g.
    forgets `--proxy-url=`) no longer wipes the previously-set value.
- **F13 — headed signups via on-demand Xvfb (0.6.0).** Modern SaaS
  (Cloudflare/Stytch, Clerk, Auth0) detect Chromium-headless and gate
  their signup forms. `BrowserController.start()` now spawns a
  temporary Xvfb at 1280x720x24 when DISPLAY is unset and Xvfb is
  available, launches Chrome with `headless: false`, and tears Xvfb
  down on `close()`. The user never sees it — it exists only so Chrome
  has a real display surface to render against. Falls back to true
  headless (with a stderr warning) when Xvfb isn't installed.
- **Anti-bot interstitial handling (0.6.0).** `BrowserController.
  waitForFormReady` now polls for "Just a moment..." / "Verifying
  you are human" / "Checking your browser" text patterns and waits
  up to 15s for them to clear, with a `page.reload()` retry when the
  interstitial outlasts the first wait. When it still won't clear
  AND no scope-grant verb phrases are visible in the page DOM, the
  bot returns `anti_bot_blocked` (distinct from the misleading
  `oauth_required` it used to return). Vendors detected: Cloudflare,
  Sucuri, DataDome, Imperva.

### Verified by real signups
| Service     | Result | Notes                                        |
|-------------|--------|----------------------------------------------|
| IPInfo      | ✅ full | API key extracted, verified via live API     |
| Postmark    | ✅ post-captcha | Previously blocked by reCAPTCHA v3; passes  |
| Resend      | ✅ post-captcha | Previously blocked by Turnstile; passes     |
| Sentry      | ✅ full | OAuth + multi-row permission grid (scope_hint) |
| OpenRouter  | ✅ full | Copy-button extraction (F10)                 |
| Render      | ⚠ verification mail | Form-fill OK; inbox revival on `trustysquire.com` 2026-05-20 unlocks |
| Vercel      | ⚠ SMS gate | OAuth completes, phone verification (F12) — user-relayed SMS pending |
| Cloudflare  | ⚠ anti-bot | Their own dashboard runs maximum Turnstile + IP risk-score; manual signup is the realistic call |
| MailerSend  | ⚠ phone gate | Signup completes, stops at phone verification (F12) |
| PostHog     | ⚠ slow SPA | Form load races our planner; not captcha    |

### Persistence
- `vaultAuditStore` is Prisma-backed (`PrismaVaultAuditStore` →
  `VaultAuditEvent`) when `AUTH_DATABASE_URL` is set, in-memory
  otherwise. It is surfaced via `GET /v1/vault/audit` and swept by the
  retention cron (`VAULT_AUDIT_RETENTION_DAYS`, default 365). All other
  stores (`accountStore`, `sessionStore`, `agentSessionStore`,
  `credentialStore`) are likewise Prisma-backed once a DB is wired.

## Active Sprint/Task

**Self-improving loop:** the host agent drives each provision step and its
retries/escalation via `operate_*` (there is no in-package state machine
anymore — the old `provision-state.ts`/`provision-policy.ts` classifier died
with the autonomous bot). The skill-promotion pipeline (virgin success →
registry skill) is the "Skill-Promotion Pipeline" section of `AGENTS.md`; the
mechanical promote/demote rule lives in `apps/registry/src/skill-store.ts`.

**0.7.0 closed loop shipped (rc.9).** Skill Promoter end-to-end:
host-driven provision success → captured signup → synthesizer-produced
skill → registry → replay on subsequent provisions. Phases 1-8 +
the polish audit complete. The closed loop is in production; a
from-scratch host-driven operator run is the fallback when no skill
exists or replay fails.

**Multi-credential scaffolding landed (Phases B/C/D/G of
`docs/DESIGN-multi-credential.md`).** Schema + synthesizer +
replay engine + shadow-test harness all in place. Single-cred
byte-equivalence preserved (no existing skill's canonical bytes
change). Phase E (planner prompt expansion) and Phase F (bundle
sentinel HTTP auth) explicitly deferred — both gated behind
LLM-mode shadow validation and a real multi-cred service on the
roadmap.

**Up next: stabilize-and-observe the closed loop in production.**
Promote a captured Railway skill, exercise the replay path,
verify the ~6min → ~30s improvement. Then surface telemetry
around skill replay success rates so the auto-demotion threshold
can be tuned against real data.

## Next Steps (prioritized)

1. **Field-test the closed loop on Railway.** Run a Railway signup
   against rc.9; promote the capture; run a second Railway signup
   and verify it goes through the skill in ~30s. Iterate on
   rejection codes that surface from real captures.
2. **Set `SKILL_VERIFY_PUBLIC_KEY` on `trusty-squire-registry`.**
   Generate a matching `SKILL_SIGNING_PRIVATE_KEY` for whoever runs
   `skill promote` (dev machine + future CI). Until this lands,
   skill publishes are length-only-validated (route logs a warn
   per publish).
3. **LLM-mode shadow test baseline.** Run
   `RUN_LLM_SHADOW=true pnpm test src/bot/__tests__/planner-shadow.test.ts`
   against the current prompt + curated corpus. Establish the
   "all 14 single-cred fixtures stay in single-cred vocabulary"
   baseline. Costs ~$2. Explicit prerequisite for multi-cred Phase E.
4. **Multi-cred Phase E + F when a real multi-cred service shows
   up.** Twitter / Stripe / OpenAI. The schema + synthesizer +
   replay engine are ready; only the planner prompt + per-service
   auth code remain.
5. **Surface skill-replay telemetry.** Today the registry tracks
   replays_succeeded / replays_failed but nothing exposes them as
   an operator dashboard. A simple `mcp skill list --health`
   summary (sortable by failure rate) would surface skills that
   need re-promotion before auto-demotion kicks in.
6. **Demotion webhook listener.** The registry POSTs to
   `TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL` on auto-demote but no
   listener exists yet. Slack / GitHub-issue / pager wiring is
   straightforward once the URL is configured.
7. **Older deferred items.** Bot-run telemetry surfacing
   (`captcha_blocked` kind in MCP response), retention-cron stats
   on `/v1/install/status`, domain prewarm at agent level,
   PostHog SPA wait, billing surface, per-account quota
   aggregation — all still queued but not blocking the
   closed-loop work.
8. **Egress Grants (roadmap, `docs/DESIGN-egress-grants.md`).**
   `use_credential` generalized to a standing workload identity: the agent
   mints a scoped, revocable token so a *deployed app* can call providers
   through the injecting proxy — raw key still never leaves Squire. Reuses
   `HttpProxyExecutor` (`/v1/vault/use`) + the `/v1/llm/chat` token+rate-limit
   pattern; turns the vault into a revoke/rotate/spend-cap control plane.
   Not started; v1 scope cut + milestones in the doc.
   - **v0.3 candidate — `squire proxy` local front-door (Castellan/`ser`).** A
     loopback-only shim (`OPENROUTER_BASE_URL=http://127.0.0.1:PORT/v1`) that lets a
     CLI loop runtime on the same box make LLM calls holding NO credential — the key
     is injected server-side (the `/v1/llm/chat` path), metered per-loop. Answers the
     "vending is brittle" objection (nothing to vend). Decision: server-side
     injection over a local sidecar (key stays in Squire; accepts a Squire-API
     hot-path dependency). Section + milestones in the doc. After closed-loop
     stabilization; not now.

## Environment Details

### Repo structure (where things live)
```
trusty-squire/
├── apps/
│   ├── api/         Fastify API. Prisma schema in prisma/.
│   ├── mcp/         The MCP server users install. Bundles the
│   │                operator-driver toolkit at src/bot/ (scoped Playwright
│   │                browser, observation/extraction/replay primitives,
│   │                tiered captcha). Host-agent-driven; NOT a separate
│   │                package, NOT an autonomous bot.
│   ├── registry/    Skill registry — published Skill recipes + the
│   │                housekeeper backplane (extract failures, bot-failure
│   │                aggregation, compat-score). Sole publish surface
│   │                since the native-provision sunset (0.8).
│   └── tooling/     Internal scripts
├── packages/
│   ├── vault/       Encrypted credential store.
│   └── ...          Other shared libs (auth, http-clients, etc.)
└── CLAUDE.md        This file.
```

### Build / typecheck / test (per package)
```bash
pnpm -F @trusty-squire/api build
pnpm -F @trusty-squire/api typecheck
pnpm -F @trusty-squire/api test
pnpm -F @trusty-squire/mcp build       # builds the bundled bot too
pnpm -F @trusty-squire/mcp test        # mcp + bot tests, one suite
pnpm -F @trusty-squire/api prisma:generate
```

### Deploy (API only)

**CI-AUTOMATED — the API deploys on push to `main` when `apps/api/**` (or the
workspace packages it bundles: vault/skill-schema, or the lockfile)
changes.** `.github/workflows/release-api.yml` runs typecheck+test as a gate,
then `flyctl deploy --remote-only` to `trusty-squire-api` (the `release_command`
runs `prisma db push` for the api schema). Pushes to `staging` run tests only,
no deploy. This exists because a manual-only API deploy let the mcp client ship
a feature whose server route was never deployed (egress grants 404'd in prod,
0.9.15). Server + client now ship together.

**Manual deploy = fallback only** (CI down, or deploying an un-merged branch):
```bash
# from the repo root — the build context must be the monorepo root
flyctl deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile.fly
```

`fly.toml` builds with `apps/api/Dockerfile.fly`. That Dockerfile runs
`prisma generate` for **both** schemas before `tsc` and deliberately
keeps devDependencies — pruning with `pnpm install --prod` strips the
generated Prisma clients out of `node_modules` and the server then
crashes on boot. The legacy root `Dockerfile` and `apps/api/Dockerfile`
(which referenced a `prisma:generate` script that no longer exists) have
been removed — only the `*.fly` Dockerfiles remain.

### npm distribution (the install path)

**One package** ships to the public npm registry: `@trusty-squire/mcp`
— the MCP server, install CLI, and the bundled operator-driver toolkit
(`src/bot/`). Latest stable is `1.0.0` (next dev line `1.0.1-rc.x`).

The bot used to be a separate `@trusty-squire/universal-bot` package.
That split caused a recurring bug: a bot fix shipped to git, `mcp` was
republished, but `universal-bot` was not — so `npx` users kept the
stale bot. As of `0.1.7` the bot is folded into `apps/mcp/src/bot/`;
one package, one version, no skew. `@trusty-squire/universal-bot` is no
longer published — do not recreate it.

**RELEASING IS CI-AUTOMATED — DO NOT publish from a laptop, and never ask
for the npm token (it lives in GitHub Actions secrets, not locally).**
`.github/workflows/release.yml` is the publisher. It fires on **push to
`main` or `staging`** whenever `apps/mcp/package.json`'s `version` changes
(path-filtered to the mcp tarball's inputs), re-runs lint+typecheck+test as
a gate, then `npm publish`es `@trusty-squire/mcp@<version>` with provenance
and cuts a GitHub release `v<version>`. It is idempotent: if tag `v<version>`
already exists it's a no-op, so re-pushing `main` without a version bump does
NOT republish.

The release SOP — `pnpm release:mcp <version>` automates steps 1-2 (bump +
CHANGELOG seed + branch + PR to the right channel):
1. Bump `apps/mcp/package.json` `version` (the **source of truth**).
   - `main`  → a **stable** semver (e.g. `0.8.17`) → publishes the `latest` tag.
   - `staging` → a **prerelease** (e.g. `0.8.18-rc.1`) → publishes the `next` tag.
   (A branch↔shape mismatch fails the workflow loudly.)
2. Open a `release-<version>` PR → `main` (stable) or `staging` (prerelease).
   **`main` is branch-protected** — no direct pushes; the PR must pass CI
   (`secret-scan` + `typecheck` + `test`) before it can merge (0 approvals
   required, so a solo maintainer is never blocked). `staging` is unprotected,
   so RC bumps may still be pushed straight to it.
3. Merge it. The release workflow publishes to npm + creates the GitHub
   release automatically. Confirm with `gh run watch` / `npm view
   @trusty-squire/mcp dist-tags`.

**Manual publish = EMERGENCY FALLBACK ONLY** (CI down, registry outage —
needs the operator's Automation token, which a normal release never touches):

```bash
cd apps/mcp && pnpm pack   # pnpm resolves workspace:* devDeps
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_AUTOMATION_TOKEN" > /tmp/np
npm publish apps/mcp/trusty-squire-mcp-<ver>.tgz --access public --userconfig /tmp/np
rm -f /tmp/np
```
(The account's passkey-2FA makes plain `npm publish`/`pnpm publish` fail with
`EOTP` non-interactively, which is why the manual path needs the Automation
token — but again, prefer the CI path and don't go looking for the token.)

**npx workspace-collision gotcha (don't lose this).** Never run
`npx @trusty-squire/mcp <cmd>` from inside `~/trusty-squire/apps/mcp/`
(or any cwd whose `package.json` declares `"name":
"@trusty-squire/mcp"`). npm 10's npx then treats the dev workspace as
the source and tries to run the bin via the local `.bin/` shim —
which pnpm workspaces don't create — and you get
`sh: 1: mcp: not found`. Solution: `cd ~` (or anywhere outside the
repo) first. Not fixable in our package; this is npm 10's workspace-
resolution behavior. End users don't hit it because they don't have
the source repo locally.

**MCP package launch model (hardened in 0.1.4 — don't regress it).**
The package has exactly **one bin**, `mcp` → `dist/bin.js`, matching
the unscoped package name so `npx @trusty-squire/mcp <subcommand>`
always resolves. `bin.ts` is the *only* file with a shebang and
top-level execution; it dispatches `server` → `runServer()` and
everything else → `runCli()`. `server.ts` and `install/cli.ts` are
pure modules — no shebang, no `import.meta.url === argv[1]` "am I
main?" guard. That guard was wrong in both files (it fails under a bin
symlink) and caused three shipped bugs; the structural fix is that
there is nothing to guard. The installer writes an absolute
`node <dist/bin.js> server` config (deterministic, no per-launch npx
resolution), falling back to pinned `npx @trusty-squire/mcp@<ver>
server` only when it is itself running from npx's cache.
`src/__tests__/bin-smoke.test.ts` spawns the built artifact through a
bin symlink and would catch any regression of the above.

### Ports / local dev
- API: `API_PORT=3000` (default), `node apps/api/dist/server.js`
- Web app: `pnpm -F @trusty-squire/web dev` (Next.js default 3000 — run
  one or the other, not both)
- MCP: invoked by the host agent, not a long-running server

### Fly app names
- `trusty-squire-api`        — main API
- `trustysquire`             — web UI / product site (`apps/web`), at
  trustysquire.ai. Fly auto-stop/auto-start (idle → machine stops, wakes
  on first request), so it shows "suspended" when idle but still serves.
- `trusty-squire-registry`   — adapter registry
- `trusty-squire-db`         — Postgres-flex cluster. One database:
  `trustysquire` (api schema). (The `trustysquire_inbox` db was dropped
  with the inbound-mail retirement in 1.0.1.)
- The old `trusty-squire-mail` postfix server was deleted 2026-06-02. Its
  `mailserver/` config + the Gmail-forwarding doc were removed with it.

### Fly secrets (set on `trusty-squire-api`)
| Secret | Purpose |
|---|---|
| `AUTH_DATABASE_URL`  | Postgres URL — `trustysquire` db (api schema) |
| `RESEND_API_KEY` | Resend outbound notification mail |
| `UNIVERSAL_BOT_API_KEY` | Admin bearer for `/v1/inbox/*` (operator-OTP / workspace-inbox polling) |
| `OPERATOR_IMAP_USER` / `OPERATOR_IMAP_PASSWORD` | IMAP creds for the operator's **single** mail identity — the bot's Google account (`lunchbox@trustysquire.ai`, the trustysquire.ai Workspace account, served by imap.gmail.com). Read-only — backs `operator-otp-poller.ts` for the `email_otp_required` gate (Porter, Koyeb, anthropic, other WorkOS-backed services whose OTP goes to the OAuth-bound inbox). The legacy `GMAIL_USER`/`GMAIL_APP_PASSWORD` names are still read as a fallback (un-migrated deploys). One identity, one inbox — do NOT reintroduce a separate personal-gmail credential. A Google account password change silently invalidates app passwords (no revocation notice); if the gate returns `imap_auth_failed`, regenerate the app password and reset the secret. Verify locally with `tools/test-operator-imap.mjs`. |
| `SESSION_JWT_SECRET` | Auth — HS256 secret signing web-session JWTs. **Required in production**: the server throws on boot if unset (no insecure dev fallback). |
| `STRIPE_SECRET_KEY` | Stripe secret key. Server creates Checkout + Billing-Portal sessions for `/v1/billing/*`. **Unset → billing routes register but 503** (`stripeClientFromEnv()` returns null). Use a `sk_test_` key until live billing is verified. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` signing secret for `/v1/webhooks/stripe`. The SDK verifies the `Stripe-Signature` over the raw body; a bad/missing signature is rejected 400. |
| `STRIPE_PRICE_ID` | `price_…` of the monthly subscription Checkout uses. Created once against the Stripe Product (via the vault proxy or dashboard). |

**Billing (Stripe):** **free during beta** — checkout is kill-switched OFF
unless `BILLING_ENABLED=true`/`1` (`/v1/billing/checkout` returns `503
billing_disabled`), so a stray Upgrade click can't charge anyone even with a
live Stripe key. The signup-quota `402 payment_required` paywall was removed
(provisioning is free); see `docs/BUSINESS-MODEL.md` for the planned Free/$20-Pro
model (egress + audit + future rotation, gated on control-plane routes, NOT
signup count). When billing is enabled, the web app's `/billing` page opens
Stripe Checkout (`POST /v1/billing/checkout`, web-session-authed); on payment
Stripe fires `/v1/webhooks/stripe` which flips `subscription_status` to `active`.
Manage/cancel via the Customer Portal (`POST /v1/billing/portal`). `Account`
columns (`stripe_customer_id`, `subscription_status`, `subscription_id`,
`current_period_end`) apply via the deploy's `db push` (all nullable/defaulted
— non-destructive).

**Webhook auth:** the live inbound webhook is Stripe's
(`/v1/webhooks/stripe`, raw-body HMAC). The Squire-alias inbound-mail
webhook (`/v1/webhooks/resend-inbound`) and the whole inbound-mail
subsystem were retired in 1.0.1 — no aliases are minted, so nothing
arrives server-side. The historic SES + S3 + SNS pipeline was retired
earlier; Mailgun + postfix + fly-email routes never shipped.

### Skill registry (0.7.0)

Lives at `apps/registry/`. Separate Fly app:
`trusty-squire-registry`. Holds skills, capture sidecars, replay
outcomes, extract failures. The mcp package is its only public
client (host-driven provisions report outcomes; skill CLI publishes +
manages skills).

**Why separate from the rest of the API:** different deployment
lifecycle (mcp ships via npm, registry via Fly), different trust
boundary (Ed25519 signing keys + DB creds belong on the server,
never on user laptops), different state ownership (skills are
institutional memory shared across users; storing them in the mcp
package would defeat the whole 0.7.0 thesis).

**Production env vars on `trusty-squire-registry`:**
- `ADAPTER_SIGNING_PRIVATE_KEY` (PKCS8 DER, base64url) — for
  manifest signing.
- `SKILL_VERIFY_PUBLIC_KEY` (SPKI DER, base64url) — verifies
  POST /skills bodies. Generate as a keypair with the mcp
  client's `SKILL_SIGNING_PRIVATE_KEY`. **Unset = length-only
  fallback + warn log — acceptable for staging, sloppy for prod.**
- `TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL` (optional) — fired
  fire-and-forget on auto-demotion (3 consecutive failures).

**Client env on user machines:**
- `TRUSTY_SQUIRE_REGISTRY_URL` — base URL. **Auto-wired by `connect`
  as of rc.10**; defaults to `https://registry.trustysquire.ai`.
  The URL is not user-configurable; disable registry participation with
  `connect --no-registry`.
- `SKILL_SIGNING_PRIVATE_KEY` — required for `mcp skill promote`
  (operator-explicit signing). Auto-promote (rc.13+) falls back to
  an ephemeral Ed25519 keypair when this is unset, so the closed
  loop runs without operator-level signing infra. The explicit CLI
  still exits CONFIG (3) without a key — that's the intended loud
  failure mode for the operator-publish path.
- `TRUSTY_SQUIRE_AUTO_PROMOTE` — auto-promotion on successful bot
  signups. **Default-on as of rc.14.** Opt out with `"false"` /
  `"0"` / `"off"`. After a bot run succeeds, the bot package fires
  fire-and-forget against the local capture: synthesizes a skill,
  signs it (real key if configured, otherwise an ephemeral one),
  posts to the registry. Failures land in the signup's step trail
  with the `[auto-promote]` prefix and never fail the parent signup.
- `TRUSTY_SQUIRE_ONBOARDING_CAPTURE` — capture directory. Default-on
  as of rc.11 — `~/.trusty-squire/corpus/onboarding/` when unset.
  Auto-promote reads this via `resolveCaptureDir()` so the default
  path is honored without any env work. Set to `off` / `0` / `false`
  to suppress capture entirely.

### Goose / local-dev MCP install

`npx @trusty-squire/mcp connect --target=goose` writes the extension to
`~/.config/goose/config.yaml` (modern goose's config file) — works for
npx-installed users as of 0.4.2. (Before 0.4.2 it wrote `profiles.yaml`,
the old pre-1.0 path, so goose never saw it.)

For **local dev** against this monorepo checkout, the installer's
`node dist/bin.js server` command fails under Goose Desktop (it spawns
extensions with `cwd=/`, and the monorepo's deps aren't hoisted — see
below). Hand-write a cwd-anchored wrapper into
`~/.config/goose/config.yaml` instead:

```yaml
extensions:
  trusty-squire:
    type: stdio
    cmd: bash
    args:
    - -c
    - cd /home/<you>/trusty-squire/apps/mcp && exec node dist/bin.js server
    enabled: true
    bundled: false
    name: trusty-squire
    description: Trusty Squire operator-driver MCP server
    envs: {}
    timeout: 300
```

**Why the `bash -c "cd ... && exec node ..."` wrapper?** Goose Desktop
spawns extensions with `cwd=/`. Our MCP server's deps live in
`apps/mcp/node_modules` (not hoisted by pnpm), so launching from `/`
fails with `Cannot find package '@modelcontextprotocol/sdk'`. The
wrapper anchors the cwd before exec.

Restart Goose Desktop fully after editing the config — it caches
extension state on launch and won't reload mid-session.

### Bot env knobs (set in the user's MCP config or shell)
| Env var | Default | Effect |
|---|---|---|
| `TWOCAPTCHA_API_KEY` | — | Optional Tier 3 captcha solver — fallback after the Tier 2 click-and-wait times out on a reCAPTCHA v2 image challenge. ~$0.003/solve. Skipped for Turnstile + reCAPTCHA v3 (those score at the IP layer; solver tokens get rejected). **Preferred path is the VAULT, not this env var:** `connect`/`settings` advanced setup prompts for the key and stores it encrypted as the `2captcha` credential; the captcha gate spends it through the injecting proxy (`use_credential`, `${SECRET}` in the `key` query / `clientKey` body) so the raw key never lives in the bot process or the MCP config. `buildTwoCaptchaSolver` prefers the vaulted cred and falls back to this env var for back-compat. The 2Captcha solve is a back-channel token fetch (the v2 token is injected into the user's real browser session and isn't IP-bound), so routing it through the vault adds no target-side fingerprinting. |
| `UNIVERSAL_BOT_PROXY_URL` | — | Residential proxy (`http://user:pass@host:port` or `socks5://host:port`). Unset → direct connection. Used only for datacenter-class egress (see `shouldRouteThroughProxy`) — residential users pay nothing. (The old operator-housekeeper egress/proxy model was retired with the codex-verify refactor — the housekeeper no longer drives its own browser.) |
| `UNIVERSAL_BOT_PROXY_ALWAYS` | `false` | Force the proxy on regardless of detected ASN class — for networks that misclassify as `unknown`. |
| `TRUSTY_SQUIRE_MACHINE_TOKEN` | (from session) | Machine token for the operator inbox-OTP service |
| `TRUSTY_SQUIRE_ACCOUNT_ID` | (from session) | Operator account ID (auto-promote attribution on provisions). End-user installs read this from session.json. |
| `TRUSTY_SQUIRE_API_BASE` | `https://trusty-squire-api.fly.dev` | API base URL |
| `TRUSTY_SQUIRE_SESSION_FILE` | — | `1`/`true`/`yes` forces the durable file session backend (`~/.config/trusty-squire/session.json`) over the OS keychain. Set it **globally** (so `connect` and the spawned server agree) on headless boxes where the keychain is present-but-ephemeral (gnome-keyring "session" collection) — otherwise the session isn't persisted and `connect` re-opens the install/noVNC page every run. |

### Housekeeper — extracted to its own repo

The registry verify pass (codex-driven promote/demote) was **moved out of this
monorepo into its own closed-source operator repo:
`Trusty-Squire/trusty-squire-housekeeper`** (the `@trusty-squire/housekeeper` /
`ts-housekeeper` package). It depends on the published
`@trusty-squire/skill-schema`, runs from a source checkout (never npm-published),
and carries its own README + `docs/` + systemd units.

Monorepo-side relationship: it talks to the registry's `/admin/verifier/queue`,
`/skills/by-id/:id`, and `/admin/skills/:id/verifier-outcome` endpoints
(`apps/registry`), which own the **mechanical rule** — one success promotes
pending-review → active, the 3rd consecutive *rot* failure demotes
(`VERIFIER_PROMOTION_THRESHOLD = 1` / `VERIFIER_FAILURE_THRESHOLD = 3` in
`apps/registry/src/skill-store.ts`). So changing the promote/demote behavior is a
**registry** change here; changing how skills are verified is a change in the
housekeeper repo.

### Server env knobs (`trusty-squire-api`)
| Env var | Default | Effect |
|---|---|---|
| `API_ACCOUNT_HOURLY_LIMIT` | `1000` | Per-account rolling-hour cap on the authed control plane (every `requireWeb`/`requireAgent`/`requireAny` route — vault store/list/use, grant mint, etc.). DoS backstop; returns `429 {error:rate_limited, scope:account}`. The deployed-app egress PROXY runs on a separate grant-token path with its own per-grant cap, so this doesn't throttle workloads. `<= 0` disables. In-memory / single-instance. |
| `INSTALL_IP_HOURLY_LIMIT` | `100` | Per-IP rolling-hour cap on `POST /v1/install` (machine-token mint). The install route is unauthed/pre-account so the per-account limiter can't cover it, and each mint inserts a DB row — this is the flood backstop (surfaced by the #12 load test). Keyed off Fly's `fly-client-ip` header (req.ip is the proxy). Returns `429 {error:rate_limited, scope:ip}`. Generous so shared-NAT/re-installs don't trip it; `<= 0` disables. In-memory / single-instance. |
| `EGRESS_DEFAULT_RATE_PER_HOUR` | `1000` | Default per-grant rate cap applied when `grant_app_access` is called WITHOUT `rate_limit_per_hour` (was unlimited-by-default — abuse protection). An explicit `rate_limit_per_hour` (1..100000) still overrides. |
| `BILLING_ENABLED` | `false` | Free-during-beta kill-switch. Unless `true`/`1`, `/v1/billing/checkout` returns `503 billing_disabled` so no one is charged even with a live Stripe key. |
| `SIGNUPS_DISABLED` | `false` (signups ENABLED) | Global kill switch (checklist #10). When `1`/`true`, `POST /v1/install` returns `503 signups_disabled` AND the OAuth callback refuses to create a BRAND-NEW account (redirects to `/login?error=signups_disabled`). Existing accounts/identities still sign in. Read at build time — flip with `flyctl secrets set SIGNUPS_DISABLED=1` (restarts the machine, ~30s). |
| `EGRESS_DISABLED` | `false` (egress ENABLED) | Global kill switch (checklist #10). When `1`/`true`, both `POST /v1/egress/grants` (mint) and the transparent proxy `ALL /v1/egress/:grant/*` return `503 egress_disabled` — this intentionally kills EXISTING grants too (the point of a panic switch). Flip with `flyctl secrets set EGRESS_DISABLED=1` (restarts the machine, ~30s). |
| `MAINTENANCE_MESSAGE` | `""` (no maintenance) | Global maintenance banner string (checklist #10). Non-empty → `GET /v1/status` returns `maintenance:true` + `message:<this>` for a web banner to read. Empty = no maintenance. Read at build time — set with `flyctl secrets set MAINTENANCE_MESSAGE="..."` (restarts the machine, ~30s). `GET /v1/status` (public, no auth) also surfaces `signups_enabled` / `egress_enabled`. |
| `PAIRING_TOKEN_RETENTION_HOURS` | `1` | PairingToken row sweep |
| `VAULT_AUDIT_RETENTION_DAYS` | `365` | VaultAuditEvent row sweep (the who-touched-my-keys trail). Kept a year — long enough for a compromise investigation, bounded so it doesn't grow forever. |
| `VAULT_ROTATION_STALE_DAYS` | `90` | Age (since last change) past which a credential is flagged `stale` in the list response. Advisory nudge, not enforced. |

### Vault security + lifecycle surface

The credential vault's operational runbook lives at
`docs/VAULT-OPERATIONS.md` — master-key custody + rotation
(`LOCAL_KMS_KEY` keyring, `rewrap-kek` migration), the full endpoint
table (audit timeline, kill-switch `revoke-all`, GDPR export +
erasure, undelete `restore`, envelope `health`, rotation-age `stale`),
retention, and backup/DR posture. Read it before touching the vault.

Master-key secrets (set on `trusty-squire-api`, **also back up the key
out-of-band** — a DB restore is useless without it):

| Secret | Purpose |
|---|---|
| `LOCAL_KMS_KEY` | Current master key (64 hex / 32 bytes). Wraps every credential's KEK. Unset → ephemeral dev key (loud warning, unrecoverable). |
| `LOCAL_KMS_LEGACY_KEYS` | Comma-separated old keys, tried on decrypt. Set only during a master-key rotation window; unset after `rewrap-kek --apply`. |

### Conventions in this repo
- **Always read before editing.** Reach for `tree` + `cat` before
  `edit`/`write`.
- **TypeScript strict.** No `any`; use `unknown` + narrow.
- **No `as` casts** unless you've exhausted typed alternatives. The
  one place we do it (lazy Prisma client load) is commented.
- **Comments explain *why*, not *what*.** The code already says what.
- **One canonical name per concept.** Prefer renames over coexistence
  when a refactor changes the model.
- **No backwards-compat shims.** Update all callers when changing
  shape.
- **Tests live in `__tests__/` next to source.** Use `vitest`.
- **Never assume.** If you don't know, ask or test.
- **Read `STATE.md` (repo root) BEFORE diagnosing a discovery-service
  failure.** It is the graveyard of FALSIFIED hypotheses (we keep
  re-deriving "it's the IP / fingerprint" and keep getting proven wrong by
  experiment) plus the confirmed-real fixes and the genuinely-unservable
  dequeues. Form a hypothesis, name the experiment that would falsify it,
  run it, record the result there. The CF-Turnstile "wall" is the standing
  example: IP-reputation and GPU/fingerprint hypotheses are both falsified
  (a fresh-IP, real-GPU laptop still fails) — the cause is the bot/automation
  layer, likely post-OAuth, NOT the environment.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore

## Design System

Read `DESIGN.md` (repo root) before any visual or UI change to `apps/web`.
Fonts (Geist + JetBrains Mono), the color ramp, spacing/type/radius scales,
component patterns, and motion are defined there. Don't deviate without
explicit approval; flag any code that diverges. The vault is mono-forward
(machine values in `--font-mono`); the app is Linear-leaning polished dark.
