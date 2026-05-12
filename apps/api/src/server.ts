// API gateway server bootstrap.
//
// In-memory deps in dev/test; production layer wires Prisma-backed
// stores. We expose `buildServer(deps)` for tests so they can inject
// a customised dep bundle (notably a VouchflowVerifier with a local
// JWKS for offline testing).

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { loadVouchflowConfig } from "./config/vouchflow.js";
import { makeAuthMiddleware } from "./auth/middleware.js";
import { registerAccountsRoute } from "./routes/accounts.js";
import { registerAuthRoute } from "./routes/auth.js";
import { registerApprovalsRoute } from "./routes/approvals.js";
import { registerCredentialsRoute } from "./routes/credentials.js";
import { registerMandatesRoute } from "./routes/mandates.js";
import { registerMcpPairRoute } from "./routes/mcp-pair.js";
import { registerReadViewsRoute } from "./routes/read-views.js";
import { registerRunsRoute } from "./routes/runs.js";
import {
  buildInMemoryDeps,
  type ApiDeps,
  type BuildInMemoryDepsOpts,
} from "./services/deps.js";

export interface BuildServerOpts {
  deps?: ApiDeps;
  buildDeps?: BuildInMemoryDepsOpts;
  approvalBaseUrl?: string;
  pairBaseUrl?: string;
}

// Pick the PWA base URL that pair/approval emails point at. In dev the
// PWA runs on :3002; in prod it's the canonical app.trustysquire.ai.
// PWA_BASE_URL overrides for self-hosters or staging deployments.
function defaultPwaBaseUrl(): string {
  if (process.env.PWA_BASE_URL !== undefined) return process.env.PWA_BASE_URL;
  if (process.env.NODE_ENV === "production") return "https://app.trustysquire.ai";
  return "http://localhost:3002";
}

export async function buildServer(opts: BuildServerOpts = {}): Promise<FastifyInstance> {
  const deps =
    opts.deps ??
    buildInMemoryDeps(
      opts.buildDeps ?? {
        sessionSecret: process.env.SESSION_JWT_SECRET ?? "dev-secret-do-not-use",
        customerId: loadVouchflowConfig().customerId,
      },
    );

  const logger =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? false
      : { level: process.env.LOG_LEVEL ?? "info" };
  const fastify = Fastify({ logger });

  await fastify.register(fastifyCookie);

  const auth = makeAuthMiddleware({
    sessionStore: deps.sessionStore,
    agentSessionStore: deps.agentSessionStore,
    sessionSecret: deps.sessionSecret,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  // Auth resolution runs before every request so handlers can read
  // req.auth optimistically. Guards (preHandler) reject when needed.
  fastify.addHook("preHandler", async (req) => {
    await auth.resolveAuth(req);
  });

  await fastify.register(registerAccountsRoute, { deps });
  await fastify.register(registerAuthRoute, { deps, requireWeb: auth.requireWeb });
  await fastify.register(registerMandatesRoute, { deps, requireWeb: auth.requireWeb });
  await fastify.register(registerRunsRoute, {
    deps,
    requireAny: auth.requireAny,
    ...(opts.approvalBaseUrl !== undefined ? { approvalBaseUrl: opts.approvalBaseUrl } : {}),
  });
  await fastify.register(registerApprovalsRoute, { deps, requireWeb: auth.requireWeb });
  await fastify.register(registerCredentialsRoute, { deps, requireAgent: auth.requireAgent });
  const pairBaseUrl = opts.pairBaseUrl ?? `${defaultPwaBaseUrl()}/pair`;
  await fastify.register(registerMcpPairRoute, {
    deps,
    requireWeb: auth.requireWeb,
    pairBaseUrl,
  });
  await fastify.register(registerReadViewsRoute, {
    deps,
    requireAny: auth.requireAny,
    requireWeb: auth.requireWeb,
  });

  fastify.get("/health", async () => ({ ok: true }));

  return fastify;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? 3000);
  const server = await buildServer();
  await server.listen({ port, host: "0.0.0.0" });
}

export type { ApiDeps };
