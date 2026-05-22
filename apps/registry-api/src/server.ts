// registry-api server bootstrap. Defaults to in-memory stores for
// dev — production wires Prisma-backed stores at boot (out-of-package
// to keep this app's dep surface minimal).

import Fastify from "fastify";
import { ManifestCache } from "./cache.js";
import { registerAdaptersRoute } from "./routes/adapters.js";
import { registerSkillsRoute } from "./routes/skills.js";
import { registerExtractFailuresRoute } from "./routes/extract-failures.js";
import { generateKeyPairSync } from "node:crypto";
import { ManifestSigner } from "./signer.js";
import { InMemoryManifestStore, type ManifestStore } from "./store.js";
import { InMemorySkillStore } from "./skill-store-memory.js";
import type { SkillStore } from "./skill-store.js";
import {
  InMemoryExtractFailureStore,
  MAX_HTML_BYTES,
  MAX_SCREENSHOT_BYTES,
  type ExtractFailureStore,
} from "./extract-failure-store.js";

export interface BuildServerOpts {
  store?: ManifestStore;
  skillStore?: SkillStore;
  extractFailureStore?: ExtractFailureStore;
  cache?: ManifestCache;
  signer?: ManifestSigner;
  // Account ID resolver — production wires this to JWT middleware
  // (or whatever auth scheme registry-api ends up adopting). Tests
  // inject a header reader.
  resolveAccountId?: (req: { headers: Record<string, unknown> }) => string;
  // T20 — Demotion webhook URL. Defaults to the env var
  // TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL when undefined; tests inject
  // an explicit URL + fetchFn.
  demotionWebhookUrl?: string;
  fetchFn?: typeof globalThis.fetch;
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
  const store = opts.store ?? new InMemoryManifestStore();
  const skillStore = opts.skillStore ?? new InMemorySkillStore();
  const extractFailureStore =
    opts.extractFailureStore ?? new InMemoryExtractFailureStore();
  const cache = opts.cache ?? new ManifestCache();
  // Dev/test default: an ephemeral key pair. Production injects a
  // long-lived signer through opts.signer at boot. The signer is
  // used both for skill provenance (`signed_by` field on stored
  // skills) and — once Phase 6 lands — for full Ed25519 verification
  // of incoming POST /skills payloads.
  // Resolution order:
  //   1. Explicit opts.signer (tests inject one)
  //   2. ADAPTER_SIGNING_PRIVATE_KEY env (production — base64url PKCS8)
  //   3. Ephemeral key (dev only — restart invalidates every previous
  //      signature, surfaces as `signed_by: "registry-api-dev"`).
  //
  // The env path is the production deploy contract. fly.toml ships a
  // placeholder; the real key gets injected via `fly secrets set` and
  // *never* lives in any committed file.
  let signer: ManifestSigner;
  if (opts.signer !== undefined) {
    signer = opts.signer;
  } else if (process.env.ADAPTER_SIGNING_PRIVATE_KEY !== undefined && process.env.ADAPTER_SIGNING_PRIVATE_KEY.length > 0) {
    signer = ManifestSigner.fromEnv(process.env, "registry-api");
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    signer = ManifestSigner.fromKeyObject(privateKey, "registry-api-dev");
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

  await fastify.register(registerAdaptersRoute, { store, cache });
  const demotionWebhookUrl =
    opts.demotionWebhookUrl ?? process.env.TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL;
  await fastify.register(registerSkillsRoute, {
    store: skillStore,
    signer,
    resolveAccountId,
    ...(demotionWebhookUrl !== undefined ? { demotionWebhookUrl } : {}),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
  });

  await fastify.register(registerExtractFailuresRoute, {
    store: extractFailureStore,
    resolveAccountId,
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
    const { PrismaManifestStore } = await import("./prisma-store.js");
    const { PrismaSkillStore } = await import("./prisma-skill-store.js");
    const { PrismaExtractFailureStore } = await import("./prisma-extract-failure-store.js");
    serverOpts = {
      store: await PrismaManifestStore.fromEnv(),
      skillStore: await PrismaSkillStore.fromEnv(),
      extractFailureStore: await PrismaExtractFailureStore.fromEnv(),
    };
  }
  const server = await buildServer(serverOpts);
  await server.listen({ port, host: "0.0.0.0" });
}
