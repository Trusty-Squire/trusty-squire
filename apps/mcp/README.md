<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="96" height="96" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire" />
  </a>
</p>

# Trusty Squire MCP

> **Your AI coding agent's universal signup bot.** Ship faster by letting Claude
> Code, Cursor, Goose, Codex, Cline, and Continue sign up for the SaaS services
> they need — and hand you back a working API key.

<p align="center">
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/v/@trusty-squire/mcp?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/dm/@trusty-squire/mcp?color=cb3837" alt="npm downloads" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@trusty-squire/mcp?color=blue" alt="license" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/stargazers"><img src="https://img.shields.io/github/stars/Trusty-Squire/trusty-squire?logo=github&color=eac54f" alt="GitHub stars" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Trusty-Squire/trusty-squire/ci.yml?branch=main&label=CI&logo=github" alt="CI status" /></a>
  <img src="https://img.shields.io/node/v/@trusty-squire/mcp?logo=node.js&color=339933" alt="node version" />
  <a href="https://glama.ai/mcp/servers/Trusty-Squire/trusty-squire"><img src="https://glama.ai/mcp/servers/Trusty-Squire/trusty-squire/badges/score.svg" alt="Glama MCP server score" /></a>
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
🛠  provision_start { "service_url": "https://postmarkapp.com" }
🛠  provision_observe { "session_id": "..." }
🛠  provision_act { "session_id": "...", "kind": "click", "target": "..." }
🛠  provision_extract { "session_id": "..." }
✔  credentials: { api_key: "0c1b7c2a-..." }
   service: "Postmark"
   stored_in_vault: true
🛠  provision_finish { "session_id": "..." }
```

The agent drives the browser step by step. You see the signup happen in your vault.

## Tools

| Tool | What it does |
|---|---|
| `provision_start` | Open a scoped signup browser session and return the first observation. |
| `provision_observe` | Re-read the current page. |
| `provision_act` | Take one browser action, then return the next observation. |
| `provision_extract` | Reveal/copy credentials from the current credential page. |
| `provision_finish` | Close the browser session. |
| `list_credentials` | Browse what's already in your vault for this account. |
| `use_credential` | Call an API through the write-only vault without exposing the raw secret. |

## How it works

Trusty Squire is a thin local MCP server that delegates the actual signup work to a bundled universal bot:

- **Browser:** real Chrome (channel = `chrome`) via Playwright + `playwright-extra` stealth plugin. Runs headed against an on-demand Xvfb on headless boxes — modern SaaS detect Chromium-headless and gate their forms.
- **OAuth-first:** when the page offers Google or GitHub OAuth and the bot profile has that provider session, the bot takes the OAuth path. Consent screens are auto-approved only for basic identity scopes (`openid` / `email` / `profile`). Anything broader surfaces to you for approval.
- **Email fallback:** for services without OAuth, the bot uses a per-run alias under `@trustysquire.com`, reads inbound mail via AWS SES → S3 → SNS → our API.
- **Captcha handling:** Tier 1 (behavior simulation — bezier mouse paths, variable typing, post-load dwell) for invisible Turnstile / reCAPTCHA v3 scoring. Tier 2 (click-and-wait) for visible Turnstile / reCAPTCHA v2 checkboxes. Tier 3 image grids are out of scope.
- **Session-agent form-fill:** when no OAuth + no native adapter exists, the Trusty Squire session agent drives signup from DOM-grounded page structure and screenshots. Selectors are picked from observed inventory, never invented.

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
