# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this
repository. Concise and precise. Keep it current.

## Project Overview

**Trusty Squire** is a credential broker that lets AI agents (Claude
Code, Cursor, Codex, Goose, Cline, Continue) provision SaaS services on behalf
of a user, within a user-signed spending mandate. The MCP server runs
on the user's machine; an API on Fly.io handles persistence and
orchestration.

**Two provisioning paths:**

1. **`provision`** — native adapters for services with known signup APIs
   (Resend, Stripe, etc.). Mandate-bounded, vault-backed, full
   approval flow.
2. **`provision_any_service`** — universal browser-automation bot
   (Playwright + Claude vision) for any other service. Account-bound,
   free up to `ACCOUNT_FREE_QUOTA` signups before billing kicks in.

**Tech stack:** TypeScript monorepo, pnpm workspaces, Fastify API,
Playwright (headless Chromium), Prisma + Postgres, MCP SDK,
OpenRouter for LLM, AWS SES for inbound mail.

## Current State

### Production, deployed, verified end-to-end
- **API on Fly** (`trusty-squire-api.fly.dev`) — Fastify + Prisma,
  v16+ shipped.
- **Inbound mail pipeline — REVIVED 2026-05-20 on `trustysquire.com`.**
  SES → S3 → SNS → `/v1/webhooks/ses` → Prisma. End-to-end verified
  (Cloudflare MX → SES inbound rule → SNS → webhook → ReceivedEmail).
  Alias domain is now `INBOX_ALIAS_DOMAIN=trustysquire.com` (set on
  `trusty-squire-api`). The previous mothball decision (2026-05-18,
  TODOS M1) was reverted after the Render-class form-fill path shipped
  via F3 — verification email is the only remaining bottleneck for
  those signups.
  - **DO NOT restore SES on `trustysquire.ai`.** Its MX is at Google
    Workspaces and bouncing it breaks personal email (`dani@`, `hello@`,
    …).
  - **Young-domain caveat:** `trustysquire.com` is a fresh-MX domain;
    some services (Resend, Postmark, historically) still silently
    withhold verification mails to fresh-MX. Render-class services
    don't gate on this. Diagnose via the bot's
    `verification_not_sent` status.
  - **AWS SES account is in sandbox** (pending production access
    review, submitted 2026-05-20). Sandbox restricts OUTBOUND only;
    inbound works unconditionally. Self-tests via `aws ses send-email`
    will appear to silently drop — that's the sandbox + self-loop, not
    the pipeline.
- **Postgres persistence (Fly Postgres `trusty-squire-db`).** The two
  Prisma schemas live in **two separate databases** on one cluster —
  they cannot share a database (`prisma db push` drops any table
  outside its own schema):
  - `trustysquire_inbox` ← `packages/inbox/prisma` (`INBOX_DATABASE_URL`)
    → `EmailAlias`, `ReceivedEmail`
  - `trustysquire` ← `apps/api/prisma` (`AUTH_DATABASE_URL`)
    → `MachineToken`, `PairingToken`, `LLMUsageEvent`, `CaptchaEvent`
- **Retention cron** (hourly, in-process). Bodies → null at 7d,
  metadata → delete at 90d, pairing tokens → delete at 1h, LLM events
  → delete at 30d. Structured JSON log per run.
- **Universal signup bot** (`apps/mcp/src/bot/` — bundled into the mcp
  package, no longer a separate npm package):
  - Stealth (`playwright-extra` + stealth plugin)
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
  - Claude vision form planner with parse-failure premium fallback
    (Gemini Flash → GPT-4o)
  - Long-poll inbox client, verification-link click, post-verify
    navigation loop
  - Hard cap of 15 LLM calls per signup (circuit breaker)
- **Single-tier install flow.** `npx @trusty-squire/mcp install` does
  three things in one command:
  1. Issues a machine token (bot-internal credential for LLM proxy +
     inbox alias service).
  2. Opens a browser so the user signs in (Google/GitHub) and confirms
     the machine — binds the install to the account, writes the
     account-bound `agent_session_token` to the local session file.
  3. Runs the one-time OAuth login (the `mcp login` flow folded in —
     Google/GitHub session into the bot's Chrome profile; non-fatal,
     `--skip-login` opts out for CI). Headed (laptop/desktop) is the
     recommended environment; a headless box does a one-time remote-
     browser login (noVNC).
  Every install is account-bound — there is no anonymous tier. Free up
  to `ACCOUNT_FREE_QUOTA` signups (default 10), then `payment_required`
  + `cta_billing_url`. See the 2026-05-18 streamlined-oauth-onboarding
  CEO plan (now combined with the 2026-05-19 single-tier collapse).
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
- **LLM proxy** (`/v1/llm/chat`). User's machine talks to our API,
  which forwards to OpenRouter using the operator's key. Per-machine
  rolling rate limit (150/hour, default). Cost per IPInfo signup:
  ~$0.0006.

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

### In-memory (not persisted, restart-vulnerable)
- `approvalTokenStore`, `runStore`, `adapterRegistry`,
  `vaultAuditStore`. These belong to the deferred native-`provision`
  cluster (adapter registry + mandate engine + native adapters) and
  are not yet exercised in production. `accountStore`, `sessionStore`,
  `agentSessionStore`, and `credentialStore` are Prisma-backed when a
  DB is wired.

## Active Sprint/Task

**0.7.0 closed loop shipped (rc.9).** Skill Promoter end-to-end:
universal-bot success → captured signup → synthesizer-produced
skill → registry → replay on subsequent provisions. Phases 1-8 +
the polish audit complete. The Tier 2 closed loop is now in
production; Tier 1 (universal bot) stays the fallback when no
skill exists or replay fails.

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
   aggregation, native-`provision` reactivation — all still
   queued but not blocking the closed-loop work.

## Environment Details

### Repo structure (where things live)
```
trusty-squire/
├── apps/
│   ├── api/         Fastify API. Prisma schema in prisma/.
│   ├── mcp/         The MCP server users install. Bundles the universal
│   │                signup bot at src/bot/ (Playwright + Claude vision,
│   │                tiered captcha). The bot is NOT a separate package.
│   ├── pwa/         Web UI for approvals + pairing.
│   ├── registry-api/Adapter registry (used by native provision path).
│   └── tooling/     Internal scripts (Vouchflow stub, etc.)
├── packages/
│   ├── inbox/       Email alias + inbound parsing. Owns inbox Prisma schema.
│   ├── runtime/     Run state machine; mandate-validator + run-context.
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
pnpm -F @trusty-squire/inbox prisma:generate
pnpm -F @trusty-squire/api prisma:generate
```

### Deploy (API only)
```bash
# from the repo root — the build context must be the monorepo root
flyctl deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile.fly
```

`fly.toml` builds with `apps/api/Dockerfile.fly`. That Dockerfile runs
`prisma generate` for **both** schemas before `tsc` and deliberately
keeps devDependencies — pruning with `pnpm install --prod` strips the
generated Prisma clients out of `node_modules` and the server then
crashes on boot. The root `Dockerfile` and `apps/api/Dockerfile` are
stale (they reference a `prisma:generate` script that no longer exists)
— don't use them.

### npm distribution (the install path)

**One package** ships to the public npm registry: `@trusty-squire/mcp`
— the MCP server, install CLI, and the bundled universal signup bot
(`src/bot/`). Current published version: `@trusty-squire/mcp@0.6.14`.

The bot used to be a separate `@trusty-squire/universal-bot` package.
That split caused a recurring bug: a bot fix shipped to git, `mcp` was
republished, but `universal-bot` was not — so `npx` users kept the
stale bot. As of `0.1.7` the bot is folded into `apps/mcp/src/bot/`;
one package, one version, no skew. `@trusty-squire/universal-bot` is no
longer published — do not recreate it.

**Pack with `pnpm`, publish the tarball with `npm`.** `pnpm pack`
resolves any `workspace:*` devDeps; the npm account has passkey-based
2FA so plain `npm publish` / `pnpm publish` fail with `EOTP` from a
non-interactive shell. Use an **npm Automation token**:

```bash
cd apps/mcp && pnpm pack
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_AUTOMATION_TOKEN" > /tmp/np
npm publish apps/mcp/trusty-squire-mcp-<ver>.tgz --access public --userconfig /tmp/np
rm -f /tmp/np
```

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
- PWA: `pnpm -F @trusty-squire/pwa dev` (Next.js default 3000 — run
  one or the other, not both)
- MCP: invoked by the host agent, not a long-running server

### Fly app names
- `trusty-squire-api`        — main API
- `trusty-squire-pwa`        — web UI
- `trusty-squire-registry`   — adapter registry
- `trusty-squire-db`         — Postgres-flex cluster. Two databases:
  `trustysquire` (api schema) + `trustysquire_inbox` (inbox schema).
- (`trusty-squire-mail`)     — DESTROYED. Old postfix server, not in use.

### Fly secrets (set on `trusty-squire-api`)
| Secret | Purpose |
|---|---|
| `INBOX_DATABASE_URL` | Postgres URL — `trustysquire_inbox` db (inbox schema) |
| `AUTH_DATABASE_URL`  | Postgres URL — `trustysquire` db (api schema) |
| `OPENROUTER_API_KEY` | Operator's OpenRouter key for `/v1/llm/chat` proxy |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | SES + S3 for inbound mail |
| `AWS_REGION` | `us-east-1` |
| `SES_INBOUND_BUCKET` / `SES_INBOUND_PREFIX` | Raw email storage |
| `UNIVERSAL_BOT_API_KEY` | Admin bearer for `/v1/inbox/*` + `/v1/llm/chat` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Outbound Gmail forwarding |
| `VOUCHFLOW_CUSTOMER_ID` / `SESSION_JWT_SECRET` | Auth |
| `VOUCHFLOW_READ_KEY` | Vouchflow server-side read key. Optional today (only needed once revocation/introspection paths land). **Never hardcode it** — `config/vouchflow.ts` sources it from env only. |

**Webhook auth:** inbound mail arrives only via SES (`/v1/webhooks/ses`),
which verifies the SNS signing certificate — no pre-shared secret needed.
The Mailgun, Resend, postfix, and fly-email webhook routes were removed;
SES is the sole inbound path. The inbox schema gained an `issued_to`
column for alias ownership; run `pnpm -F @trusty-squire/inbox prisma
migrate deploy` against the inbox database on the next deploy.

### Skill registry (0.7.0)

Lives at `apps/registry-api/`. Separate Fly app:
`trusty-squire-registry`. Holds skills, capture sidecars, replay
outcomes, extract failures. The mcp package is its only public
client (universal bot reports outcomes; skill CLI publishes +
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
  Override with `connect --registry-url=<url>`, disable with
  `connect --no-registry` (skips the router entirely → universal bot
  only).
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

`npx @trusty-squire/mcp install --target=goose` writes the extension to
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
    description: Trusty Squire universal signup bot
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
| `UNIVERSAL_BOT_PREFER_CHEAP` | `true` | Gemini Flash primary, premium fallback only on parse-failure |
| `UNIVERSAL_BOT_LLM_TIER` | `cheap` | Primary LLM tier — `cheap`, `premium`, or `free`. `free` routes through OpenRouter's free models with a paid escape-hatch; the closed-loop verifier worker sets this. End-user installs leave it unset. |
| `UNIVERSAL_BOT_MAX_LLM_CALLS` | `15`   | Per-signup circuit breaker |
| `UNIVERSAL_BOT_PROXY_URL` | — | Residential proxy (`http://user:pass@host:port` or `socks5://host:port`). Unset → direct connection. Used only for datacenter-class egress (see `shouldRouteThroughProxy`) — residential users pay nothing. |
| `UNIVERSAL_BOT_PROXY_ALWAYS` | `false` | Force the proxy on regardless of detected ASN class — for networks that misclassify as `unknown`. |
| `TRUSTY_SQUIRE_MACHINE_TOKEN` | (from session) | Machine token for `/v1/llm/chat` proxy + inbox alias service |
| `TRUSTY_SQUIRE_ACCOUNT_ID` | (from session) | Operator account ID. Required when running `mcp verifier-worker --mode=discovery` (inbox-alias scoping + auto-promote attribution). End-user installs read this from session.json. |
| `TRUSTY_SQUIRE_API_BASE` | `https://trusty-squire-api.fly.dev` | API base URL |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` | — | BYOK fallback; skipped when machine token is set |

### Housekeeper env (`mcp housekeeper`)

The merged verifier + discoverer + harvester. Runs on the operator's
headless dev server, NOT on end-user laptops, and NOT shipped in the
npm tarball (`apps/mcp/package.json`'s `files` array excludes
`dist/housekeeper`). Run from a source checkout:
`node apps/mcp/dist/bin.js housekeeper [opts]`.

Three queue modes share one CLI; each requires different auth.

| Env var | Required by | Effect |
|---|---|---|
| `REGISTRY_ADMIN_BEARER` | verifier, discovery | `/admin/*` auth on the registry. Generate + rotate via fly secrets. |
| `TRUSTY_SQUIRE_REGISTRY_URL` | all modes | Registry base URL. Default `https://registry.trustysquire.ai`. |
| `TRUSTY_SQUIRE_MACHINE_TOKEN` | discovery, seed, --service | LLM proxy + inbox alias auth (operator's own machine token; `mcp connect` on the housekeeper host). |
| `TRUSTY_SQUIRE_ACCOUNT_ID` | discovery, seed, --service | Inbox-alias scope + auto-promote attribution. |
| `TRUSTY_SQUIRE_AUTO_PROMOTE` | discovery, seed, --service | Default-on. Set `0`/`off` to capture without publishing. |
| `UNIVERSAL_BOT_LLM_TIER=free` | all modes (recommended) | Routes through the free OpenRouter chain. |
| `TELEGRAM_BOT_TOKEN` | `--telegram` notifier | Bot token from @BotFather. Chat id auto-resolved from getUpdates on first run, cached to `~/.trusty-squire/telegram-chat-id.txt`. |
| `GH_REPO` | `--github-issues` notifier | `<owner>/<repo>` for issue posting. Default `Trusty-Squire/trusty-squire`. Requires `gh auth status` to succeed on the host. |

The archived harvester lives at `tools/archived-harvester/`; its
`services.yaml` is still the canonical curated list, consumed via
`mcp housekeeper --queue=seed --from=tools/archived-harvester/services.yaml`.

### Server env knobs (`trusty-squire-api`)
| Env var | Default | Effect |
|---|---|---|
| `LLM_HOURLY_LIMIT` | `150` | Per-machine-token rolling rate cap for `/v1/llm/chat` |
| `ACCOUNT_FREE_QUOTA` | `10` | Free signups per account before `payment_required` (alias: `MACHINE_TOKEN_QUOTA`, the prior name) |
| `LLM_PROXY_CHEAP_MODEL` | `google/gemini-flash-1.5` | Cheap-tier model |
| `LLM_PROXY_PREMIUM_MODEL` | `openai/gpt-4o` | Premium-tier fallback model |
| `LLM_PROXY_FREE_MODEL` | `google/gemini-2.0-flash-exp:free` | Free-tier primary (verifier worker). |
| `LLM_PROXY_FREE_FALLBACK_1` | `meta-llama/llama-3.2-90b-vision-instruct:free` | Free-tier second-hop. |
| `LLM_PROXY_FREE_ESCAPE` | `google/gemini-2.0-flash-001` | Paid escape-hatch when both free models 503/rate-limit. Costs less than cheap-tier defaults. |
| `INBOX_BODY_RETENTION_DAYS` | `7` | Body_text/html nulled after this many days |
| `INBOX_METADATA_RETENTION_DAYS` | `90` | ReceivedEmail rows deleted after this |
| `PAIRING_TOKEN_RETENTION_HOURS` | `1` | PairingToken row sweep |
| `LLM_EVENT_RETENTION_DAYS` | `30` | LLMUsageEvent row sweep |

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
