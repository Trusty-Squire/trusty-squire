# Multi-stage Dockerfile for Trusty Squire API
#
# Built and deployed by `flyctl deploy` from the repo root. Mirrors the
# build steps of the local `pnpm -F @trusty-squire/api build` invocation,
# plus carries the prisma schemas + generated clients into the runner so
# the release_command (apps/api/dist/scripts/migrate.js) can run
# `prisma migrate deploy` on each deploy.
#
# Pin the package manager version so identical inputs produce identical
# images. `corepack prepare pnpm@latest` was non-deterministic and was
# the root cause of a build that ran for >5min and timed out the Fly
# remote builder.

FROM flyio/node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/
RUN pnpm install --frozen-lockfile

# Build all packages. Generate prisma clients before tsc — packages/inbox
# and apps/api each own a schema, and both clients are imported at runtime.
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY . .
RUN pnpm -F @trusty-squire/inbox run prisma:generate
RUN pnpm -F @trusty-squire/api run prisma:generate
RUN pnpm build

# Production image - API only.
#
# Carries:
#   - dist/ (compiled JS for the server + the migrate script)
#   - prisma/ (schemas + migration SQL — needed by `prisma migrate deploy`)
#   - generated prisma clients (live under node_modules/.prisma after generate)
# The release_command in fly.toml runs scripts/migrate.js before traffic
# is rolled, so this image must include everything that script needs.
FROM base AS api
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
COPY package.json pnpm-workspace.yaml ./

EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
