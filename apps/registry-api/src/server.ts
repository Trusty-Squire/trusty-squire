// registry-api server bootstrap. Defaults to in-memory store for
// dev — production wires a Prisma-backed store at boot (out-of-package
// to keep this app's dep surface minimal).

import Fastify from "fastify";
import { ManifestCache } from "./cache.js";
import { registerAdaptersRoute } from "./routes/adapters.js";
import { InMemoryManifestStore, type ManifestStore } from "./store.js";

export interface BuildServerOpts {
  store?: ManifestStore;
  cache?: ManifestCache;
}

export async function buildServer(opts: BuildServerOpts = {}): Promise<ReturnType<typeof Fastify>> {
  // Silence the request log under vitest — it floods test output and
  // assertions are on the response, not the log line.
  const logger =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? false
      : { level: process.env.LOG_LEVEL ?? "info" };
  const fastify = Fastify({ logger });
  const store = opts.store ?? new InMemoryManifestStore();
  const cache = opts.cache ?? new ManifestCache();

  await fastify.register(registerAdaptersRoute, { store, cache });

  fastify.get("/health", async () => ({ ok: true }));

  return fastify;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.REGISTRY_API_PORT ?? 3001);
  const server = await buildServer();
  await server.listen({ port, host: "0.0.0.0" });
}
