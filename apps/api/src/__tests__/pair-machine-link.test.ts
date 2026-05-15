// Verifies the Tier 0 → Tier 1 upgrade plumbing:
//
//   1. /v1/install issues a machine token, counts usage
//   2. /v1/mcp/pair/initiate accepts a machine_token and stores it on
//      the pairing record
//   3. /v1/mcp/pair/<>/claim (when it runs) calls markPaired
//   4. Paired tokens skip quota enforcement
//
// We don't simulate the PWA web-auth path here — that's covered by the
// existing pair tests. Instead we exercise the pairing store + machine
// token store wiring directly so a regression is caught even if the
// route's auth boilerplate changes.

import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { loadVouchflowConfig } from "../config/vouchflow.js";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../services/deps.js";

const JSON_HEADERS = { "content-type": "application/json" };

describe("Tier 0 → Tier 1 upgrade", () => {
  let app: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(async () => {
    deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
      customerId: loadVouchflowConfig().customerId,
    });
    app = await buildServer({ deps });
  });

  it("stores the machine_token on the pairing record", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    const initiate = await app.inject({
      method: "POST",
      url: "/v1/mcp/pair/initiate",
      headers: JSON_HEADERS,
      payload: { agent_identity: "claude-code", machine_token },
    });
    expect(initiate.statusCode).toBe(201);
    const { pair_token } = initiate.json() as { pair_token: string };

    const record = await deps.pairingTokenStore.find(pair_token);
    expect(record).not.toBeNull();
    expect(record?.machine_token).toBe(machine_token);
  });

  it("markPaired flips paired_account_id and unblocks quota", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    // Burn through the quota.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/inbox/aliases",
        headers: { "x-machine-token": machine_token, ...JSON_HEADERS },
        payload: { service: "test", run_id: `r-${i}` },
      });
      expect(r.statusCode, `iteration ${i}`).toBe(201);
    }

    // 11th request hits the quota.
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/inbox/aliases",
      headers: { "x-machine-token": machine_token, ...JSON_HEADERS },
      payload: { service: "test", run_id: "r-blocked" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "quota_exceeded" });

    // Pair it (the side-effect /claim would have when it runs).
    await deps.machineTokenStore.markPaired(machine_token, "acct-paired");

    // Now further requests sail through, even though signup_count is
    // already past the limit.
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/inbox/aliases",
      headers: { "x-machine-token": machine_token, ...JSON_HEADERS },
      payload: { service: "test", run_id: "r-after-pair" },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("install/status reflects pairing state", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    const beforePair = await app.inject({
      method: "GET",
      url: "/v1/install/status",
      headers: { "x-machine-token": machine_token },
    });
    expect(beforePair.json()).toMatchObject({
      tier: "anonymous",
      paired_account_id: null,
      over_quota: false,
    });

    await deps.machineTokenStore.markPaired(machine_token, "acct-paired");

    const afterPair = await app.inject({
      method: "GET",
      url: "/v1/install/status",
      headers: { "x-machine-token": machine_token },
    });
    expect(afterPair.json()).toMatchObject({
      tier: "paired",
      paired_account_id: "acct-paired",
      over_quota: false,
    });
  });
});
