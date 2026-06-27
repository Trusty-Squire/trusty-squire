# Trusty Squire

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
and rotates them for you. You ship at your agent's speed; your secrets stay put.

### Why developers run it

- **Your agent handles signups & SaaS provisioning.** Ask for a service — your squire
  creates the account and brings back the API key. No fifteen-tab signup detour.
- **No secret ever leaves the vault.** Stop scattering keys across `.env` files and
  cloud secret stores. Keys go in write-only; your code uses them through a proxy that
  injects the value server-side and never hands it back — so there's nothing to leak.
- **Secrets rotate automatically.** Periodic rotation on the services we cover (growing
  weekly) — the hygiene a password manager never actually does for you.

> The store-vs-act difference: everyone else *stores* the keys you already have. Your
> squire *gets* them, wires them up, and rotates them.

## What you can ask your squire

1. **"Sign me up for Resend and put the API key in my vault."** — account created, key extracted and stored.
2. **"Add Google OAuth login to my app."** — a multi-step setup driven across consoles (GCP → OAuth Playground); the secret is never exposed.
3. **"Give my deployed app a scoped OpenAI key, capped at $50/mo."** — an *egress grant*: your code calls through a proxy that injects the key; the raw secret stays vaulted.
4. **"Rotate my Stripe key and update everywhere it's used."** — rotated where we can, honest about what we can't.
5. **"Show me everything that touched my keys in the last 90 days."** — the audit ledger.
6. **"Something leaked — kill that key now."** — revoke the grant on the spot.
7. **"Stand up the same stack for a new project."** — replayed from a saved skill in ~30s.

## Install

Trusty Squire runs as a local MCP server. Point your coding agent at it:

```bash
npx @trusty-squire/mcp connect
```

That issues your account, signs you in (Google/GitHub), and writes the MCP config for
your agent. Then ask your agent to do any of the above in plain language. Full install
notes (Claude Code, Cursor, Codex, Goose, Cline, Continue) live in the
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

## Pricing

- **Free** — provision, store keys, personal proxy use, 7-day audit, manual rotation.
- **Pro ($20/mo)** — egress grants for deployed apps, 365-day audit + export, and
  automated rotation (covered services, growing weekly).
- **Enterprise** — org control plane (shared vault, seats, SSO) + production-scale
  egress. Coming later.

See [`docs/BUSINESS-MODEL.md`](docs/BUSINESS-MODEL.md) for the full model.

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

See [`CLAUDE.md`](CLAUDE.md) for architecture, deploy, and npm-distribution details, and
[`docs/`](docs/) for the design docs.

### Conventions

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no `any`.
- ESM with `.js` import extensions. Tests in `__tests__/` next to source (vitest).
- Comments explain *why*, not *what*.

## License

[MIT](LICENSE) © Trusty Squire
