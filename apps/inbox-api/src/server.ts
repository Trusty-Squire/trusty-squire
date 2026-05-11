// inbox-api server bootstrap. Wires Fastify + the SES route + an
// in-memory inbox stack for local dev. Production wires Prisma-backed
// stores and a real S3 fetcher (out-of-package modules so the inbox
// package's dep surface stays AWS-SDK-free).

import type { Buffer } from "node:buffer";
import Fastify from "fastify";
import {
  InMemoryAliasStore,
  InMemoryEmailStore,
  SesHandler,
  type RawEmailFetcher,
} from "@trusty-squire/inbox";
import { registerSesInboundRoute } from "./routes/ses-inbound.js";

class StubFetcher implements RawEmailFetcher {
  async fetch(bucket: string, key: string): Promise<Buffer> {
    // Local dev placeholder. Production wires an S3 client here.
    throw new Error(
      `S3 fetcher not configured (would fetch s3://${bucket}/${key}). ` +
        `Wire AWS SDK or a local file fetcher before pointing SES at this app.`,
    );
  }
}

export async function buildServer(): Promise<ReturnType<typeof Fastify>> {
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  const aliasStore = new InMemoryAliasStore();
  const emailStore = new InMemoryEmailStore();
  const handler = new SesHandler({
    aliasStore,
    emailStore,
    fetcher: new StubFetcher(),
  });

  await fastify.register(registerSesInboundRoute, { handler });

  fastify.get("/health", async () => ({ ok: true }));

  return fastify;
}

// `tsx watch` and `node dist/server.js` invoke this branch. `import`
// without execution (e.g. for tests) skips the listen().
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4001);
  const server = await buildServer();
  await server.listen({ port, host: "0.0.0.0" });
}
