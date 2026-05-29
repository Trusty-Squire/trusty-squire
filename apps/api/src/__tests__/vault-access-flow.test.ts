// PR-6 — end-to-end agent-mediated access through the HTTP routes.
//
//  - value flow: agent request → web approve → agent poll returns value
//  - trusted proxy: auto-approve → agent proxy hits a faked executor
//  - untrusted proxy: pending → web approve → agent proxy succeeds
//  - cross-account isolation on decide + poll
//  - deny path

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { HttpProxyExecutor } from "../services/http-proxy.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}

// A proxy executor that records the request it saw + echoes a response.
// Records whether the injected secret reached it (server-side only).
const echoes: Array<{ secret: string; url: string; auth: string | undefined }> = [];
function fakeExecutor(): HttpProxyExecutor {
  return new HttpProxyExecutor({
    lookup: async () => ({ address: "203.0.113.9", family: 4 }),
    dispatch: async (input) => {
      // input.headers already has the secret substituted in.
      echoes.push({
        secret: "(server-side)",
        url: input.url.toString(),
        auth: input.headers.authorization,
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ echoed_auth: input.headers.authorization }),
        truncated: false,
      };
    },
  });
}

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, customerId: CUSTOMER_ID });
  const server = await buildServer({ deps, proxyExecutor: fakeExecutor() });
  return { server, deps };
}

async function makeWebSession(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function makeAgent(deps: ApiDeps, accountId: string): Promise<{ token: string; id: string }> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return { token: raw_token, id: record.id };
}

// Store a credential via the manual web route; return its reference.
async function storeCred(h: Harness, cookie: string, service: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service, value: "sk-the-real-secret", type: "api_key" },
  });
  return (res.json() as { reference: string }).reference;
}

describe("agent-mediated access flow", () => {
  let h: Harness;
  beforeEach(async () => {
    echoes.length = 0;
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("value flow: request → approve → poll returns the secret once", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const agent = await makeAgent(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI");

    // Agent requests the raw value.
    const reqRes = await h.server.inject({
      method: "POST",
      url: "/v1/vault/access-requests",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: {
        reference,
        purpose: "write .env",
        intent: "value",
        reason_proxy_not_possible: "writing a local .env file",
      },
    });
    expect(reqRes.statusCode).toBe(202);
    const { request_id, status, auto_approved } = reqRes.json() as {
      request_id: string;
      status: string;
      auto_approved: boolean;
    };
    expect(status).toBe("pending");
    expect(auto_approved).toBe(false);

    // Poll before approval → still pending, no value.
    const poll1 = await h.server.inject({
      method: "GET",
      url: `/v1/vault/access-requests/${request_id}`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect((poll1.json() as { status: string; value?: string }).value).toBeUndefined();

    // It shows in the web pending list + count.
    const pendingList = await h.server.inject({
      method: "GET",
      url: "/v1/vault/access-requests?status=pending",
      headers: { cookie },
    });
    expect((pendingList.json() as { requests: unknown[] }).requests).toHaveLength(1);
    const countRes = await h.server.inject({
      method: "GET",
      url: "/v1/vault/access-requests/pending-count",
      headers: { cookie },
    });
    expect((countRes.json() as { count: number }).count).toBe(1);

    // Web approves.
    const decide = await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/decision`,
      headers: { cookie, "content-type": "application/json" },
      payload: { decision: "approve" },
    });
    expect(decide.statusCode).toBe(200);
    expect((decide.json() as { status: string }).status).toBe("approved");

    // Poll now returns the secret.
    const poll2 = await h.server.inject({
      method: "GET",
      url: `/v1/vault/access-requests/${request_id}`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(poll2.json()).toMatchObject({ status: "approved", value: "sk-the-real-secret" });

    // Second poll: the once grant is consumed.
    const poll3 = await h.server.inject({
      method: "GET",
      url: `/v1/vault/access-requests/${request_id}`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect((poll3.json() as { status: string; value?: string }).status).toBe("consumed");
    expect((poll3.json() as { value?: string }).value).toBeUndefined();
  });

  it("trusted proxy auto-approves on an allowlisted host and proxies", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const agent = await makeAgent(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI"); // → api.openai.com

    // Mark the session trusted (record a passkey, then PATCH).
    await h.server.inject({
      method: "POST",
      url: "/v1/auth/passkey-assertion",
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    await h.server.inject({
      method: "PATCH",
      url: `/v1/mcp/sessions/${agent.id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { trusted: true },
    });

    const reqRes = await h.server.inject({
      method: "POST",
      url: "/v1/vault/access-requests",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: { reference, purpose: "call /v1/models", intent: "proxy", proxy_target_host: "api.openai.com" },
    });
    const { request_id, auto_approved } = reqRes.json() as { request_id: string; auto_approved: boolean };
    expect(auto_approved).toBe(true);

    const proxyRes = await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/proxy`,
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: {
        http: {
          method: "GET",
          url: "https://api.openai.com/v1/models",
          headers: { authorization: "Bearer ${SECRET}" },
        },
      },
    });
    expect(proxyRes.statusCode).toBe(200);
    const body = proxyRes.json() as { response: { status: number; body: string } };
    expect(body.response.status).toBe(200);
    // The executor saw the substituted secret server-side; the agent's
    // response echoes the header the upstream would have received.
    expect(echoes[0]!.auth).toBe("Bearer sk-the-real-secret");
    // The secret value never appears anywhere the agent's request mentioned it raw.
    expect(JSON.stringify(body)).toContain("sk-the-real-secret"); // (echoed by the fake upstream only)
  });

  it("untrusted proxy is pending until approved, then proxies", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const agent = await makeAgent(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI");

    const reqRes = await h.server.inject({
      method: "POST",
      url: "/v1/vault/access-requests",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: { reference, purpose: "call api", intent: "proxy", proxy_target_host: "api.openai.com" },
    });
    const { request_id, auto_approved } = reqRes.json() as { request_id: string; auto_approved: boolean };
    expect(auto_approved).toBe(false);

    // Proxy before approval → 409.
    const early = await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/proxy`,
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: { http: { method: "GET", url: "https://api.openai.com/v1/models", headers: {} } },
    });
    expect(early.statusCode).toBe(409);

    await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/decision`,
      headers: { cookie, "content-type": "application/json" },
      payload: { decision: "approve", mode_override: "session" },
    });

    const proxyRes = await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/proxy`,
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: { http: { method: "GET", url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer ${SECRET}" } } },
    });
    expect(proxyRes.statusCode).toBe(200);
  });

  it("deny path: poll reports denied", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const agent = await makeAgent(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI");

    const reqRes = await h.server.inject({
      method: "POST",
      url: "/v1/vault/access-requests",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      payload: { reference, purpose: "x", intent: "value", reason_proxy_not_possible: "y" },
    });
    const { request_id } = reqRes.json() as { request_id: string };

    await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/decision`,
      headers: { cookie, "content-type": "application/json" },
      payload: { decision: "deny" },
    });
    const poll = await h.server.inject({
      method: "GET",
      url: `/v1/vault/access-requests/${request_id}`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect((poll.json() as { status: string }).status).toBe("denied");
  });

  it("cross-account: B cannot decide or poll A's request", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const agentA = await makeAgent(h.deps, a.id);
    const agentB = await makeAgent(h.deps, b.id);
    const reference = await storeCred(h, cookieA, "OpenAI");

    const reqRes = await h.server.inject({
      method: "POST",
      url: "/v1/vault/access-requests",
      headers: { authorization: `Bearer ${agentA.token}`, "content-type": "application/json" },
      payload: { reference, purpose: "x", intent: "value", reason_proxy_not_possible: "y" },
    });
    const { request_id } = reqRes.json() as { request_id: string };

    const decideB = await h.server.inject({
      method: "POST",
      url: `/v1/vault/access-requests/${request_id}/decision`,
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { decision: "approve" },
    });
    expect(decideB.statusCode).toBe(404);

    const pollB = await h.server.inject({
      method: "GET",
      url: `/v1/vault/access-requests/${request_id}`,
      headers: { authorization: `Bearer ${agentB.token}` },
    });
    expect(pollB.statusCode).toBe(404);
  });
});
