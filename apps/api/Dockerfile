# API-only Dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install all dependencies (monorepo)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json ./packages/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter @trusty-squire/api...

# Build API and its dependencies
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# Generate Prisma clients before building. We have two schemas: the
# inbox one (in packages/inbox) and the auth/operational one (in
# apps/api/prisma). The API imports both at runtime via deps.ts.
RUN pnpm -F @trusty-squire/inbox run prisma:generate
RUN pnpm -F @trusty-squire/api run prisma:generate
RUN pnpm --filter @trusty-squire/api... build

# Production image
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
COPY package.json pnpm-workspace.yaml ./

EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
