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
  InMemoryProvisionAttemptStore,
  type ProvisionAttemptStore,
} from "./provision-attempt-store.js";

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
  // T44 — per-attempt outcome store. Drives the compat-score endpoint.
  // In-memory default; production wires a Prisma-backed store at boot.
  provisionAttemptStore?: ProvisionAttemptStore;
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
  const provisionAttemptStore =
    opts.provisionAttemptStore ?? new InMemoryProvisionAttemptStore();
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
  await fastify.register(registerServicesHealthRoute, {
    attemptStore: provisionAttemptStore,
    skillStore,
    resolveAccountId,
    scoreOptions: {
      halfLifeDays: numEnv("COMPAT_HALF_LIFE_DAYS", 14),
      hardBlockThreshold: numEnv("COMPAT_HARD_BLOCK_THRESHOLD", -2),
      strugglingCeiling: numEnv("COMPAT_STRUGGLING_THRESHOLD", 0),
    },
  });

  const adminBearer = opts.adminBearer ?? process.env.REGISTRY_ADMIN_BEARER;
  await fastify.register(registerAdminRoutes, {
    store: skillStore,
    botFailureStore,
    resolveAccountId,
    ...(adminBearer !== undefined && adminBearer.length > 0
      ? { adminBearer }
      : {}),
    ...(demotionWebhookUrl !== undefined ? { demotionWebhookUrl } : {}),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
  });
  await fastify.register(registerAdminDashboardRoute, {
    store: skillStore,
    botFailureStore,
    // T45 — surface the "Recent failures" gallery.
    provisionAttemptStore,
    extractFailureStore,
    ...(adminBearer !== undefined && adminBearer.length > 0
      ? { adminBearer }
      : {}),
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
    const { PrismaProvisionAttemptStore } = await import("./prisma-provision-attempt-store.js");
    serverOpts = {
      skillStore: await PrismaSkillStore.fromEnv(),
      extractFailureStore: await PrismaExtractFailureStore.fromEnv(),
      // Phase 5 — without this, every restart wipes the 14-day
      // discovery aggregation window because buildServer falls
      // back to the in-memory variant.
      botFailureStore: await PrismaBotFailureStore.fromEnv(),
      // T44 — production-mode persistence for the compat-score endpoint.
      provisionAttemptStore: await PrismaProvisionAttemptStore.fromEnv(),
    };
  }
  const server = await buildServer(serverOpts);
  await server.listen({ port, host: "0.0.0.0" });
}
