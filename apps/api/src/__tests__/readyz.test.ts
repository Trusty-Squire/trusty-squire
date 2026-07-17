// Readiness endpoint — an external uptime monitor pings /readyz to catch a
// wedged DB (the 256MB OOM failure mode). /health stays shallow for Fly's
// liveness check so a DB wedge can't trigger an API restart loop.

import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildInMemoryDeps,
  probeWithRetry,
  type DbProbeAttempt,
  type DbProbeObserver,
} from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

function captureLogs(): {
  records: Array<Record<string, unknown>>;
  stream: Writable;
} {
  const records: Array<Record<string, unknown>> = [];
  let pending = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 0) records.push(JSON.parse(line) as Record<string, unknown>);
        newline = pending.indexOf("\n");
      }
      callback();
    },
  });
  return { records, stream };
}

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
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("/readyz returns 503 when the DB ping fails (wedge detection)", async () => {
    const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    server = await buildServer({ deps: { ...deps, pingDb: async () => false } });
    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ready: false, db: "unreachable" });
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("logs a failed attempt and self-contained retry recovery", async () => {
    const { records, stream } = captureLogs();
    const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    const pingDb = async (observe?: DbProbeObserver): Promise<boolean> => {
      await observe?.({
        attempt: 1,
        outcome: "failure",
        duration_ms: 2000,
        failure_class: "timeout",
      });
      await observe?.({ attempt: 2, outcome: "success", duration_ms: 12 });
      return true;
    };
    server = await buildServer({ deps: { ...deps, pingDb }, logStream: stream });

    const res = await server.inject({ method: "GET", url: "/readyz" });
    const requestId = res.headers["x-request-id"];
    const failedAttempt = records.find(
      (record) =>
        record.event === "readiness_db_probe_attempt" && record.outcome === "failure",
    );
    const successfulAttempt = records.find(
      (record) =>
        record.event === "readiness_db_probe_attempt" && record.outcome === "success",
    );
    const recovered = records.find(
      (record) => record.event === "readiness_db_probe_recovered",
    );

    expect(res.statusCode).toBe(200);
    expect(failedAttempt).toMatchObject({
      level: 40,
      reqId: requestId,
      attempt: 1,
      failure_class: "timeout",
    });
    expect(successfulAttempt).toMatchObject({ level: 20, reqId: requestId, attempt: 2 });
    expect(recovered).toMatchObject({
      level: 30,
      reqId: requestId,
      observed_attempts: 2,
      failure_class: "timeout",
      total_duration_ms: expect.any(Number),
    });
  });

  it("logs a safe terminal failure correlated to the response", async () => {
    const { records, stream } = captureLogs();
    const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    const pingDb = async (observe?: DbProbeObserver): Promise<boolean> => {
      for (const attempt of [1, 2] as const) {
        await observe?.({
          attempt,
          outcome: "failure",
          duration_ms: 5,
          failure_class: "database_error",
          error_code: "P1001",
        });
      }
      return false;
    };
    server = await buildServer({ deps: { ...deps, pingDb }, logStream: stream });

    const res = await server.inject({ method: "GET", url: "/readyz" });
    const terminal = records.find(
      (record) => record.event === "readiness_db_probe_failed",
    );

    expect(res.statusCode).toBe(503);
    expect(terminal).toMatchObject({
      level: 50,
      reqId: res.headers["x-request-id"],
      observed_attempts: 2,
      failure_class: "database_error",
      error_code: "P1001",
      total_duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(records)).not.toContain("database details");
  });
});

// The single-retry the DB liveness probe uses: absorb a momentary blip (a 2s
// probe timeout that self-recovers) without masking a real, sustained wedge.
describe("probeWithRetry", () => {
  it("returns true without retrying when the first probe succeeds", async () => {
    let calls = 0;
    const attempts: DbProbeAttempt[] = [];
    const ready = await probeWithRetry(
      async () => {
        calls += 1;
      },
      0,
      (attempt) => {
        attempts.push(attempt);
      },
    );
    expect(ready).toBe(true);
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, outcome: "success" });
    expect(attempts[0]?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns true when a transient first failure clears on the retry", async () => {
    let calls = 0;
    const attempts: DbProbeAttempt[] = [];
    const ready = await probeWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient blip");
      },
      0,
      (attempt) => {
        attempts.push(attempt);
      },
    );
    expect(ready).toBe(true);
    expect(calls).toBe(2);
    expect(attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "failure",
        failure_class: "database_error",
      }),
      expect.objectContaining({ attempt: 2, outcome: "success" }),
    ]);
  });

  it("returns false when a sustained wedge fails both attempts", async () => {
    let calls = 0;
    const attempts: DbProbeAttempt[] = [];
    const ready = await probeWithRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error("database details must not be observed"), {
          code: "P1001",
        });
      },
      0,
      (attempt) => {
        attempts.push(attempt);
      },
    );
    expect(ready).toBe(false);
    expect(calls).toBe(2);
    expect(attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "failure",
        failure_class: "database_error",
        error_code: "P1001",
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: "failure",
        failure_class: "database_error",
        error_code: "P1001",
      }),
    ]);
    expect(JSON.stringify(attempts)).not.toContain("database details");
  });

  it("classifies timeouts without exposing the error message", async () => {
    const attempts: DbProbeAttempt[] = [];
    const timeout = Object.assign(new Error("private database hostname"), {
      name: "DbProbeTimeoutError",
    });
    const ready = await probeWithRetry(
      async () => {
        throw timeout;
      },
      0,
      (attempt) => {
        attempts.push(attempt);
      },
    );

    expect(ready).toBe(false);
    expect(attempts).toEqual([
      expect.objectContaining({ failure_class: "timeout" }),
      expect.objectContaining({ failure_class: "timeout" }),
    ]);
    expect(JSON.stringify(attempts)).not.toContain("private database hostname");
  });

  it("does not let an observer failure change readiness", async () => {
    const ready = await probeWithRetry(
      async () => undefined,
      0,
      () => {
        throw new Error("logger unavailable");
      },
    );
    expect(ready).toBe(true);
  });

  it("does not let an async observer rejection change readiness", async () => {
    const ready = await probeWithRetry(
      async () => undefined,
      0,
      async () => {
        throw new Error("async logger unavailable");
      },
    );
    expect(ready).toBe(true);
    await Promise.resolve();
  });
});
