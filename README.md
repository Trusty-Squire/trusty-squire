# trusty squire

Your squire handles the rest.

Trusty Squire is a fiduciary agent that signs up for SaaS services on behalf of vibe coders. The agent holds API keys, pays bills within a user-set spending policy, and handles email/SMS verification automatically — so the developer can stay in their editor instead of context-switching to fifteen signup forms per project.

## Quick start

```bash
git clone <this repo> trusty-squire
cd trusty-squire
./scripts/bootstrap.sh
```

That installs workspace dependencies, brings up local Postgres/Redis/MailHog via Docker, and reports the service URLs. After it finishes, `pnpm typecheck` and `pnpm test` should pass cleanly.

Stop services: `docker compose -f docker-compose.dev.yml down`
Reset data:    `docker compose -f docker-compose.dev.yml down -v`

## Requirements

- Node 20.11.0 (see `.nvmrc`; `nvm use` if you have nvm)
- pnpm 8.15+ (`npm install -g pnpm@8.15.0`)
- Docker + Docker Compose

## Repository structure

```
trusty-squire/
├── packages/
│   ├── adapter-sdk/        # Learned-skill schema SDK — the wire contract every
│   │                       #   registry-stored skill is validated against. (Named
│   │                       #   "adapter-sdk" for compat; the original adapter-manifest
│   │                       #   types were sunset in 0.8 along with the native-provision path.)
│   ├── vault/              # Encrypted credential vault (envelope encryption, per-credential KEK, audit log)
│   ├── inbox/              # Inbound email: alias allocation, MIME parsing, OTP/link extraction
│   ├── runtime/            # Shared orchestration runtime
│   ├── mandate-validator/  # Spending-mandate verification
│   └── adapters/
│       └── resend/         # Resend adapter (legacy native-provision path; retained)
└── apps/
    ├── api/                # Backend API gateway — accounts, OAuth, machine tokens, LLM proxy, inbox, vault
    ├── inbox-api/          # Inbound-mail webhook + parsing service
    ├── registry/           # Skill registry — signed learned-skill recipes + housekeeper backplane
    ├── mcp/                # MCP server coding agents install; bundles the universal signup bot
    ├── web/                # Public site: marketing landing + vault UI (trustysquire.ai)
    └── pwa/                # User-facing web app (Next.js)
```

See `CLAUDE.md` (repo root) for the current architecture, deploy, and npm-distribution details.

## Adding a new package

(Populated as packages are built.) The pattern: create `packages/<name>/` with its own `package.json`, `tsconfig.json` extending `tsconfig.base.json`, and `src/`. pnpm workspaces will pick it up via `pnpm-workspace.yaml`. Cross-package deps use `"workspace:*"`.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`.
- ESM modules. Imports use `.js` extensions (TypeScript convention for ESM).
- ULID for IDs (`ulid` npm package).
- Snake_case for state names, event types, capability names. CamelCase for TypeScript identifiers.
- Timestamps as ISO 8601 strings in TypeScript types; `DateTime` in Prisma.
- Comments explain *why*, not *what*.

## Brand vocabulary

| Internal (code) | User-facing |
|---|---|
| `mandate` | spending policy |
| delta-mandate | approval |
| `audit_events` | the ledger |
| free / pro / team / enterprise tiers | Hedge Knight / Tourney Knight / Banner / Lord |
