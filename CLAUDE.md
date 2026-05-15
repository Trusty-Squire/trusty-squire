# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this
repository. Concise and precise. Keep it current.

## Project Overview

**Trusty Squire** is a credential broker that lets AI agents (Claude
Code, Cursor, Goose, Cline, Continue) provision SaaS services on behalf
of a user, within a user-signed spending mandate. The MCP server runs
on the user's machine; an API on Fly.io handles persistence and
orchestration.

**Two provisioning paths:**

1. **`provision`** — native adapters for services with known signup APIs
   (Resend, Stripe, etc.). Mandate-bounded, vault-backed, full
   approval flow.
2. **`provision_any_service`** — universal browser-automation bot
   (Playwright + Claude vision) for any other service. Currently
   Tier 0 (anonymous, free, quota-limited).

**Tech stack:** TypeScript monorepo, pnpm workspaces, Fastify API,
Playwright (headless Chromium), Prisma + Postgres, MCP SDK,
OpenRouter for LLM, AWS SES for inbound mail.

## Current State

### Production, deployed, verified end-to-end
- **API on Fly** (`trusty-squire-api.fly.dev`) — Fastify + Prisma,
  v16+ shipped.
- **Inbound mail pipeline.** SES → S3 → SNS → `/v1/webhooks/ses` →
  Prisma. 4 domains configured (`trustysquire.ai`, `helmpoint.ai`,
  `vouchflow.dev`, `speakeasyapp.xyz`). Catch-all + Gmail forwarding
  for personal aliases (`dani@`, `hello@`, `info@`,
  `partnerships@`); the rest land in the inbox store.
- **Postgres persistence (Fly Postgres, `trustysquire-db-1`).** Two
  schemas:
  - `packages/inbox/prisma` → `EmailAlias`, `ReceivedEmail`
  - `apps/api/prisma` → `MachineToken`, `LLMUsageEvent`,
    `PairingToken`
- **Retention cron** (hourly, in-process). Bodies → null at 7d,
  metadata → delete at 90d, pairing tokens → delete at 1h, LLM events
  → delete at 30d. Structured JSON log per run.
- **Universal signup bot** (`packages/universal-bot`):
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
- **Tier 0 install flow.** `npx @trusty-squire/mcp install` issues a
  machine token, writes the host-agent MCP config. No account, no
  mandate. 10 free signups per machine, then pair-CTA.
- **LLM proxy** (`/v1/llm/chat`). User's machine talks to our API,
  which forwards to OpenRouter using the operator's key. Per-machine
  rolling rate limit (150/hour, default). Cost per IPInfo signup:
  ~$0.0006.

### Verified by real signups this session
| Service     | Result | Notes                                        |
|-------------|--------|----------------------------------------------|
| IPInfo      | ✅ full | API key extracted, verified via live API     |
| Postmark    | ✅ post-captcha | Previously blocked by reCAPTCHA v3; passes  |
| Resend      | ✅ post-captcha | Previously blocked by Turnstile; passes     |
| MailerSend  | ⚠ phone gate | Signup completes, stops at phone verification |
| PostHog     | ⚠ slow SPA | Form load races our planner; not captcha    |

### In-memory (not persisted, restart-vulnerable)
- `accountStore`, `sessionStore`, `agentSessionStore`,
  `approvalTokenStore`, `runStore`, `adapterRegistry`,
  `credentialStore`, `vaultAuditStore`. These belong to Tier 1+ paired
  accounts and are not yet exercised in production.

## Active Sprint/Task

**Tier 2 captcha shipped (`b39d0ee5d`).** Visible Turnstile +
reCAPTCHA v2 checkboxes now handled with click-and-wait. Smoke-tested
against Cloudflare's demo site (token populated correctly). On real
SaaS signups, client-side solve works but **server-side CF scoring
can still reject the session** when the fingerprint+IP combo is
suspicious — this is unavoidable without a residential IP, and
the user-machine deployment model already provides that.

**Up next: stabilize and observe.** No new feature work pending;
the universal bot is now feature-complete for the captcha
landscape we can address in-house. Focus shifts to:

1. **Surface bot run telemetry** — bot results currently return
   structured status (`success` / `captcha_blocked` /
   `quota_exceeded` / `not_installed`) but the MCP tool doesn't
   yet surface the full step trail or the `captcha_blocked` kind
   to the user. Worth wiring.
2. **Fix 3 pre-existing test failures** in `routes.test.ts` and
   `mandate.test.ts`. Blocks a clean CI badge.
3. **Domain prewarm at agent level.** `BrowserController.prewarm()`
   exists; agent doesn't call it. Adds first-party cookies before
   navigating to strict signup URLs.

**Not in scope right now:** Tier 3 (audio captcha + Whisper for v2
image grids — rare in dev SaaS), 2Captcha integration (explicitly
not needed given Tier 1+2 results), PWA mark-paired UI, multi-
instance API scaling.

## Next Steps (prioritized)

1. **Surface bot run telemetry to the MCP tool response.** Pass
   `captcha_blocked` status through so Claude can tell the user
   "Postmark requires a captcha we can't auto-solve; sign up
   manually here: <url>".
2. **Surface retention-cron + LLM-usage stats on
   `/v1/install/status`.** The cron logs per run but there's no API
   to inspect current state.
3. **Fix 3 pre-existing test failures** in `routes.test.ts` and
   `mandate.test.ts`. Drift between `auth.account_id` and
   `auth.actor_id` after an earlier refactor. Unrelated to recent
   work but blocks a green CI badge.
4. **Domain prewarm for strict sites.** `BrowserController.prewarm()`
   exists; agent doesn't yet call it. Probably 30 mins of plumbing
   plus a per-service config.
5. **PostHog SPA wait.** Add `waitForSelector` on a known form field
   before invoking the Claude planner.
6. **Tier 1+ work (PWA mark-paired UI, vault delivery, mandate
   signing).** Bigger product surface; pick up when Tier 0 → Tier 1
   conversion becomes a real user funnel.

## Environment Details

### Repo structure (where things live)
```
trusty-squire/
├── apps/
│   ├── api/         Fastify API. Prisma schema in prisma/.
│   ├── mcp/         The MCP server users install on their machines.
│   ├── pwa/         Web UI for approvals + pairing.
│   ├── registry-api/Adapter registry (used by native provision path).
│   └── tooling/     Internal scripts (Vouchflow stub, etc.)
├── packages/
│   ├── inbox/       Email alias + inbound parsing. Owns inbox Prisma schema.
│   ├── runtime/     Run state machine; mandate-validator + run-context.
│   ├── universal-bot/  Playwright + Claude bot. Tier 1 captcha bypass here.
│   ├── vault/       Encrypted credential store.
│   └── ...          Other shared libs (auth, http-clients, etc.)
└── CLAUDE.md        This file.
```

### Build / typecheck / test (per package)
```bash
pnpm -F @trusty-squire/api build
pnpm -F @trusty-squire/api typecheck
pnpm -F @trusty-squire/api test
pnpm -F @trusty-squire/universal-bot build
pnpm -F @trusty-squire/inbox prisma:generate
pnpm -F @trusty-squire/api prisma:generate
```

### Deploy (API only)
```bash
cd apps/api
flyctl deploy
```

Dockerfile generates both Prisma clients before `tsc`. The
`@prisma/client` package is bundled into the runner image.

### Ports / local dev
- API: `API_PORT=3000` (default), `node apps/api/dist/server.js`
- PWA: `pnpm -F @trusty-squire/pwa dev` (Next.js default 3000 — run
  one or the other, not both)
- MCP: invoked by the host agent, not a long-running server

### Fly app names
- `trusty-squire-api`        — main API
- `trusty-squire-pwa`        — web UI
- `trusty-squire-registry`   — adapter registry
- `trustysquire-db-1`        — Postgres (shared by inbox + api schemas)
- (`trusty-squire-mail`)     — DESTROYED. Old postfix server, not in use.

### Fly secrets (set on `trusty-squire-api`)
| Secret | Purpose |
|---|---|
| `INBOX_DATABASE_URL` | Postgres URL for inbox schema |
| `AUTH_DATABASE_URL`  | Postgres URL for api schema (same DB as inbox) |
| `OPENROUTER_API_KEY` | Operator's OpenRouter key for `/v1/llm/chat` proxy |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | SES + S3 for inbound mail |
| `AWS_REGION` | `us-east-1` |
| `SES_INBOUND_BUCKET` / `SES_INBOUND_PREFIX` | Raw email storage |
| `UNIVERSAL_BOT_API_KEY` | Admin bearer for `/v1/inbox/*` + `/v1/llm/chat` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Outbound Gmail forwarding |
| `VOUCHFLOW_CUSTOMER_ID` / `SESSION_JWT_SECRET` | Auth |

### Goose / local-dev MCP install

The official install path (`npx @trusty-squire/mcp install --target=...`)
doesn't support Goose yet. For local dev/testing on a Goose CLI or
Desktop install, hand-write the extension into `~/.config/goose/config.yaml`:

```yaml
extensions:
  trusty-squire:
    type: stdio
    cmd: bash
    args:
    - -c
    - cd /home/<you>/trusty-squire/apps/mcp && exec node dist/server.js
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
| `UNIVERSAL_BOT_MAX_LLM_CALLS` | `15`   | Per-signup circuit breaker |
| `TRUSTY_SQUIRE_MACHINE_TOKEN` | (from session) | Tier 0 token for `/v1/llm/chat` proxy |
| `TRUSTY_SQUIRE_API_BASE` | `https://trusty-squire-api.fly.dev` | API base URL |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` | — | BYOK fallback; skipped when machine token is set |

### Server env knobs (`trusty-squire-api`)
| Env var | Default | Effect |
|---|---|---|
| `LLM_HOURLY_LIMIT` | `150` | Per-machine-token rolling rate cap for `/v1/llm/chat` |
| `MACHINE_TOKEN_QUOTA` | `10` | Free signups per anonymous machine before pair-CTA |
| `LLM_PROXY_CHEAP_MODEL` | `google/gemini-flash-1.5` | Cheap-tier model |
| `LLM_PROXY_PREMIUM_MODEL` | `openai/gpt-4o` | Premium-tier fallback model |
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
