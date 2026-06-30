// Per-IP rolling-hour cap on POST /v1/install — the one unthrottled write path
// (unauthed, pre-account) surfaced by the #12 load test. Limit is read from
// INSTALL_IP_HOURLY_LIMIT at server build; set it low here and confirm the 429,
// keyed off Fly's real-client-IP header (req.ip is the proxy behind Fly).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const prev = process.env.INSTALL_IP_HOURLY_LIMIT;

describe("per-IP install rate limit", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(async () => {
    process.env.INSTALL_IP_HOURLY_LIMIT = "2"; // tiny for the test
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    server = await buildServer({ deps });
  });
  afterEach(async () => {
    await server.close();
    if (prev === undefined) delete process.env.INSTALL_IP_HOURLY_LIMIT;
    else process.env.INSTALL_IP_HOURLY_LIMIT = prev;
  });

  const install = (ip: string) =>
    server.inject({ method: "POST", url: "/v1/install", headers: { "fly-client-ip": ip } });

  it("429s a single IP past the hourly limit, keyed off fly-client-ip", async () => {
    expect((await install("9.9.9.9")).statusCode).toBe(201);
    expect((await install("9.9.9.9")).statusCode).toBe(201);
    const blocked = await install("9.9.9.9");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "rate_limited", scope: "ip", limit_per_hour: 2 });
  });

  it("does not throttle a different IP", async () => {
    await install("9.9.9.9");
    await install("9.9.9.9");
    expect((await install("9.9.9.9")).statusCode).toBe(429);
    // a distinct client IP has its own budget
    expect((await install("8.8.8.8")).statusCode).toBe(201);
  });

  it("disables the cap when INSTALL_IP_HOURLY_LIMIT <= 0", async () => {
    await server.close();
    process.env.INSTALL_IP_HOURLY_LIMIT = "0";
    server = await buildServer({ deps });
    for (let i = 0; i < 5; i++) {
      expect((await install("7.7.7.7")).statusCode).toBe(201);
    }
  });
});
