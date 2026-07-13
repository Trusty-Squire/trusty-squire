<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire" />
  </a>
</p>

<h1 align="center">Trusty Squire</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/v/@trusty-squire/mcp?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/dm/@trusty-squire/mcp?color=cb3837" alt="npm downloads" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Trusty-Squire/trusty-squire/ci.yml?branch=main&label=CI&logo=github" alt="CI status" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/stargazers"><img src="https://img.shields.io/github/stars/Trusty-Squire/trusty-squire?logo=github&color=eac54f" alt="GitHub stars" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
</p>

<p align="center"><strong>Trusty Squire signs up / in to websites for you so you don’t have to.</strong></p>

Try asking your coding agent:

- **“Sign me up for Resend and save the API key.”**
- **“Sign in to Sentry and configure the webhook.”**
- **“Set up Resend, Sentry, PostHog, and Postgres for this app.”**
- **“Add Google OAuth to my app without showing me the client secret.”**
- **“Let my deployed app call OpenAI without giving it the OpenAI key.”**
- **“That app token leaked — revoke its access now.”**

Trusty Squire is an MCP server for Claude Code, Cursor, Codex, and other coding
agents. It opens the real website, completes the signup or sign-in flow, handles the
setup behind the login, and saves generated credentials without putting them in chat,
source code, or an `.env` file.

## Install

```bash
npx @trusty-squire/mcp@latest connect
```

`connect` signs you in with Google or GitHub, detects your coding agent, and writes its
MCP configuration. Restart the agent, then ask it to do one of the jobs above.

To choose an agent explicitly:

```bash
npx @trusty-squire/mcp@latest connect --target=codex
```

Supported targets: `claude-code`, `cursor`, `codex`, `goose`, `cline`, `continue`,
and `hermes`.

## What happens when you ask

1. Your coding agent tells Trusty Squire which website and task you asked for.
2. Trusty Squire opens a real browser session and works through the site one step at a
   time. It can use your existing Google or GitHub session when you choose that option.
3. If the site creates an API key or client secret, Trusty Squire stores it directly in
   your vault. The raw value is not returned to the coding agent.
4. Your agent can use the saved credential through Trusty Squire, or give your app a
   scoped, rate-limited token that you can revoke without rotating the underlying key.

Successful website flows can be saved and replayed, so the next run does not have to
rediscover every click.

## How secrets are handled

- Generated credentials do not appear in the model context, chat transcript, source
  code, `.env` files, or the consuming app.
- When an API call needs a credential, Trusty Squire injects it into the request on the
  server side. The API provider receives its credential; the caller does not.
- A deployed app receives a scoped Trusty Squire token instead of the provider key.
  Access can be rate-limited, spend-capped where supported, audited, and revoked.
- Trusty Squire does not type your Google or GitHub password. You sign in in a real
  browser, and the browser keeps that session.
- If a site needs a decision or action that should be yours, the run stops and asks
  you instead of guessing.

## MCP tools

- `operate_start`, `operate_observe`, and `operate_act` open a website, read the page,
  and act one step at a time.
- `operate_extract` captures a credential from the current page into a sealed slot or
  stores it in the vault.
- `operate_remember` and `operate_use` save and replay a successful website flow.
- `list_credentials` and `use_credential` find saved credentials and make authenticated
  API calls without returning their raw values.
- `grant_app_access` and `revoke_app_access` give an app scoped access and take it away.
- `audit_log` shows credential activity without exposing credential values.

## Development

```bash
git clone https://github.com/Trusty-Squire/trusty-squire.git
cd trusty-squire
./scripts/bootstrap.sh
```

After bootstrap, `pnpm typecheck` and `pnpm test` should pass. Stop the local services
with `docker compose -f docker-compose.dev.yml down`; add `-v` to reset their data.

Requirements: Node 20.11.0 (`.nvmrc`), pnpm 8.15+, Docker, and Docker Compose.

### Repository structure

```text
trusty-squire/
├── apps/
│   ├── api/        Accounts, OAuth, machine tokens, proxy, inbox, vault, and billing
│   ├── mcp/        The MCP server coding agents install; browser and credential tools
│   ├── registry/   Signed, replayable website skills and their verification service
│   └── web/        Public site and vault UI
└── packages/
    ├── vault/        Encrypted credential storage and audit log
    ├── inbox/        Email verification code and link extraction
    └── skill-schema/ Shared schema for replayable website skills
```

See [docs/ARCHITECTURE.md](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/ARCHITECTURE.md)
for the architecture and security model.

## License

[MIT](https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE) © Trusty Squire
