// Skill registry server bootstrap. Defaults to in-memory stores for
// dev — production wires Prisma-backed stores at boot (out-of-package
// to keep this app's dep surface minimal).

import Fastify from "fastify";
import { registerSkillsRoute } from "./routes/skills.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminDashboardRoute } from "./routes/admin-dashboard.js";
import { registerExtractFailuresRoute } from "./routes/extract-failures.js";
import { registerServicesHealthRoute } from "./routes/services-health.js";
import { generateKeyPairSync } from "node:crypto";
import { ManifestSigner } from "./signer.js";
import { InMemorySkillStore } from "./skill-store-memory.js";
import type { SkillStore } from "./skill-store.js";
import {
  InMemoryExtractFailureStore,
  MAX_HTML_BYTES,
  MAX_SCREENSHOT_BYTES,
  type ExtractFailureStore,
} from "./extract-failure-store.js";
import { InMemoryBotFailureStore } from "./bot-failure-store-memory.js";
import type { BotFailureStore } from "./bot-failure-store.js";
import {
  InMemoryProvisionEventStore,
  type ProvisionEventStore,
} from "./provision-event-store.js";
import {
  InMemoryServiceStateStore,
  projectServiceState,
  type ServiceStateStore,
} from "./service-state-store.js";
import {
  InMemoryOpenIssueStore,
  type OpenIssueStore,
} from "./open-issue-store.js";
import { registerIssuesRoutes } from "./routes/issues.js";
import { adminAuthFromEnv, type AdminAuthConfig } from "./admin-auth.js";

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface BuildServerOpts {
  skillStore?: SkillStore;
  extractFailureStore?: ExtractFailureStore;
  // Closed-loop Phase 5. In-memory by default; production wires a
  // Prisma-backed store at boot.
  botFailureStore?: BotFailureStore;
  // Per-provision event store. Drives the compat-score endpoint +
  // dashboard cache-hit/demand views. In-memory default; production
  // wires a Prisma-backed store at boot.
  provisionEventStore?: ProvisionEventStore;
  // Memory-overhaul Phase 3 — materialized per-service status (projection +
  // overlay). In-memory default; production wires a Prisma store at boot.
  serviceStateStore?: ServiceStateStore;
  // Memory-overhaul Phase 4 — the drainable failure ledger. In-memory default;
  // production wires a Prisma store at boot.
  openIssueStore?: OpenIssueStore;
  // Google SSO config for the dashboard. Defaults to adminAuthFromEnv()
  // when omitted; tests inject a config (or null for bearer-only).
  adminAuth?: AdminAuthConfig | null;
  // Panel 1 funnel: trusty-squire-api base + dedicated metrics token +
  // an injectable fetch for the registry→API call (tests stub it).
  apiBase?: string;
  funnelMetricsToken?: string;
  funnelFetchFn?: typeof globalThis.fetch;
  signer?: ManifestSigner;
  // Public key (base64url SPKI DER) used to verify POST /skills
  // signatures. When undefined the route logs a warn per publish and
  // falls back to the length-only stub — acceptable for dev/staging
  // before the Phase 7 publish CLI ships, a misconfiguration in prod.
  // Resolution order: opts.skillVerifyPublicKey → SKILL_VERIFY_PUBLIC_KEY
  // env → undefined.
  skillVerifyPublicKey?: string;
  // Account ID resolver — production wires this to JWT middleware
  // (or whatever auth scheme the registry ends up adopting). Tests
  // inject a header reader.
  resolveAccountId?: (req: { headers: Record<string, unknown> }) => string;
  // T20 — Demotion webhook URL. Defaults to the env var
  // TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL when undefined; tests inject
  // an explicit URL + fetchFn.
  demotionWebhookUrl?: string;
  fetchFn?: typeof globalThis.fetch;
  // Admin bearer for /admin/* endpoints (verifier worker auth).
  // Resolution: opts.adminBearer → REGISTRY_ADMIN_BEARER env →
  // undefined. Undefined keeps the routes returning 503 (Phase 3
  // safety — easier to detect "admin not configured" than a silent
  // 401 storm).
  adminBearer?: string;
}

export async function buildServer(opts: BuildServerOpts = {}): Promise<ReturnType<typeof Fastify>> {
  // Silence the request log under vitest — it floods test output and
  // assertions are on the response, not the log line.
  const logger =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? false
      : { level: process.env.LOG_LEVEL ?? "info" };
  const fastify = Fastify({
    logger,
    bodyLimit: MAX_HTML_BYTES + MAX_SCREENSHOT_BYTES + 512 * 1024,
  });
  const skillStore = opts.skillStore ?? new InMemorySkillStore();
  const extractFailureStore =
    opts.extractFailureStore ?? new InMemoryExtractFailureStore();
  const botFailureStore =
    opts.botFailureStore ?? new InMemoryBotFailureStore();
  const provisionEventStore =
    opts.provisionEventStore ?? new InMemoryProvisionEventStore();
  const serviceStateStore =
    opts.serviceStateStore ?? new InMemoryServiceStateStore();
  const openIssueStore =
    opts.openIssueStore ?? new InMemoryOpenIssueStore();
  // Dev/test default: an ephemeral key pair. Production injects a
  // long-lived signer through opts.signer at boot. The signer is
  // used both for skill provenance (`signed_by` field on stored
  // skills) and full Ed25519 verification of incoming POST /skills
  // payloads (when SKILL_VERIFY_PUBLIC_KEY is set).
  // Resolution order:
  //   1. Explicit opts.signer (tests inject one)
  //   2. ADAPTER_SIGNING_PRIVATE_KEY env (production — base64url PKCS8)
  //   3. Ephemeral key (dev only — restart invalidates every previous
  //      signature, surfaces as `signed_by: "registry-dev"`).
  //
  // The env path is the production deploy contract. fly.toml ships a
  // placeholder; the real key gets injected via `fly secrets set` and
  // *never* lives in any committed file.
  let signer: ManifestSigner;
  if (opts.signer !== undefined) {
    signer = opts.signer;
  } else if (process.env.ADAPTER_SIGNING_PRIVATE_KEY !== undefined && process.env.ADAPTER_SIGNING_PRIVATE_KEY.length > 0) {
    signer = ManifestSigner.fromEnv(process.env, "registry");
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    signer = ManifestSigner.fromKeyObject(privateKey, "registry-dev");
  }
  const resolveAccountId =
    opts.resolveAccountId ??
    ((req: { headers: Record<string, unknown> }) => {
      // Dev / test default: an `x-account-id` header. Production
      // replaces this with whatever JWT-derived account_id auth
      // middleware produces.
      const value = req.headers["x-account-id"];
      if (typeof value === "string" && value.length > 0) return value;
      return "anonymous";
    });

  const demotionWebhookUrl =
    opts.demotionWebhookUrl ?? process.env.TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL;
  const skillVerifyPublicKey =
    opts.skillVerifyPublicKey ?? process.env.SKILL_VERIFY_PUBLIC_KEY;
  await fastify.register(registerSkillsRoute, {
    store: skillStore,
    signer,
    resolveAccountId,
    ...(demotionWebhookUrl !== undefined ? { demotionWebhookUrl } : {}),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    ...(skillVerifyPublicKey !== undefined && skillVerifyPublicKey.length > 0
      ? { skillVerifyPublicKey }
      : {}),
  });

  await fastify.register(registerExtractFailuresRoute, {
    store: extractFailureStore,
    resolveAccountId,
  });

  // T44 — compat-score endpoints. Env tunables here surface through
  // routes/services-health.ts → compat-score.ts.
  const scoreOptions = {
    halfLifeDays: numEnv("COMPAT_HALF_LIFE_DAYS", 14),
    hardBlockThreshold: numEnv("COMPAT_HARD_BLOCK_THRESHOLD", -2),
    strugglingCeiling: numEnv("COMPAT_STRUGGLING_THRESHOLD", 0),
  };
  await fastify.register(registerServicesHealthRoute, {
    eventStore: provisionEventStore,
    skillStore,
    resolveAccountId,
    scoreOptions,
    serviceStateStore,
    openIssueStore,
  });
  // Memory-overhaul Phase 3 — one-time backfill so existing services aren't
  // "unknown" until their next event (Codex rollout note). Best-effort,
  // fire-and-forget after listen; the projection self-heals on each new event
  // anyway. Skipped for the in-memory store (nothing to backfill on boot).
  fastify.addHook("onReady", async () => {
    if (opts.serviceStateStore === undefined) return; // in-mem default: nothing persisted yet
    try {
      const demand = await provisionEventStore.demandByService(
        60 * 86_400_000,
        500,
      );
      for (const { service } of demand) {
        const [attempts, activeSkill] = await Promise.all([
          provisionEventStore.listByService(service, 60 * 86_400_000),
          skillStore.findActiveByService(service),
        ]);
        await serviceStateStore.recomputeFrom(
          projectServiceState(service, attempts, activeSkill !== null, scoreOptions),
        );
      }
      fastify.log.info(
        { count: demand.length },
        "ServiceState backfill complete",
      );
    } catch (err) {
      fastify.log.warn({ err }, "ServiceState backfill failed (non-fatal)");
    }
  });

  const adminBearer = opts.adminBearer ?? process.env.REGISTRY_ADMIN_BEARER;
  const funnelMetricsToken = opts.funnelMetricsToken ?? process.env.FUNNEL_METRICS_TOKEN;
  await fastify.register(registerAdminRoutes, {
    store: skillStore,
    botFailureStore,
    // Demand signal for the merged harvest queue (Decision 4).
    provisionEventStore,
    resolveAccountId,
    ...(adminBearer !== undefined && adminBearer.length > 0
      ? { adminBearer }
      : {}),
    ...(demotionWebhookUrl !== undefined ? { demotionWebhookUrl } : {}),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
  });
  // Memory-overhaul Phase 4 — the drainable ledger's HTTP surface (admin-bearer
  // gated; the close-gate is enforced inside the store, not the route).
  await fastify.register(registerIssuesRoutes, {
    openIssueStore,
    serviceStateStore,
    ...(adminBearer !== undefined && adminBearer.length > 0 ? { adminBearer } : {}),
  });
  // Workspace-restricted Google SSO for the browser dashboard. Read from
  // env unless the caller injects a config (tests). Null = bearer-only.
  const adminAuth: AdminAuthConfig | null = opts.adminAuth ?? adminAuthFromEnv();
  await fastify.register(registerAdminDashboardRoute, {
    store: skillStore,
    botFailureStore,
    // Surface the "Recent failures" gallery.
    provisionEventStore,
    extractFailureStore,
    adminAuth,
    ...(adminBearer !== undefined && adminBearer.length > 0
      ? { adminBearer }
      : {}),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    // Panel 1 funnel: the API base + dedicated read-only metrics token.
    // When the token is unset, Panel 1 renders registry-side stages only.
    apiBase: opts.apiBase ?? process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev",
    ...(funnelMetricsToken !== undefined && funnelMetricsToken.length > 0
      ? { funnelMetricsToken }
      : {}),
    ...(opts.funnelFetchFn !== undefined ? { funnelFetchFn: opts.funnelFetchFn } : {}),
  });

  // Hourly background pruner. Best-effort — server doesn't crash if
  // it fails; the lazy delete in list()/get() catches stragglers.
  const pruneInterval = setInterval(
    () => {
      void extractFailureStore.pruneExpired().catch((err) => {
        fastify.log.warn({ err }, "extract-failure pruner failed");
      });
    },
    60 * 60 * 1000,
  );
  // setInterval keeps the process alive; unref so it doesn't block
  // graceful shutdown.
  pruneInterval.unref();

  fastify.get("/health", async () => ({ ok: true }));

  return fastify;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.REGISTRY_API_PORT ?? 3001);
  let serverOpts: BuildServerOpts = {};
  if (process.env.REGISTRY_DATABASE_URL !== undefined && process.env.REGISTRY_DATABASE_URL.length > 0) {
    const { PrismaSkillStore } = await import("./prisma-skill-store.js");
    const { PrismaExtractFailureStore } = await import("./prisma-extract-failure-store.js");
    const { PrismaBotFailureStore } = await import("./prisma-bot-failure-store.js");
    const { PrismaProvisionEventStore } = await import("./prisma-provision-event-store.js");
    serverOpts = {
      skillStore: await PrismaSkillStore.fromEnv(),
      extractFailureStore: await PrismaExtractFailureStore.fromEnv(),
      // Phase 5 — without this, every restart wipes the 14-day
      // discovery aggregation window because buildServer falls
      // back to the in-memory variant.
      botFailureStore: await PrismaBotFailureStore.fromEnv(),
      // Production-mode persistence for the compat-score endpoint +
      // dashboard cache-hit/demand views.
      provisionEventStore: await PrismaProvisionEventStore.fromEnv(),
      // Memory-overhaul Phase 3 — materialized per-service status.
      serviceStateStore: await (
        await import("./prisma-service-state-store.js")
      ).PrismaServiceStateStore.fromEnv(),
      // Memory-overhaul Phase 4 — the drainable failure ledger.
      openIssueStore: await (
        await import("./prisma-open-issue-store.js")
      ).PrismaOpenIssueStore.fromEnv(),
    };
  }
  const server = await buildServer(serverOpts);
  await server.listen({ port, host: "0.0.0.0" });
}
