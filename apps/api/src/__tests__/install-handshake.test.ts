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
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";

const JSON_HEADERS = { "content-type": "application/json" };
const SESSION_SECRET = "test-secret-not-used";

async function makeWebSession(
  deps: ApiDeps,
  accountId: string,
): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now: new Date(),
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

describe("single-tier install handshake", () => {
  let app: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(async () => {
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
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

  it("returns browser install preferences with the one-time agent token", async () => {
    const initiate = await app.inject({
      method: "POST",
      url: "/v1/mcp/install/initiate",
      headers: JSON_HEADERS,
      payload: { agent_identity: "goose" },
    });
    const { setup_code } = initiate.json() as { setup_code: string };

    await deps.pairingTokenStore.claim(
      setup_code,
      "acct-pref",
      "agent_raw",
      new Date(),
      {
        registry_enabled: true,
        consent_operator_inbox_otp: true,
        proxy_url: "socks5://proxy.test:1080",
      },
    );

    const status = await app.inject({
      method: "GET",
      url: `/v1/mcp/install/${setup_code}/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "claimed",
      agent_session_token: "agent_raw",
      account_id: "acct-pref",
      install_preferences: {
        registry_enabled: true,
        consent_operator_inbox_otp: true,
        proxy_url: "socks5://proxy.test:1080",
      },
    });
  });

  it("rejects malformed proxy preferences at the browser claim boundary", async () => {
    const initiate = await app.inject({
      method: "POST",
      url: "/v1/mcp/install/initiate",
      headers: JSON_HEADERS,
      payload: { agent_identity: "goose" },
    });
    const { setup_code } = initiate.json() as { setup_code: string };
    const cookie = await makeWebSession(deps, "acct-pref");

    const claim = await app.inject({
      method: "POST",
      url: `/v1/mcp/install/${setup_code}/claim`,
      headers: { ...JSON_HEADERS, cookie },
      payload: {
        registry_enabled: true,
        consent_operator_inbox_otp: true,
        proxy_url: "http://proxy.test:8080\nBAD=1",
      },
    });

    expect(claim.statusCode).toBe(400);
    expect(claim.json()).toMatchObject({ error: "invalid_request" });
  });

  it("provisioning is free during beta — no paywall past the old free limit", async () => {
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    const { machine_token } = issue.json() as { machine_token: string };

    // Bind the machine to an account up front (single-tier reality:
    // the install-claim does this seconds after token issuance).
    await deps.machineTokenStore.markPaired(machine_token, "acct-test");

    // Well past the old free limit (10) — every signup still succeeds; the
    // quota gate has been removed for the free-during-beta window.
    for (let i = 0; i < 13; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/inbox/aliases",
        headers: { "x-machine-token": machine_token, ...JSON_HEADERS },
        payload: { account_id: "acct-test", service: "test", run_id: `r-${i}` },
      });
      expect(r.statusCode, `iteration ${i}`).toBe(201);
    }
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
