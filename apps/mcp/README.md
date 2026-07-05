<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire" />
  </a>
</p>

<p align="center"><strong>Never touch a signup form or paste an API key again.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/v/@trusty-squire/mcp?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/dm/@trusty-squire/mcp?color=cb3837" alt="npm downloads" /></a>
  <img src="https://img.shields.io/node/v/@trusty-squire/mcp?logo=node.js&color=339933" alt="node version" />
  <a href="https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
</p>

Trusty Squire plugs into your AI coding agent — Claude Code, Cursor, Codex — and takes
over the credential grunt work that slows you down and leaks secrets. Your agent signs
up for the services your project needs, locks every key in a vault it never leaves, and
drives the multi-step setup behind any login.

## Why developers run it

- **Your agent handles signups & SaaS provisioning** — ask for a service; it creates the account and brings back the API key.
- **No secret ever leaves the vault** — no keys scattered across `.env` files and cloud secret stores; your code uses them through a proxy that injects the value server-side and never hands it back.
- **Operate anything behind a login** — complete complex tasks behind auth walls with one prompt: wire up OAuth across consoles, configure webhooks, stand up projects. The secret never crosses into chat.

## Install

```bash
npx @trusty-squire/mcp connect
```

That issues your account, signs you in (Google/GitHub), auto-detects your coding agent,
and writes the MCP config. Restart your agent to pick up the tools. To pin a target:

```bash
npx @trusty-squire/mcp connect --target=goose
```

Supported agents: `claude-code`, `cursor`, `codex`, `goose`, `cline`, `continue`, `hermes`.

## Example

Ask your agent in plain English:

```
> sign me up for Postmark
```

```
🛠  operate_start      { "service_url": "https://postmarkapp.com" }
🛠  operate_observe    { "session_id": "..." }
🛠  operate_act        { "kind": "click", "target": "..." }
🛠  operate_extract    { "session_id": "..." }
✔  stored in vault    { service: "Postmark", credentials: ["api_key"] }
🛠  operate_finish_task { "kind": "credentials" }
```

The agent drives the browser step by step; the key lands in your vault, never in chat.

## Tools

- `operate_start` / `operate_observe` / `operate_act` — open a scoped browser session, read the page, act one step at a time.
- `operate_extract` — reveal and capture credentials from the current page.
- `operate_remember` / `operate_use` — save a successful run as a skill; replay it by name in ~30s.
- `operate_finish_task` / `operate_finish` — finish with an outcome (store credentials) or just release the browser.
- `grant_app_access` — mint a scoped, revocable key for a deployed app (egress grant).
- `list_credentials` / `use_credential` — browse the vault; call an API through it without exposing the raw secret.

## How it works

A thin local MCP server that drives a real browser on your machine:

- **Browser:** real Chrome via Playwright + a stealth plugin, headed against an on-demand Xvfb on headless boxes (modern SaaS gate Chromium-headless).
- **OAuth-first:** takes the Google/GitHub OAuth path when offered; auto-approves only basic identity scopes (`openid`/`email`/`profile`), surfacing anything broader to you.
- **Email verification:** reads the code or link from *your own* inbox via your signed-in browser, behind a just-in-time consent prompt — no shared aliases.
- **Captcha:** behavior simulation for invisible Turnstile / reCAPTCHA v3; click-and-wait for visible v2.
- **Write-only vault:** the raw secret is stored write-only and only ever *injected* server-side by the proxy — the agent never sees it.

## Configuration

No setup needed for normal use — `connect` wires everything up. Advanced bot
knobs (residential proxy, per-run call cap, API gateway override) are
documented in [the repo](https://github.com/Trusty-Squire/trusty-squire).

## Security & privacy

- The bot **never** types into a Google/GitHub login form (it stops and returns `needs_login`), and never auto-approves OAuth scopes beyond basic identity.
- The MCP server runs on your machine; it does not phone home with traffic data.
- LLM proxy events auto-delete at 30 days; the vault audit trail at 365.

> **Developers note:** if you've cloned this repo, run `connect` from outside it (`cd ~` first). From inside `~/trusty-squire/apps/mcp/`, npm 10's npx mistakes the local workspace for the target and fails `sh: 1: mcp: not found`. End users don't hit this.

## License

[MIT](https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE) © Trusty Squire
