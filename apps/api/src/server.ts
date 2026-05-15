// API gateway server bootstrap.
//
// In-memory deps in dev/test; production layer wires Prisma-backed
// stores. We expose `buildServer(deps)` for tests so they can inject
// a customised dep bundle (notably a VouchflowVerifier with a local
// JWKS for offline testing).

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { loadVouchflowConfig, isStubMode } from "./config/vouchflow.js";
import { makeStubVouchflowVerifier } from "./config/stub-verifier.js";
import { makeAuthMiddleware } from "./auth/middleware.js";
import { registerAccountsRoute } from "./routes/accounts.js";
import { registerInstallRoute } from "./routes/install.js";
import { registerCaptchaEventsRoute } from "./routes/captcha-events.js";
import { registerInboxRoute } from "./routes/inbox.js";
import { registerLLMRoute } from "./routes/llm.js";
import { registerSesWebhookRoute } from "./routes/ses-webhook.js";
import { registerMailgunWebhookRoute } from "./routes/mailgun-webhook.js";
import { registerFlyEmailWebhookRoute } from "./routes/fly-email-webhook.js";
import { registerPostfixWebhookRoute } from "./routes/postfix-webhook.js";
import { registerResendWebhookRoute } from "./routes/resend-webhook.js";
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
  // If stub mode is enabled, create a test verifier that accepts any bundle
  const stubVerifier = isStubMode()
    ? makeStubVouchflowVerifier(loadVouchflowConfig().customerId)
    : undefined;

  const deps =
    opts.deps ??
    buildInMemoryDeps(
      opts.buildDeps ?? {
        sessionSecret: process.env.SESSION_JWT_SECRET ?? "dev-secret-do-not-use",
        customerId: loadVouchflowConfig().customerId,
        ...(stubVerifier ? { vouchflowVerifier: stubVerifier as any } : {}),
      },
    );

  const logger =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? false
      : { level: process.env.LOG_LEVEL ?? "info" };
  const fastify = Fastify({ logger });

  await fastify.register(fastifyCookie);

  // Add raw body parser for email webhooks
  fastify.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  // Add text/plain parser for SNS notifications
  fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body: string | Buffer, done) => {
    try {
      const text = typeof body === 'string' ? body : body.toString();
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Replace the default JSON parser with one that also stashes the raw
  // body string on req.rawBody. Webhook signature verification (Svix /
  // Resend) must HMAC the exact bytes received — a re-serialised object
  // would not byte-match the sender's signed payload.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      req.rawBody = text;
      if (text.trim().length === 0) {
        // Mirror Fastify's default: empty JSON body parses to undefined.
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
  await fastify.register(registerSesWebhookRoute, { deps });
  await fastify.register(registerMailgunWebhookRoute, { deps });
  await fastify.register(registerFlyEmailWebhookRoute, { deps });
  await fastify.register(registerPostfixWebhookRoute, { deps });
  await fastify.register(registerResendWebhookRoute, { deps });
  await fastify.register(registerInstallRoute, {
    deps: {
      machineTokenStore: deps.machineTokenStore,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });
  await fastify.register(registerCaptchaEventsRoute, {
    deps: {
      captchaEventStore: deps.captchaEventStore,
      machineTokenStore: deps.machineTokenStore,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });
  await fastify.register(registerInboxRoute, {
    deps: {
      inbox: deps.inbox,
      machineTokenStore: deps.machineTokenStore,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });
  await fastify.register(registerLLMRoute, {
    deps: {
      machineTokenStore: deps.machineTokenStore,
      llmUsageTracker: deps.llmUsageTracker,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });
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
  // Build deps explicitly so we can grab a handle to the retention
  // cron alongside the server. Matches the default buildServer() path
  // when opts.deps isn't passed.
  const deps = buildInMemoryDeps({
    sessionSecret: process.env.SESSION_JWT_SECRET ?? "dev-secret-do-not-use",
    customerId: loadVouchflowConfig().customerId,
  });
  const server = await buildServer({ deps });

  // Retention cron only fires when a DB is wired (it's null otherwise).
  // .start() is idempotent and uses unref'd timers so it doesn't block
  // process exit.
  deps.retentionCron?.start();

  await server.listen({ port, host: "0.0.0.0" });
}

export type { ApiDeps };
