---
name: trusty-squire
description: >-
  Use when a coding agent needs to sign up for a website or SaaS, finish setup
  behind a login, or obtain an API key — and the secret must NOT land in chat,
  source code, or a .env file. Trusty Squire is an MCP server that drives a real
  browser through signup, sign-in, email verification, and bot gates, then vaults
  the captured key write-only. Triggers: "sign me up for X", "get an API key for
  X", "create an account on X", "set up X and save the key", "provision X",
  "let my app call X without the key", "pay this checkout with my saved card",
  "AI agent API key management".
license: MIT
metadata:
  homepage: https://trustysquire.ai
  repository: https://github.com/Trusty-Squire/trusty-squire
  npm: "@trusty-squire/mcp"
---

# Trusty Squire

Trusty Squire is an MCP server your coding agent drives. It signs up for
websites, completes provider setup behind a login, and captures the resulting
API key into an encrypted, **write-only** vault — so the raw secret never enters
your chat, your code, or a `.env` file. This skill is the discoverable wrapper;
the MCP server supplies the actual capabilities.

## 1. When Trusty Squire is appropriate

Use it when the task requires **creating a real account or getting an API key**,
especially when the secret must stay out of the conversation, the repo, and
`.env`. Concretely:

- "Sign me up for Resend / Clerk / <service> and save the API key."
- "Set up <provider>, create a project, generate the key, and wire it in."
- "Get an API key for <service> without showing it to me or putting it in `.env`."
- Finishing authenticated setup — OAuth apps, webhooks, project/region config.
- Using an already-vaulted key to call a provider **without** the raw value
  returning to the agent's context.
- Paying a supported checkout with a saved card after the user approves the
  exact purchase on their phone.

Do **not** reach for it when:

- The key already exists and just needs storing — that is a secrets manager.
- The provider's own API/CLI creates the key without a browser (use that).

## 2. How to install / connect the MCP

Trusty Squire runs on the user's machine. Install and connect in one command:

```bash
npx @trusty-squire/mcp connect
```

To wire a specific host explicitly:

```bash
npx @trusty-squire/mcp connect --target=codex
# targets: claude-code, cursor, codex, opencode, goose, cline, continue, hermes
```

`connect` signs the user in with Google or GitHub, detects the coding agent, and
merges the `squire` MCP server into that agent's config. It is free during beta.

> **Restart the coding agent after `connect`** so it loads the new `squire`
> tools. Until you restart, the tools below are not available.

## 3. How to use its tools safely (after restart)

Once connected and restarted, the `squire` MCP tools appear. The core loop:

- `operate_start`, `operate_observe`, `operate_act` — open the real website and
  drive it one step at a time (signup, sign-in, form fill), clearing bot gates.
- `operate_await_verification` — read the email verification code or link from
  the user's own inbox, behind an explicit consent gate.
- `operate_extract` — capture a revealed API key/secret straight into the
  write-only vault (never back into the conversation).
- `list_credentials`, `use_credential` — find a stored credential and make an
  authenticated API call **without** the raw value returning to the agent; put
  `${SECRET}` (or `${SECRET.field}`) placeholders in the request and the server
  injects the real value at the boundary.
- `grant_app_access`, `revoke_app_access` — mint or instantly revoke a scoped,
  rate-limited egress grant so a deployed app can call the provider while holding
  a revocable token, not the raw key.
- `audit_log` — review what touched a credential; never exposes secret values.
- `list_payment_cards`, `operate_pay` — select a saved card by label or opaque
  reference, request phone approval for the exact purchase, fill the checkout,
  and hand any 3-D Secure challenge back to the user. Card fields never return
  through MCP.

**Safety rules the agent must follow:**

- The vault is **write-only**. Never try to read a secret back to plaintext, and
  never echo a captured key into chat, code, or `.env`. To use a key, call
  `use_credential` or mint an egress grant — the value goes to the provider, not
  to you.
- **Stop for the user** at phone verification, a hard image CAPTCHA, an
  unsupported payment, 3-D Secure, or any decision that belongs to a person.
  `operate_pay` may proceed only after its explicit phone approval succeeds. Do
  not guess, and do not claim a signup finished when it did not.
- The user connects Google/GitHub themselves in the real browser during
  `connect`. Never ask for or type the user's password in chat.

Repo and docs: <https://github.com/Trusty-Squire/trusty-squire> ·
Security model: `SECURITY.md` in that repo.
