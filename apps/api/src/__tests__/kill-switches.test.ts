// Global kill switches (checklist #10) — SIGNUPS_DISABLED / EGRESS_DISABLED /
// MAINTENANCE_MESSAGE. Each is read at server-build time (like BILLING_ENABLED)
// and engages a 503 at the choke point it gates. GET /v1/status mirrors the
// flipped state for a web banner. OAuth's new-vs-returning account split lives
// in its own file (oauth-signups-disabled.test.ts) where the providers mock.

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { HttpProxyExecutor } from "../services/http-proxy.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

// Kill-switch env vars are read at buildServer() time. Each test sets/clears
// them around its own setup() and restores in afterEach so no leakage.
const KILL_VARS = ["SIGNUPS_DISABLED", "EGRESS_DISABLED", "MAINTENANCE_MESSAGE"] as const;
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

function fakeExecutor(): HttpProxyExecutor {
  return new HttpProxyExecutor({
    lookup: async () => ({ address: "203.0.113.9", family: 4 }),
    dispatch: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
      truncated: false,
    }),
  });
}

let server: FastifyInstance;
async function buildWith(): Promise<{ server: FastifyInstance; deps: ApiDeps }> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
  server = await buildServer({ deps, proxyExecutor: fakeExecutor() });
  return { server, deps };
}
async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}
async function agentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({ account_id: accountId, agent_identity: "claude-code", agent_version: "test", now: new Date() });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

afterEach(async () => {
  await server?.close();
  restoreEnv();
});

describe("SIGNUPS_DISABLED — POST /v1/install", () => {
  it("503 signups_disabled when engaged", async () => {
    setEnv("SIGNUPS_DISABLED", "1");
    await buildWith();
    const res = await server.inject({ method: "POST", url: "/v1/install", payload: {} });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("signups_disabled");
  });

  it("mints a machine token normally when not engaged", async () => {
    for (const v of KILL_VARS) setEnv(v, undefined);
    await buildWith();
    const res = await server.inject({ method: "POST", url: "/v1/install", payload: {} });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { machine_token: string }).machine_token).toBeTruthy();
  });
});

describe("EGRESS_DISABLED — /v1/egress", () => {
  async function storeCred(deps: ApiDeps, cookie: string): Promise<void> {
    const res = await server.inject({
      method: "POST", url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service: "OpenAI", value: "sk-the-real-secret", type: "api_key" },
    });
    expect(res.statusCode).toBe(201);
  }

  it("mint → 503 egress_disabled when engaged", async () => {
    setEnv("EGRESS_DISABLED", "1");
    const { deps } = await buildWith();
    const account = await deps.accountStore.createAccount("e@example.test", "E");
    const cookie = await webCookie(deps, account.id);
    const token = await agentToken(deps, account.id);
    await storeCred(deps, cookie);
    const res = await server.inject({
      method: "POST", url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI" },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("egress_disabled");
  });

  it("the proxy 503s EXISTING grants too when engaged (the point of the switch)", async () => {
    // Mint a live grant first (switch OFF), then flip it ON and rebuild — the
    // grant survives in the store but the proxy refuses to serve it.
    for (const v of KILL_VARS) setEnv(v, undefined);
    const { deps } = await buildWith();
    const account = await deps.accountStore.createAccount("e2@example.test", "E2");
    const cookie = await webCookie(deps, account.id);
    const token = await agentToken(deps, account.id);
    await storeCred(deps, cookie);
    const mint = await server.inject({
      method: "POST", url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI" },
    });
    const { grant_id, token: egressToken } = mint.json() as { grant_id: string; token: string };
    await server.close();

    setEnv("EGRESS_DISABLED", "1");
    server = await buildServer({ deps, proxyExecutor: fakeExecutor() });
    const res = await server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("egress_disabled");
  });

  it("mint + proxy work normally when not engaged", async () => {
    for (const v of KILL_VARS) setEnv(v, undefined);
    const { deps } = await buildWith();
    const account = await deps.accountStore.createAccount("e3@example.test", "E3");
    const cookie = await webCookie(deps, account.id);
    const token = await agentToken(deps, account.id);
    await storeCred(deps, cookie);
    const mint = await server.inject({
      method: "POST", url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI" },
    });
    expect(mint.statusCode).toBe(201);
    const { grant_id, token: egressToken } = mint.json() as { grant_id: string; token: string };
    const res = await server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /v1/status — kill-switch + maintenance surface", () => {
  it("all enabled, no maintenance, when nothing is flipped", async () => {
    for (const v of KILL_VARS) setEnv(v, undefined);
    setEnv("BILLING_ENABLED", undefined);
    await buildWith();
    const res = await server.inject({ method: "GET", url: "/v1/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      signups_enabled: true,
      egress_enabled: true,
      billing_enabled: false,
      maintenance: false,
      message: "",
    });
  });

  it("reflects each flipped kill switch and the maintenance message", async () => {
    setEnv("SIGNUPS_DISABLED", "1");
    setEnv("EGRESS_DISABLED", "true");
    setEnv("MAINTENANCE_MESSAGE", "Back at 5pm UTC");
    setEnv("BILLING_ENABLED", undefined);
    await buildWith();
    const res = await server.inject({ method: "GET", url: "/v1/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      signups_enabled: false,
      egress_enabled: false,
      billing_enabled: false,
      maintenance: true,
      message: "Back at 5pm UTC",
    });
  });

  it("surfaces billing_enabled:true when BILLING_ENABLED is set (web shows the Upgrade UI)", async () => {
    for (const v of KILL_VARS) setEnv(v, undefined);
    setEnv("BILLING_ENABLED", "1");
    await buildWith();
    const res = await server.inject({ method: "GET", url: "/v1/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ billing_enabled: true });
  });

  it("needs no auth (public banner data)", async () => {
    for (const v of KILL_VARS) setEnv(v, undefined);
    await buildWith();
    const res = await server.inject({ method: "GET", url: "/v1/status" });
    expect(res.statusCode).toBe(200);
  });
});
