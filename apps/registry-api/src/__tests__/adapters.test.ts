// Route + integration tests using fastify.inject and the in-memory store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ManifestCache } from "../cache.js";
import { publishAdapter } from "../publish.js";
import { buildServer } from "../server.js";
import { ManifestSigner } from "../signer.js";
import { InMemoryManifestStore } from "../store.js";
import { generateEd25519KeyPair, makeValidManifest } from "./_fixtures.js";

describe("registry-api routes", () => {
  let server: FastifyInstance;
  let store: InMemoryManifestStore;
  let signer: ManifestSigner;

  beforeEach(async () => {
    store = new InMemoryManifestStore();
    const { privateKey } = generateEd25519KeyPair();
    signer = ManifestSigner.fromKeyObject(privateKey, "test");
    server = await buildServer({ store, cache: new ManifestCache() });
  });

  afterEach(async () => {
    await server.close();
  });

  it("GET /adapters/:service/:version → 200 with manifest body", async () => {
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    const res = await server.inject({ method: "GET", url: "/adapters/demo/0.1.0" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/max-age=3600/);
    const body = res.json() as { manifest: { service: string }; signature: string };
    expect(body.manifest.service).toBe("demo");
    expect(body.signature.length).toBeGreaterThan(0);
  });

  it("GET unknown service → 404", async () => {
    const res = await server.inject({ method: "GET", url: "/adapters/nope/0.1.0" });
    expect(res.statusCode).toBe(404);
  });

  it("GET unknown version → 404", async () => {
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    const res = await server.inject({ method: "GET", url: "/adapters/demo/9.9.9" });
    expect(res.statusCode).toBe(404);
  });

  it("GET disabled version → 410 with disabled_reason", async () => {
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    await store.disable("demo", "0.1.0", "security-issue-found");
    const res = await server.inject({ method: "GET", url: "/adapters/demo/0.1.0" });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { disabled_reason: string };
    expect(body.disabled_reason).toBe("security-issue-found");
  });

  it("GET versions list → ordered semver descending", async () => {
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest({ version: "0.1.0" }),
      store,
      signer,
    });
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest({ version: "0.2.0" }),
      store,
      signer,
    });
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest({ version: "0.10.0" }),
      store,
      signer,
    });
    const res = await server.inject({ method: "GET", url: "/adapters/demo/versions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { versions: { version: string }[] };
    expect(body.versions.map((v) => v.version)).toEqual(["0.10.0", "0.2.0", "0.1.0"]);
  });

  it("GET /adapters?category= filters the directory", async () => {
    await publishAdapter({
      adapterName: "demo-email",
      manifest: makeValidManifest({
        service: "demo-email",
        metadata: { ...makeValidManifest().metadata, category: "email", display_name: "Email" },
      }),
      store,
      signer,
    });
    await publishAdapter({
      adapterName: "demo-pay",
      manifest: makeValidManifest({
        service: "demo-pay",
        metadata: { ...makeValidManifest().metadata, category: "payments", display_name: "Pay" },
      }),
      store,
      signer,
    });
    const res = await server.inject({ method: "GET", url: "/adapters?category=email" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { adapters: { service: string; category: string }[] };
    expect(body.adapters.map((a) => a.service)).toEqual(["demo-email"]);
  });

  it("disabled manifests are excluded from the directory", async () => {
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    await store.disable("demo", "0.1.0", "rotated");
    const res = await server.inject({ method: "GET", url: "/adapters" });
    const body = res.json() as { adapters: unknown[] };
    expect(body.adapters).toHaveLength(0);
  });

  it("/health returns 200", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("publishAdapter (CLI core)", () => {
  it("publishes a valid manifest and returns 'published'", async () => {
    const store = new InMemoryManifestStore();
    const { privateKey } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey);
    const out = await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    expect(out.kind).toBe("published");
  });

  it("returns 'validation_failed' with issues for an invalid manifest", async () => {
    const store = new InMemoryManifestStore();
    const { privateKey } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey);
    const out = await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest({ version: "garbage" }),
      store,
      signer,
    });
    expect(out.kind).toBe("validation_failed");
    if (out.kind !== "validation_failed") return;
    expect(out.issues.length).toBeGreaterThan(0);
  });

  it("returns 'already_published' on duplicate version", async () => {
    const store = new InMemoryManifestStore();
    const { privateKey } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey);
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    const out = await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    expect(out.kind).toBe("already_published");
  });
});

describe("ManifestCache hit avoids store call", () => {
  it("second fetch served from cache", async () => {
    const store = new InMemoryManifestStore();
    const { privateKey } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey);
    await publishAdapter({
      adapterName: "demo",
      manifest: makeValidManifest(),
      store,
      signer,
    });
    const cache = new ManifestCache();
    const server = await buildServer({ store, cache });

    await server.inject({ method: "GET", url: "/adapters/demo/0.1.0" });
    expect(cache.size()).toBe(1);

    // Mutate the store directly (bypassing publish) — a re-read MUST
    // still return the cached value.
    await store.disable("demo", "0.1.0", "would-be-410");
    const second = await server.inject({ method: "GET", url: "/adapters/demo/0.1.0" });
    expect(second.statusCode).toBe(200); // cache wins; freshly cached row had disabled_at=null

    await server.close();
  });
});
