// Readiness endpoint — an external uptime monitor pings /readyz to catch a
// wedged DB (the 256MB OOM failure mode). /health stays shallow for Fly's
// liveness check so a DB wedge can't trigger an API restart loop.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildInMemoryDeps, probeWithRetry } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

describe("health vs readiness", () => {
  let server: FastifyInstance;
  afterEach(async () => {
    await server.close();
  });

  it("/health is shallow + DB-independent (Fly liveness)", async () => {
    server = await buildServer({ deps: buildInMemoryDeps({ sessionSecret: SESSION_SECRET }) });
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("/readyz returns 200 ready:true when the DB answers", async () => {
    server = await buildServer({ deps: buildInMemoryDeps({ sessionSecret: SESSION_SECRET }) });
    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: true });
  });

  it("/readyz returns 503 when the DB ping fails (wedge detection)", async () => {
    const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    server = await buildServer({ deps: { ...deps, pingDb: async () => false } });
    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ready: false, db: "unreachable" });
  });
});

// The single-retry the DB liveness probe uses: absorb a momentary blip (a 2s
// probe timeout that self-recovers) without masking a real, sustained wedge.
describe("probeWithRetry", () => {
  it("returns true without retrying when the first probe succeeds", async () => {
    let calls = 0;
    const ready = await probeWithRetry(async () => {
      calls += 1;
    }, 0);
    expect(ready).toBe(true);
    expect(calls).toBe(1);
  });

  it("returns true when a transient first failure clears on the retry", async () => {
    let calls = 0;
    const ready = await probeWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient blip");
    }, 0);
    expect(ready).toBe(true);
    expect(calls).toBe(2);
  });

  it("returns false when a sustained wedge fails both attempts", async () => {
    let calls = 0;
    const ready = await probeWithRetry(async () => {
      calls += 1;
      throw new Error("wedged");
    }, 0);
    expect(ready).toBe(false);
    expect(calls).toBe(2);
  });
});
