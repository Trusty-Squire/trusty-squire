<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="96" src="https://trustysquire.ai/squire.svg" alt="Trusty Squire" />
  </a>
</p>
<h1 align="center">
  Trusty Squire MCP
</h1>
<h3 align="center">
  Your AI coding agent's universal signup bot
</h3>
<p align="center">
  Ship faster by letting Claude Code, Cursor, Goose, Codex, Cline, and Continue<br/>
  sign up for the SaaS services they need — and hand you back a working API key.
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp">
    <img src="https://img.shields.io/npm/v/@trusty-squire/mcp.svg" alt="npm version" />
  </a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" />
  </a>
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp">
    <img src="https://img.shields.io/npm/dm/@trusty-squire/mcp.svg" alt="npm downloads" />
  </a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg" alt="node >=20" />
</p>

---

## What it does

You tell your coding agent: *"sign me up for Resend"*. Behind the scenes, Trusty Squire:

1. Drives a real Chrome browser through the service's signup flow (OAuth path preferred, email form fallback, captcha and consent screens handled).
2. Receives the verification email at a one-shot alias under `@trustysquire.com`, clicks the link, navigates to the API-key page.
3. Extracts the API key and stores it in your vault — the agent gets a working credential back.

You stay in control: the bot only requests basic OAuth scopes by default, surfaces phone / SMS / scope-broadening prompts back to you, and never types into a provider's login form.

## Install

```bash
npx @trusty-squire/mcp connect
```

That's it. The installer auto-detects your coding agent and writes the MCP config. To pin a target:

```bash
npx @trusty-squire/mcp connect --target=goose
```

Supported agents: `claude-code`, `cursor`, `codex`, `goose`, `cline`, `continue`.

After connecting, restart your agent to pick up the new tools.

> **Renamed in 0.6.14:** the command used to be `install`. The old
> `install` spelling still works (with a deprecation warning) and will
> stay around for one major version.

> **Developers only** — if you've cloned this repo and are running the
> command from inside `~/trusty-squire/apps/mcp/`, npm 10's npx will
> mistake the local workspace for the install target and fail with
> `sh: 1: mcp: not found`. Always `cd ~` (or anywhere outside the
> repo) before running the connect command. End users don't hit this
> because they don't have the source checked out.

## Example

Once installed, ask your agent in plain English:

```
> sign me up for Postmark
```

```
🛠  provision_any_service { "service": "Postmark" }
✔  Signup started — run_id=mcp-mp7f4k8a-1c4e3f8a

🛠  check_provision_status { "run_id": "mcp-mp7f4k8a-1c4e3f8a" }
✔  status="success"
   service: "Postmark"
   credentials: { api_key: "0c1b7c2a-..." }
   stored_in_vault: true
```

The agent uses the key immediately. You see the signup happen in your vault.

## Tools

| Tool | What it does |
|---|---|
| `provision_any_service` | Start a signup. Returns a `run_id`. Async — takes 1–5 minutes. |
| `check_provision_status` | Poll a run. Returns `running`, `success`, or one of the failure modes below. |
| `list_credentials` | Browse what's already in your vault for this account. |
| `get_credential` | Read a specific credential by service or id. |

## Status responses

`check_provision_status` returns one of:

| Status | Meaning | What to do |
|---|---|---|
| `running` | Bot is mid-flow. Response carries `recent_steps[]` + `user_action_required` flag. | Poll again in ~30s. If `user_action_required=true`, surface the latest step to the user. |
| `success` | Credentials extracted + stored. | Done. Show credentials. |
| `verification_not_sent` | Service withheld the verification email (anti-abuse on fresh domains). | Manual signup. |
| `captcha_blocked` | Site uses a captcha the bot can't pass. | Manual signup. |
| `oauth_required` | Service only offers OAuth/SSO. The bot's Google session is missing. | Run `npx @trusty-squire/mcp login` then retry. |
| `oauth_consent_needs_review` | Service requested OAuth scopes beyond basic identity. Response lists `requested_scopes` and `unauthorized_scopes`. | Show the list to the user; on approval, retry with `allow_extra_oauth_scopes=[...]`. |
| `anti_bot_blocked` | Site's anti-bot gateway (Cloudflare/Sucuri/DataDome/Imperva) refused the bot's IP/fingerprint risk score. | Manual signup. |
| `onboarding_blocked` | Signed in OK, but the API key sits behind a billing/payment wall. | User must add a payment method, then retry. |
| `needs_login` | One-time bot Google/GitHub session expired or missing. | Run `npx @trusty-squire/mcp login`. |
| `payment_required` | This account hit the free signup quota. | Visit the `cta_billing_url` to upgrade. |

## How it works

Trusty Squire is a thin local MCP server that delegates the actual signup work to a bundled universal bot:

- **Browser:** real Chrome (channel = `chrome`) via Playwright + `playwright-extra` stealth plugin. Runs headed against an on-demand Xvfb on headless boxes — modern SaaS detect Chromium-headless and gate their forms.
- **OAuth-first:** when the page offers `Continue with Google` and your profile has a valid Google session, the bot takes the OAuth path. Consent screens are auto-approved only for basic identity scopes (`openid` / `email` / `profile`). Anything broader surfaces to you for approval.
- **Email fallback:** for services without OAuth, the bot uses a per-run alias under `@trustysquire.com`, reads inbound mail via AWS SES → S3 → SNS → our API.
- **Captcha handling:** Tier 1 (behavior simulation — bezier mouse paths, variable typing, post-load dwell) for invisible Turnstile / reCAPTCHA v3 scoring. Tier 2 (click-and-wait) for visible Turnstile / reCAPTCHA v2 checkboxes. Tier 3 image grids are out of scope.
- **Vision-planned form-fill:** when no OAuth + no native adapter, Claude (or Gemini Flash as the cheap default) reads a DOM-grounded element inventory + a page screenshot and emits a single JSON plan per turn. Selectors are picked from the inventory, never invented.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TRUSTY_SQUIRE_API_BASE` | `https://trusty-squire-api.fly.dev` | API gateway URL |
| `UNIVERSAL_BOT_PREFER_CHEAP` | `true` | Use Gemini Flash for vision planning; premium model fallback only on parse failure |
| `UNIVERSAL_BOT_MAX_LLM_CALLS` | `15` | Per-signup circuit breaker |
| `UNIVERSAL_BOT_PROXY_URL` | — | Residential proxy (`socks5://host:port` or `http://user:pass@host:port`). Used only for datacenter-class egress unless `UNIVERSAL_BOT_PROXY_ALWAYS=true`. |
| `UNIVERSAL_BOT_HEADLESS` | `false` | Force Chromium-headless. Set `true` only when you specifically want no display surface. |

## Supported coding agents

| Agent | MCP config location |
|---|---|
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Codex CLI | `~/.codex/config.toml` |
| Goose | `~/.config/goose/config.yaml` |
| Cline | `<VS Code globalStorage>/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Continue | `~/.continue/config.yaml` |

Each writer is idempotent: re-installing won't duplicate entries, and any env vars previously written are preserved on re-install.

## Security boundaries

The bot is allowed to do, on your behalf:
- Fill an email/password signup form with a generated email + password.
- Approve a provider OAuth consent screen *only* when every requested scope is basic identity (`openid` / `email` / `profile`).
- Click verification links arriving at our one-shot per-run aliases.

The bot will **never**:
- Type into a Google/GitHub login form. If it lands on one, it stops and returns `needs_login`.
- Auto-approve OAuth scopes broader than basic identity. It returns `oauth_consent_needs_review` and surfaces the scope list to you.
- Persist or transmit your Google password. You enter it once during `mcp login` directly on Google's page.

## Privacy

- The MCP server runs on your machine. It does not phone home with traffic data.
- Per-run email aliases auto-expire (body text cleared at 7 days; row deleted at 90 days).
- LLM proxy usage events are retained for 30 days then deleted.
- Source: [github.com/Trusty-Squire/trusty-squire](https://github.com/Trusty-Squire/trusty-squire).

## License

MIT. See [LICENSE](https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE).
