// API gateway server bootstrap.
//
// In-memory deps in dev/test; production layer wires Prisma-backed
// stores. We expose `buildServer(deps)` for tests so they can inject
// a customised dep bundle.

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { startMetricsServer } from "./metrics-server.js";
import { makeAuthMiddleware } from "./auth/middleware.js";
import { registerInstallRoute } from "./routes/install.js";
import { registerCaptchaEventsRoute } from "./routes/captcha-events.js";
import { registerAdminFunnelRoute } from "./routes/admin-funnel.js";
import { registerBillingRoute } from "./routes/billing.js";
import { registerStripeWebhookRoute } from "./routes/stripe-webhook.js";
import { stripeClientFromEnv } from "./services/stripe-client.js";
import { registerAuthRoute } from "./routes/auth.js";
import { registerOAuthRoute } from "./routes/oauth.js";
import { registerVaultRoute } from "./routes/vault.js";
import { registerVaultE2ERoute } from "./routes/vault-e2e.js";
import { registerPayApprovalsRoute } from "./routes/pay-approvals.js";
import { registerTelegramRoute } from "./routes/telegram.js";
import { registerVaultAccessRoute } from "./routes/vault-access.js";
import { registerEgressRoutes } from "./routes/egress.js";
import type { EgressGrantStore } from "./services/egress-grant.js";
import type { EmailForwarder } from "./services/email-forwarder.js";
import type { HttpProxyExecutor } from "./services/http-proxy.js";
import type { StripeClient } from "./services/stripe-client.js";
import { registerMcpInstallRoute } from "./routes/mcp-install.js";
import { registerMcpSessionsRoute } from "./routes/mcp-sessions.js";
import { registerShortRoute } from "./routes/short.js";
import { registerNotifyRoute } from "./routes/notify.js";
import { registerOperatorOtpRoute } from "./routes/operator-otp.js";
import { registerWorkspaceInboxRoute } from "./routes/workspace-inbox.js";
import { buildInMemoryDeps, type ApiDeps, type BuildInMemoryDepsOpts } from "./services/deps.js";

export interface BuildServerOpts {
  deps?: ApiDeps;
  buildDeps?: BuildInMemoryDepsOpts;
  approvalBaseUrl?: string;
  installBaseUrl?: string;
  // Test seam — injects a proxy executor with the SSRF guard relaxed /
  // network dispatch faked, so use_credential tests don't fight the
  // loopback block. Production leaves this undefined → real executor.
  proxyExecutor?: HttpProxyExecutor;
  egressGrantStore?: EgressGrantStore;
  // Test seam — injects a stub EmailForwarder into the notify
  // route. Production builds leave this undefined and the route
  // builds its own forwarder from GMAIL_USER / GMAIL_APP_PASSWORD.
  emailForwarder?: EmailForwarder;
  // Test seam — injects a fake StripeClient into the billing + webhook
  // routes (no live Stripe calls, no real signature). Production leaves
  // this undefined → built from STRIPE_SECRET_KEY env (null when unset).
  stripeClient?: StripeClient;
  // Test seam for asserting structured logs. Supplying a stream enables the
  // same redacted Pino logger production uses, at debug level.
  logStream?: Writable;
}

// Base URL of the web app that install/approval links point at. The
// app surface lives on the trustysquire.ai apex (login, /install, the
// vault). PWA_BASE_URL overrides for local dev or staging.
function defaultPwaBaseUrl(): string {
  if (process.env.PWA_BASE_URL !== undefined) return process.env.PWA_BASE_URL;
  if (process.env.NODE_ENV === "production") return "https://trustysquire.ai";
  return "http://localhost:3002";
}

// The HS256 secret behind every session + web JWT. In production it MUST be
// set — fall back to the dev placeholder only outside production, otherwise a
// missing env var would silently make all session tokens forgeable. Fail
// closed instead.
function resolveSessionSecret(): string {
  const secret = process.env.SESSION_JWT_SECRET;
  if (secret !== undefined && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_JWT_SECRET must be set in production (refusing to use a dev fallback)",
    );
  }
  return "dev-secret-do-not-use";
}

// Defense-in-depth for a CREDENTIAL BROKER: the guarantee must be "the logger
// CANNOT emit a secret," not "current code happens to be careful." pino `redact`
// censors these object paths on every log line, so a future careless
// `req.log.info({ headers })` / `{ token }` / `{ body }` can't leak a value. The
// injecting proxy (http-proxy.ts) already never logs; this is the backstop.
// Exported + tested so a critical path can't be silently dropped.
export const SECRET_REDACT_PATHS: readonly string[] = [
  // Auth-bearing request/response headers (Fastify's default req serializer
  // omits headers, but cover the case where someone logs them explicitly).
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  // Credential-shaped fields anywhere in a logged object.
  "token",
  "secret",
  "password",
  "value",
  "fields",
  "machine_token",
  "agent_session_token",
  "api_key",
  "apiKey",
  "*.token",
  "*.secret",
  "*.password",
  "*.value",
  "*.fields",
  "*.machine_token",
  "*.agent_session_token",
  "*.api_key",
  "*.apiKey",
  // Request/response bodies can carry secrets (use_credential payloads,
  // browser-fill responses) — never log them.
  "body",
  "req.body",
  "res.body",
];

export async function buildServer(opts: BuildServerOpts = {}): Promise<FastifyInstance> {
  const deps =
    opts.deps ??
    buildInMemoryDeps(
      opts.buildDeps ?? {
        sessionSecret: resolveSessionSecret(),
      },
    );

  // Global kill switches (checklist #10) — read at server-build time, exactly
  // like BILLING_ENABLED. A flip is `flyctl secrets set SIGNUPS_DISABLED=1`,
  // which restarts the machine (~30s); there is no runtime reload by design
  // (one fewer moving part, and consistent with every other env knob). All
  // three DEFAULT TO ENABLED / not-killed — only "1" or "true" engages a kill.
  const killSwitchEngaged = (name: string): boolean =>
    process.env[name] === "1" || process.env[name] === "true";
  const signupsDisabled = killSwitchEngaged("SIGNUPS_DISABLED");
  const egressDisabled = killSwitchEngaged("EGRESS_DISABLED");
  // Non-empty → the product is in maintenance and the string is the operator's
  // message for a web banner to read off GET /v1/status.
  const maintenanceMessage = process.env.MAINTENANCE_MESSAGE ?? "";
  // Free-during-beta: billing is OFF unless explicitly enabled. Surfaced on
  // GET /v1/status so the web app can hide the Upgrade/Billing UI entirely
  // rather than letting a user click through to a checkout that 503s.
  const billingEnabled =
    process.env.BILLING_ENABLED === "true" || process.env.BILLING_ENABLED === "1";

  const logger =
    opts.logStream === undefined &&
    (process.env.VITEST === "true" || process.env.NODE_ENV === "test")
      ? false
      : {
          level: opts.logStream === undefined ? (process.env.LOG_LEVEL ?? "info") : "debug",
          redact: { paths: [...SECRET_REDACT_PATHS], censor: "[redacted]" },
          ...(opts.logStream !== undefined ? { stream: opts.logStream } : {}),
        };
  const fastify = Fastify({ logger });

  await fastify.register(fastifyCookie);

  // Replace the default JSON parser with one that also stashes the raw
  // body string on req.rawBody. Webhook signature verification (Svix /
  // Resend) must HMAC the exact bytes received — a re-serialised object
  // would not byte-match the sender's signed payload.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body: string | Buffer, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
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

  // Panel 1 funnel — operator-only, dedicated FUNNEL_METRICS_TOKEN.
  await fastify.register(registerAdminFunnelRoute, {
    deps: {
      funnelStatsStore: deps.funnelStatsStore,
      excludeAccountIds: (process.env.FUNNEL_EXCLUDE_ACCOUNT_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });

  await fastify.register(registerAuthRoute, { deps, requireWeb: auth.requireWeb });
  // SIGNUPS_DISABLED gates fresh account creation in the OAuth callback —
  // existing identities/accounts still sign in (see oauth.ts).
  await fastify.register(registerOAuthRoute, { deps, signupsDisabled });
  await fastify.register(registerInstallRoute, {
    deps: {
      machineTokenStore: deps.machineTokenStore,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
    // SIGNUPS_DISABLED — machine-token issuance is the first step of a fresh
    // install, so the kill switch 503s it.
    signupsDisabled,
  });
  await fastify.register(registerCaptchaEventsRoute, {
    deps: {
      captchaEventStore: deps.captchaEventStore,
      machineTokenStore: deps.machineTokenStore,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });
  await fastify.register(registerNotifyRoute, {
    deps: {
      machineTokenStore: deps.machineTokenStore,
      accountStore: deps.accountStore,
      ...(opts.emailForwarder !== undefined ? { emailForwarder: opts.emailForwarder } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });
  await fastify.register(registerOperatorOtpRoute, {
    deps: { machineTokenStore: deps.machineTokenStore },
  });
  await fastify.register(registerWorkspaceInboxRoute, {
    deps: { machineTokenStore: deps.machineTokenStore },
  });
  // Billing — Stripe Checkout/Portal (web-authed) + the webhook that flips
  // subscription_status. stripeClient is null when STRIPE_SECRET_KEY is
  // unset; the routes register regardless and 503.
  const stripeClient = opts.stripeClient ?? stripeClientFromEnv();
  await fastify.register(registerBillingRoute, {
    deps: {
      accountStore: deps.accountStore,
      stripe: stripeClient,
      // Free-during-beta: checkout stays OFF unless explicitly enabled, so a
      // stray Upgrade click can't charge anyone even with a live Stripe key.
      billingEnabled,
      webBaseUrl: defaultPwaBaseUrl(),
    },
    requireWeb: auth.requireWeb,
  });
  await fastify.register(registerStripeWebhookRoute, {
    deps: { accountStore: deps.accountStore, stripe: stripeClient },
  });
  await fastify.register(registerVaultRoute, {
    deps,
    requireWeb: auth.requireWeb,
    requireAgent: auth.requireAgent,
    requireAny: auth.requireAny,
    ...(opts.emailForwarder !== undefined ? { emailForwarder: opts.emailForwarder } : {}),
  });
  await fastify.register(registerVaultE2ERoute, {
    deps,
    requireWeb: auth.requireWeb,
    requireAgent: auth.requireAgent,
    requireAny: auth.requireAny,
  });
  await fastify.register(registerPayApprovalsRoute, {
    deps,
    requireWeb: auth.requireWeb,
    requireAgent: auth.requireAgent,
    requireAny: auth.requireAny,
  });
  await fastify.register(registerTelegramRoute, {
    deps,
    requireWeb: auth.requireWeb,
    requireAny: auth.requireAny,
  });
  await fastify.register(registerVaultAccessRoute, {
    deps,
    requireAgent: auth.requireAgent,
    ...(opts.proxyExecutor !== undefined ? { proxyExecutor: opts.proxyExecutor } : {}),
  });
  // Egress Grants v1a (buffered): a deployed machine calls a provider through the
  // injecting proxy with a revocable grant token. Persistence follows the deps
  // layer — Prisma-backed when the auth DB is wired, in-memory otherwise; an
  // explicit opts.egressGrantStore still wins for test injection.
  await fastify.register(registerEgressRoutes, {
    deps,
    egressGrantStore: opts.egressGrantStore ?? deps.egressGrantStore,
    requireAgent: auth.requireAgent,
    // EGRESS_DISABLED 503s both the mint route AND the transparent proxy —
    // killing existing grants too is the point of the switch (see egress.ts).
    egressDisabled,
    ...(opts.proxyExecutor !== undefined ? { proxyExecutor: opts.proxyExecutor } : {}),
  });
  const installBaseUrl = opts.installBaseUrl ?? `${defaultPwaBaseUrl()}/install`;
  await fastify.register(registerMcpInstallRoute, {
    deps,
    requireWeb: auth.requireWeb,
    installBaseUrl,
  });
  await fastify.register(registerMcpSessionsRoute, {
    deps,
    requireWeb: auth.requireWeb,
  });
  // G15: tiny noVNC-tunnel URL shortener. webBaseUrl is the host
  // that will serve the /g/:slug redirect — the web app, not the API.
  await fastify.register(registerShortRoute, {
    deps: {
      webBaseUrl: defaultPwaBaseUrl(),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
  });

  // Liveness — shallow + DB-independent. Fly's http_service check hits this; it
  // must NOT depend on the DB, or a DB wedge would trigger an API restart loop
  // that can't fix the DB.
  fastify.get("/health", async () => ({ ok: true }));

  // Public status surface (no auth) — the single place to read what the global
  // kill switches (checklist #10) have flipped, and the data a web maintenance
  // banner reads. Mirrors the build-time flags; restart the machine to change.
  fastify.get("/v1/status", async () => ({
    ok: true,
    signups_enabled: !signupsDisabled,
    egress_enabled: !egressDisabled,
    billing_enabled: billingEnabled,
    maintenance: maintenanceMessage.length > 0,
    message: maintenanceMessage,
  }));

  // Readiness — verifies the DB actually answers. Point an external uptime
  // monitor here to get paged when the DB wedges (the 256MB OOM failure mode):
  // 200 {ready:true} when healthy, 503 {ready:false} when the DB is unreachable.
  fastify.get("/readyz", async (req, reply) => {
    const startedAt = performance.now();
    // Echo Fastify's correlation ID so an uptime-monitor event can be joined
    // directly to the structured probe-attempt logs for this request.
    reply.header("x-request-id", req.id);
    let observedAttempts = 0;
    let lastFailure: { failure_class: string; error_code?: string } | undefined;

    const ready = await deps.pingDb((attempt) => {
      observedAttempts += 1;
      const context = { event: "readiness_db_probe_attempt", ...attempt };
      if (attempt.outcome === "failure") {
        lastFailure = {
          failure_class: attempt.failure_class,
          ...(attempt.error_code !== undefined ? { error_code: attempt.error_code } : {}),
        };
        req.log.warn(context, "readiness database probe attempt failed");
        return;
      }
      req.log.debug(context, "readiness database probe attempt succeeded");
    });

    const totalDurationMs = Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
    if (!ready) {
      req.log.error(
        {
          event: "readiness_db_probe_failed",
          observed_attempts: observedAttempts,
          total_duration_ms: totalDurationMs,
          ...(lastFailure ?? {}),
        },
        "readiness database probe failed after retry",
      );
      reply.code(503);
      return { ready: false, db: "unreachable" };
    }
    if (observedAttempts > 1) {
      req.log.info(
        {
          event: "readiness_db_probe_recovered",
          observed_attempts: observedAttempts,
          total_duration_ms: totalDurationMs,
          ...(lastFailure ?? {}),
        },
        "readiness database probe recovered on retry",
      );
    }
    return { ready: true };
  });

  return fastify;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? 3000);
  // Build deps explicitly so we can grab a handle to the retention
  // cron alongside the server. Matches the default buildServer() path
  // when opts.deps isn't passed.
  const deps = buildInMemoryDeps({
    sessionSecret: resolveSessionSecret(),
  });
  const server = await buildServer({ deps });

  // Retention cron only fires when a DB is wired (it's null otherwise).
  // .start() is idempotent and uses unref'd timers so it doesn't block
  // process exit.
  deps.retentionCron?.start();

  await server.listen({ port, host: "0.0.0.0" });

  // Private Prometheus exporter — only when a DB is wired (collectMetrics is
  // undefined on the no-DB path). Binds a port that fly.toml does NOT declare
  // in [http_service], so Fly's managed Prometheus scrapes it over the 6PN
  // private network while it stays off the public internet.
  if (deps.collectMetrics !== undefined) {
    const require = createRequire(import.meta.url);
    // Resolve relative to the built dist/server.js → apps/api/package.json.
    const pkg = require("../package.json") as { version?: string };
    const version = pkg.version ?? process.env.npm_package_version ?? "dev";
    startMetricsServer({
      port: Number(process.env.METRICS_PORT ?? 9091),
      collect: deps.collectMetrics,
      version,
    });
  }
}

export type { ApiDeps };
