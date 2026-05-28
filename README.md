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
│   ├── adapter-sdk/        # Adapter manifest types (chunk 2)
│   ├── runtime/            # Orchestration runtime (chunks 2–3, completed in 4–7)
│   ├── mandate-validator/  # Mandate verification (chunk 4)
│   ├── vault/              # HSM-backed credential storage (chunk 6)
│   ├── inbox/              # Email reception and parsing (chunk 7)
│   └── adapters/
│       └── resend/         # Reference adapter (chunk 3)
└── apps/
    ├── registry/       # Adapter manifest registry (chunk 9)
    ├── api/                # Main backend gateway (chunk 10)
    ├── mcp/                # MCP server for coding agents (chunk 11)
    └── pwa/                # User-facing web app (chunk 12)
```

The skeleton is built incrementally, one chunk at a time. See `b5357a45-trustysquirebuildspec.md` for the chunk-by-chunk build plan.

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
