// Panel 1 — GET /v1/admin/funnel (T-F1). Auth, window handling, the
// response contract, and npm fail-soft. Uses a stub FunnelStatsStore +
// injected fetch so no DB / network is touched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminFunnelRoute } from "../routes/admin-funnel.js";
import { bucketByDay, type FunnelStatsStore } from "../services/funnel-stats.js";
import { fetchNpmDownloads, __resetNpmCache } from "../services/npm-downloads.js";

const TOKEN = "funnel-metrics-test-token-123456";

const stubStore: FunnelStatsStore = {
  apiCounts: async () => ({
    tokens_issued: 12,
    residential_installs: 4,
    accounts_created: 8,
    new_accounts_series: [{ date: "2026-05-30", count: 3 }],
  }),
};

function npmFetch(total: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ downloads: [{ downloads: total }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}
const npmFail: typeof fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

async function build(fetchFn: typeof fetch): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerAdminFunnelRoute, {
    deps: {
      funnelStatsStore: stubStore,
      fetchFn,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    },
  });
  return app;
}

const ORIG = process.env.FUNNEL_METRICS_TOKEN;
beforeEach(() => {
  process.env.FUNNEL_METRICS_TOKEN = TOKEN;
  __resetNpmCache();
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.FUNNEL_METRICS_TOKEN;
  else process.env.FUNNEL_METRICS_TOKEN = ORIG;
});

describe("GET /v1/admin/funnel — auth", () => {
  it("503 when the metrics token is unconfigured (fail-closed)", async () => {
    delete process.env.FUNNEL_METRICS_TOKEN;
    const app = await build(npmFetch(50));
    const res = await app.inject({ method: "GET", url: "/v1/admin/funnel" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("401 on a missing/wrong bearer", async () => {
    const app = await build(npmFetch(50));
    expect((await app.inject({ method: "GET", url: "/v1/admin/funnel" })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET",
      url: "/v1/admin/funnel",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /v1/admin/funnel — response contract", () => {
  it("200 returns the funnel shape with counts + npm total", async () => {
    const app = await build(npmFetch(42));
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/funnel",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The cross-package contract the registry client will parse:
    expect(Object.keys(body).sort()).toEqual(
      ["accounts_created", "as_of", "new_accounts_series", "npm_downloads", "residential_installs", "tokens_issued", "window_end", "window_start"].sort(),
    );
    expect(body.tokens_issued).toBe(12);
    expect(body.residential_installs).toBe(4);
    expect(body.accounts_created).toBe(8);
    expect(body.new_accounts_series).toEqual([{ date: "2026-05-30", count: 3 }]);
    expect(body.npm_downloads).toBe(42);
    // Default window = 30d ending at `now`.
    expect(body.window_end).toBe("2026-06-01T00:00:00.000Z");
    expect(body.window_start).toBe("2026-05-02T00:00:00.000Z");
    await app.close();
  });

  it("honors explicit window bounds + 400s on inverted window", async () => {
    const app = await build(npmFetch(1));
    const ok = await app.inject({
      method: "GET",
      url: "/v1/admin/funnel?window_start=2026-05-01T00:00:00Z&window_end=2026-05-08T00:00:00Z",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.json().window_start).toBe("2026-05-01T00:00:00.000Z");
    const bad = await app.inject({
      method: "GET",
      url: "/v1/admin/funnel?window_start=2026-05-08T00:00:00Z&window_end=2026-05-01T00:00:00Z",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("npm fail-soft: npm_downloads is null when the fetch fails (rest still renders)", async () => {
    const app = await build(npmFail);
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/funnel",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().npm_downloads).toBeNull();
    expect(res.json().tokens_issued).toBe(12);
    await app.close();
  });
});

describe("bucketByDay", () => {
  it("groups timestamps into ascending per-UTC-day counts", () => {
    expect(
      bucketByDay([
        new Date("2026-05-30T10:00:00Z"),
        new Date("2026-05-30T23:59:00Z"),
        new Date("2026-05-31T01:00:00Z"),
      ]),
    ).toEqual([
      { date: "2026-05-30", count: 2 },
      { date: "2026-05-31", count: 1 },
    ]);
  });
  it("empty input → empty series", () => {
    expect(bucketByDay([])).toEqual([]);
  });
});

describe("fetchNpmDownloads", () => {
  const win = { package: "@trusty-squire/mcp", start: new Date("2026-05-01"), end: new Date("2026-05-31") };

  it("sums the range and caches within TTL", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ downloads: [{ downloads: 5 }, { downloads: 7 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    expect(await fetchNpmDownloads({ ...win, fetchFn: f })).toBe(12);
    expect(await fetchNpmDownloads({ ...win, fetchFn: f })).toBe(12); // cached
    expect(calls).toBe(1);
  });

  it("stale-if-error: serves the last good value for the same window on failure", async () => {
    const good = (async () =>
      new Response(JSON.stringify({ downloads: [{ downloads: 9 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    // prime cache, then force expiry via the clock and fail the fetch.
    let t = 0;
    expect(await fetchNpmDownloads({ ...win, fetchFn: good, now: () => t })).toBe(9);
    t = 10 * 60 * 60 * 1000; // past 1h TTL
    expect(await fetchNpmDownloads({ ...win, fetchFn: npmFail, now: () => t })).toBe(9);
  });

  it("returns null on failure with no cached value", async () => {
    __resetNpmCache();
    expect(await fetchNpmDownloads({ ...win, fetchFn: npmFail })).toBeNull();
  });
});
