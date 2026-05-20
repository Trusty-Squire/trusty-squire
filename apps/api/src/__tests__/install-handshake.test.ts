// Verifies the single-tier install handshake plumbing:
//
//   1. /v1/install issues a machine token, counts usage
//   2. /v1/mcp/install/initiate accepts a machine_token and stores it
//      on the setup-token record
//   3. /v1/mcp/install/<>/claim (when it runs) calls markPaired
//   4. Quota applies uniformly — paying is the only way past it
//
// We don't simulate the PWA web-auth path here — that's covered by
// the existing install/claim tests. Instead we exercise the setup-
// token store + machine-token store wiring directly so a regression
// is caught even if the route's auth boilerplate changes.

import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { loadVouchflowConfig } from "../config/vouchflow.js";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../services/deps.js";

const JSON_HEADERS = { "content-type": "application/json" };

describe("single-tier install handshake", () => {
  let app: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(async () => {
    deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
      customerId: loadVouchflowConfig().customerId,
    });
    app = await buildServer({ deps });
  });

  it("stores the machine_token on the setup-token record", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    const initiate = await app.inject({
      method: "POST",
      url: "/v1/mcp/install/initiate",
      headers: JSON_HEADERS,
      payload: { agent_identity: "claude-code", machine_token },
    });
    expect(initiate.statusCode).toBe(201);
    const { setup_code } = initiate.json() as { setup_code: string };

    const record = await deps.pairingTokenStore.find(setup_code);
    expect(record).not.toBeNull();
    expect(record?.machine_token).toBe(machine_token);
  });

  it("emits payment_required + cta_billing_url at the free-quota limit", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    // Bind the machine to an account up front (single-tier reality:
    // the install-claim does this seconds after token issuance).
    await deps.machineTokenStore.markPaired(machine_token, "acct-test");

    // Burn through the free quota.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/inbox/aliases",
        headers: { "x-machine-token": machine_token, ...JSON_HEADERS },
        payload: { account_id: "acct-test", service: "test", run_id: `r-${i}` },
      });
      expect(r.statusCode, `iteration ${i}`).toBe(201);
    }

    // 11th request — the free limit hits and the response points the
    // user at billing instead of a separate pairing flow.
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/inbox/aliases",
      headers: { "x-machine-token": machine_token, ...JSON_HEADERS },
      payload: { account_id: "acct-test", service: "test", run_id: "r-blocked" },
    });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toMatchObject({ error: "payment_required" });
    expect((blocked.json() as Record<string, unknown>).cta_billing_url).toBeDefined();
  });

  it("install/status returns the bound account_id", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    const beforeBind = await app.inject({
      method: "GET",
      url: "/v1/install/status",
      headers: { "x-machine-token": machine_token },
    });
    expect(beforeBind.json()).toMatchObject({
      account_id: null,
      over_quota: false,
    });

    await deps.machineTokenStore.markPaired(machine_token, "acct-bound");

    const afterBind = await app.inject({
      method: "GET",
      url: "/v1/install/status",
      headers: { "x-machine-token": machine_token },
    });
    expect(afterBind.json()).toMatchObject({
      account_id: "acct-bound",
      over_quota: false,
    });
  });
});
