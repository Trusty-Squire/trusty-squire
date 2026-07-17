<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire shield" />
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

<p align="center"><strong>Trusty Squire signs up for websites and gets the API keys, so your coding agent doesn’t have to.</strong></p>

Trusty Squire is an **MCP server that lets Claude Code, Codex, Cursor, Goose, and other coding agents create accounts on real websites and retrieve the API keys automatically** — then saves each key in an encrypted, write-only vault instead of your chat, your code, or your `.env`. The raw provider secret never needs to enter the agent's context, so it can't be pasted into a commit or leaked in a log.

It is not a secrets manager for keys you already have, and not a browser-automation framework you script per site. Point your agent at a service — “set up Clerk and wire in the key” — and Trusty Squire opens a real browser, works through signup or sign-in one step at a time, clears the bot-detection and email-verification steps that make operator tools stall, and captures the generated key. When a real person is required (phone, hard CAPTCHA, payment), it stops and says so rather than pretending the signup completed.

**Built to be handed the keys.** Provider secrets are write-only: the agent's credential tools return references and authenticated results, never stored plaintext. Backend access is a host-scoped, rate-limited, independently revocable grant, so a leaked token is killed without rotating the provider key — and you connect Google or GitHub yourself in a real browser, so the agent never types your password. Full [threat model below](#security-and-threat-model).

## One prompt

```text
Use Trusty Squire to create a Clerk account for this app, save the generated secret key, allow api.clerk.com for server-side requests, and wire it in without putting the raw key in chat, code, or .env.
```

Your coding agent plans the job. Trusty Squire operates the website, stores the generated key, and can issue your backend a scoped grant. The backend calls the provider through Trusty Squire, which injects the provider key on the server side.

Other useful asks:

- “Create a Render API key for deployment automation and keep it out of this conversation.”
- “Set up OpenRouter without returning its API key to this conversation.”
- “That app grant leaked. Revoke it without rotating the provider key.”

## Install

```bash
npx @trusty-squire/mcp connect
```

`connect` signs you in with Google or GitHub, detects your coding agent, and merges the `squire` MCP server into its existing configuration. Restart the agent and ask for the finished website outcome. Trusty Squire is free to start.

To choose a target explicitly:

```bash
npx @trusty-squire/mcp connect --target=codex
```

Supported targets: `claude-code`, `cursor`, `codex`, `goose`, `cline`, `continue`, and `hermes`.

## What happens

1. Your coding agent names the website and the account, setup, or credential it needs.
2. Trusty Squire opens a real browser and works through the service flow one step at a time. It can use a Google or GitHub session that you explicitly connect.
3. When the site reveals an API key or client secret, Trusty Squire captures it into the vault without returning the raw value through its credential tools.
4. The agent can make an authenticated request through Trusty Squire or create a host-scoped, rate-limited app grant.
5. Successful flows can become signed registry skills, so later runs can replay verified steps instead of rediscovering every click.

If a site requires a phone, hard CAPTCHA, payment, or a human decision, the run stops and tells you. It does not guess or pretend the signup completed.

## Supported services

Discovery pages are generated only for services with an active skill in the Trusty Squire registry. The first five detailed pages cover Braintrust, Cerebras, Clerk, DeepInfra, and Zilliz Cloud. Each sample has explicit signup evidence in its active registry record and a provider request checked against official API documentation. The service hub also lists every active registry entry; the remaining detail pages stay unpublished until their workflow and unique content pass review.

Browse the [active service catalog](https://trustysquire.ai/services). Maintainers can detect registry drift before merging with:

```bash
pnpm seo:verify-services
```

The registry controls which service pages exist. An external list is never used to claim support.

## Keep provider keys out of agent context

Ask the agent to create a scoped backend grant:

```text
Grant this backend access to Clerk through Trusty Squire with a limit of 100 requests per hour.
```

Before minting the grant, make `api.clerk.com` the credential's primary allowed host in the Vault. The egress proxy refuses every other upstream host. This explicit policy step is required when the signup host and provider API host differ.

The agent calls the real MCP tool with the service and requested limit:

```text
grant_app_access({
  service: "clerk",
  rate_limit_per_hour: 100
})
```

The result contains a host-scoped egress `base_url` and a `token`, not the Clerk secret key. The token is returned once through the MCP result and remains valid until revoked. That means the scoped grant token can enter agent context; it is not the provider key. Move it directly into backend-only deployment secret storage, never browser code, logs, or source control. If you need zero grant-token exposure to the model, use `use_credential` for agent-initiated requests instead. Trusty Squire removes the grant authorization at the boundary and injects the vaulted provider credential into the upstream request.

## Security and threat model

- Provider credentials are encrypted in the vault and are write-only to agent credential tools. Those tools return references or authenticated results, not stored plaintext.
- The raw provider key is injected only into the outbound provider request. It does not need to land in chat, generated code, the consuming app, or the project's `.env` file.
- App grants are host-scoped, auditable, rate-limitable, and independently revocable. A leaked grant can be revoked without rotating the provider key.
- You connect Google or GitHub in a real browser. Trusty Squire does not ask the coding agent to type those passwords.
- Browser screenshots and diagnostics can contain whatever a website visibly rendered. Treat diagnostic artifacts as sensitive and do not ask an agent to re-observe a page after a secret is shown.
- Trusty Squire does not bypass phone verification, hard CAPTCHAs, payment authorization, or decisions that belong to a person. It stops for human input.

See [Architecture and security](https://github.com/trusty-squire/trusty-squire/blob/main/docs/ARCHITECTURE.md) for the system boundaries and data flow.

## MCP tools

- `operate_start`, `operate_observe`, and `operate_act` open a website, inspect the current state, and perform one browser action at a time.
- `operate_extract` captures a generated credential into a sealed slot or the vault.
- `operate_remember` and `operate_use` save and replay successful website flows.
- `list_credentials` and `use_credential` find saved credentials and make authenticated API calls without returning raw values.
- `grant_app_access` and `revoke_app_access` create and remove scoped backend access.
- `audit_log` reports credential activity without exposing credential values.

## One README for GitHub and npm

This root file is the canonical README. The npm pack lifecycle copies it into `@trusty-squire/mcp` byte-for-byte, then removes the generated package-local copy after packing. GitHub and npm therefore publish the same product explanation.

## Development

```bash
git clone https://github.com/Trusty-Squire/trusty-squire.git
cd trusty-squire
./scripts/bootstrap.sh
```

After bootstrap, `pnpm typecheck` and `pnpm test` should pass. Stop local services with `docker compose -f docker-compose.dev.yml down`; add `-v` to reset their data.

Requirements: Node 20.11.0 (`.nvmrc`), pnpm 8.15+, Docker, and Docker Compose.

Repository map:

```text
trusty-squire/
├── apps/
│   ├── api/        Accounts, OAuth, machine tokens, proxy, inbox, vault, and billing
│   ├── mcp/        MCP server, browser operation tools, and credential tools
│   ├── registry/   Signed website skills and verification service
│   └── web/        Marketing site and vault UI
└── packages/
    ├── vault/        Encrypted credential storage and audit log
    ├── inbox/        Email verification code and link extraction
    └── skill-schema/ Shared schema for replayable website skills
```

Product and public-web changes should follow [PRODUCT.md](https://github.com/trusty-squire/trusty-squire/blob/main/PRODUCT.md) and [DESIGN.md](https://github.com/trusty-squire/trusty-squire/blob/main/DESIGN.md).

## License

[MIT](https://github.com/trusty-squire/trusty-squire/blob/main/LICENSE) © Trusty Squire
