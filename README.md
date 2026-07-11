<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire" />
  </a>
</p>

<h1 align="center">Trusty Squire</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/v/@trusty-squire/mcp?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Trusty-Squire/trusty-squire/ci.yml?branch=main&label=CI&logo=github" alt="CI status" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/stargazers"><img src="https://img.shields.io/github/stars/Trusty-Squire/trusty-squire?logo=github&color=eac54f" alt="GitHub stars" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
</p>

<p align="center"><strong>Never touch a signup form or paste an API key again.</strong></p>

Trusty Squire plugs into your AI coding agent — Claude Code, Cursor, Codex — and takes
over the credential grunt work that slows you down and leaks secrets. Your agent signs
up for the services your project needs, locks every key in a vault it **never leaves**,
and drives the multi-step setup behind any login. You ship at your agent's speed; your
secrets stay put.

### Why developers run it

- **Your agent handles signups & SaaS provisioning.** Ask for a service — your squire
  creates the account and brings back the API key. No fifteen-tab signup detour.
- **No secret ever leaves the vault.** Stop scattering keys across `.env` files and
  cloud secret stores. Keys go in write-only; your code uses them through a proxy that
  injects the value server-side and never hands it back — so there's nothing to leak.
- **Operate anything behind a login.** Complete complex tasks hidden behind auth walls
  with one prompt — wire up OAuth across consoles, configure webhooks, stand up
  projects. Your squire does the click-work; the secret never crosses into chat.

> The store-vs-act difference: everyone else *stores* the keys you already have. Your
> squire *gets* them, wires them up, and rotates them.

## What you can ask your squire

> Plain-English asks. Your squire drives the browser, signs in with **your** identity, and never hands a raw secret back to the agent.

1. **"Sign me up for Resend and vault the API key."**
   An account is created — or signed in with your own Google/GitHub — and the key is extracted, encrypted, and stored. You never see it, and neither does the model.

2. **"Stand up my whole stack."**
   Resend, Sentry, PostHog, a Postgres host — provisioned in one ask, every key vaulted, your app handed one scoped, revocable grant per service. Day-one setup, zero keys on the box.

3. **"Add Google OAuth to my app."**
   A multi-step setup driven across consoles — GCP → OAuth Playground — where a secret captured in one console is *sealed in-session* and typed into the next. The client secret never touches the agent.

4. **"Give my deployed app a scoped, revocable OpenAI key."**
   An **egress grant**: your code calls the provider through a proxy that injects the real key server-side. The raw secret never leaves the vault — your app holds a downgraded, rate-limited, instantly-revocable token instead.

5. **"My local agent should hold no keys."**
   Point a CLI loop's base URL at the grant; it makes real provider calls holding nothing. The key stays vaulted, every call metered, the leash cut whenever you want.

6. **"Give the contractor a key for a week."**
   A rate-limited, spend-capped, revocable grant instead of your real key. They get a leash; you keep the secret and revoke on the spot when they're done.

7. **"Rotate my Stripe key everywhere it's used."**
   Rotated in the vault and picked up transparently by every grant and proxied call — no redeploy, no hunting through configs. Honest about the copies you've pasted into systems we can't reach.

8. **"Something leaked — kill that key now."**
   Revoke the grant instantly; the next call through it is rejected and the app fails closed. Re-mint a fresh grant to recover — no key rotation required.

9. **"Show me everything that touched my keys."**
   The audit ledger — every store, retrieval, rotation, and proxied call, newest first, never a secret value — plus a nudge on anything overdue for rotation.

10. **"Move me off SendGrid with zero downtime."**
    Sign up for the new vendor, vault the key, dual-send through both during cutover, then revoke the old grant when you've switched. No redeploy, no outage.

## Install

Trusty Squire runs as a local MCP server. Point your coding agent at it:

```bash
npx @trusty-squire/mcp@latest connect
```

That issues your account, signs you in (Google/GitHub), and writes the MCP config for
your agent. Then ask your agent to do any of the above in plain language. Full install
notes (Claude Code, Cursor, Codex, Goose, Cline, Continue, Hermes) live in the
[npm package README](apps/mcp/README.md).

## How it works

```
  acquire ───▶ store ───▶ use (scoped) ───▶ observe ───▶ rotate
  sign up &    write-only  egress grant      audit       best-attempt,
  set up       vault       (injecting proxy) ledger      honest failures
```

The raw secret is never handed back to the agent — it's stored write-only and only ever
*injected* server-side by the proxy. A successful run is captured as a learned skill and
published to the registry, so the next person provisioning that service replays it in
~30s instead of the agent re-figuring it out.

---

## Development

```bash
git clone https://github.com/Trusty-Squire/trusty-squire.git
cd trusty-squire
./scripts/bootstrap.sh   # workspace deps + local Postgres/Redis via Docker
```

After it finishes, `pnpm typecheck` and `pnpm test` should pass cleanly.
Stop services: `docker compose -f docker-compose.dev.yml down` · reset data: add `-v`.

**Requirements:** Node 20.11.0 (`.nvmrc`), pnpm 8.15+, Docker + Docker Compose.

### Repository structure

```
trusty-squire/
├── apps/
│   ├── api/        Backend API — accounts, OAuth, machine tokens, LLM proxy, inbox, vault, billing
│   ├── mcp/        The MCP server coding agents install; bundles the universal signup bot + operator surface
│   ├── registry/   Skill registry — signed learned-skill recipes + the housekeeper backplane
│   └── web/        Public site + vault UI (trustysquire.ai)
└── packages/
    ├── vault/        Encrypted credential vault (envelope encryption, per-credential KEK, audit log)
    ├── inbox/        Inbound email — alias allocation, MIME parsing, OTP/link extraction
    └── skill-schema/ Learned-skill wire contract (Zod), shared by the mcp client and the registry server
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the canonical architecture
and security model. The rest of [`docs/`](docs/) is limited to current public
runbooks and product notes.

### Conventions

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no `any`.
- ESM with `.js` import extensions. Tests in `__tests__/` next to source (vitest).
- Comments explain *why*, not *what*.

## License

[MIT](LICENSE) © Trusty Squire
