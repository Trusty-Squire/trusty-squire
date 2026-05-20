// Tests for G15's URL shortener — POST /v1/short + GET /v1/short/:slug.
//
// Covers the load-bearing semantics:
//   - the returned short_url uses the deployed web-app host (not the
//     API host), because that host is what runs the /g/:slug redirect
//   - the long URL with its fragment is stored and resolves verbatim
//   - https-only validation
//   - expiry sweeps the entry lazily on read
//   - 404 on unknown slug

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { __resetShortStoreForTests } from "../routes/short.js";

let app: FastifyInstance;
let nowMs = Date.UTC(2026, 4, 20, 12, 0, 0);

beforeEach(async () => {
  __resetShortStoreForTests();
  process.env.PWA_BASE_URL = "https://trustysquire.ai";
  const deps = buildInMemoryDeps({
    sessionSecret: "test-secret-not-used",
    customerId: "ts-test",
    now: () => new Date(nowMs),
  });
  app = await buildServer({ deps });
});

afterEach(async () => {
  await app.close();
  delete process.env.PWA_BASE_URL;
});

describe("POST /v1/short", () => {
  it("returns a short_url on the web-app host with a 6-char slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/short",
      headers: { "content-type": "application/json" },
      payload: {
        url: "https://shouts-clean-mediawiki-cookies.trycloudflare.com/vnc.html",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { slug: string; short_url: string; expires_at: string };
    expect(body.slug).toMatch(/^[a-zA-Z0-9]{6}$/);
    expect(body.short_url).toBe(`https://trustysquire.ai/g/${body.slug}`);
    expect(new Date(body.expires_at).getTime()).toBe(nowMs + 15 * 60 * 1000);
  });

  it("rejects non-https URLs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/short",
      headers: { "content-type": "application/json" },
      payload: { url: "http://example.com/" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects malformed URLs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/short",
      headers: { "content-type": "application/json" },
      payload: { url: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an over-long URL", async () => {
    const huge = "https://example.com/?q=" + "x".repeat(3000);
    const res = await app.inject({
      method: "POST",
      url: "/v1/short",
      headers: { "content-type": "application/json" },
      payload: { url: huge },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/short/:slug", () => {
  it("resolves a freshly-minted slug back to the long URL — with fragment intact", async () => {
    // The fragment carries the VNC password and is the load-bearing
    // bit; storing the URL string verbatim preserves it.
    const longUrl =
      "https://shouts-clean-mediawiki-cookies.trycloudflare.com/vnc.html" +
      "#password=25f4cc35";
    const mint = await app.inject({
      method: "POST",
      url: "/v1/short",
      headers: { "content-type": "application/json" },
      payload: { url: longUrl },
    });
    const { slug } = mint.json() as { slug: string };

    const res = await app.inject({ method: "GET", url: `/v1/short/${slug}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toBe(longUrl);
  });

  it("returns 404 for an unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/short/zzzzzz" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 after the slug's 15-minute TTL passes", async () => {
    const mint = await app.inject({
      method: "POST",
      url: "/v1/short",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com/" },
    });
    const { slug } = mint.json() as { slug: string };

    // Time-warp 16 minutes forward — past the 15-min TTL.
    nowMs += 16 * 60 * 1000;

    const res = await app.inject({ method: "GET", url: `/v1/short/${slug}` });
    expect(res.statusCode).toBe(404);
  });
});
