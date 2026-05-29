// PR-5 — trusted-session toggle + passkey step-up.
//
// PATCH /v1/mcp/sessions/:id { trusted:true } requires a passkey
// assertion recorded in the last 24h; without one it 401s with
// step_up_required. Revoking trust needs no step-up. The GET list
// surfaces trusted + trust_granted_at, and the toggle is account-scoped.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, customerId: CUSTOMER_ID });
  const server = await buildServer({ deps });
  return { server, deps };
}

async function makeWebSession(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now: new Date(),
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function makeAgentSession(deps: ApiDeps, accountId: string): Promise<string> {
  const { record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return record.id;
}

describe("PATCH /v1/mcp/sessions/:id trust toggle", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("401 step_up_required when no recent passkey assertion exists", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const sessionId = await makeAgentSession(h.deps, account.id);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/mcp/sessions/${sessionId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { trusted: true },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe("step_up_required");
  });

  it("succeeds after a passkey assertion is recorded, and GET reflects trusted", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const sessionId = await makeAgentSession(h.deps, account.id);

    // Record a step-up via the real endpoint.
    const assert = await h.server.inject({
      method: "POST",
      url: "/v1/auth/passkey-assertion",
      headers: { cookie, "content-type": "application/json" },
      payload: { credential_id: "passkey-abc" },
    });
    expect(assert.statusCode).toBe(201);

    const patch = await h.server.inject({
      method: "PATCH",
      url: `/v1/mcp/sessions/${sessionId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { trusted: true },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as { trusted: boolean; trust_granted_at: string | null };
    expect(body.trusted).toBe(true);
    expect(body.trust_granted_at).not.toBeNull();

    const list = await h.server.inject({
      method: "GET",
      url: "/v1/mcp/sessions",
      headers: { cookie },
    });
    const session = (list.json() as { sessions: Array<Record<string, unknown>> }).sessions.find(
      (s) => s.id === sessionId,
    );
    expect(session).toMatchObject({ trusted: true });
    expect(session!.trust_granted_at).not.toBeNull();
  });

  it("a stale (>24h) assertion does not satisfy the step-up", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const sessionId = await makeAgentSession(h.deps, account.id);

    // Inject an assertion 25h old directly into the store.
    await h.deps.passkeyAssertionStore.record({
      id: ulid(),
      account_id: account.id,
      credential_id: "old",
      web_session_id: null,
      asserted_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/mcp/sessions/${sessionId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { trusted: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it("revoking trust needs no step-up", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const sessionId = await makeAgentSession(h.deps, account.id);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/mcp/sessions/${sessionId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { trusted: false },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { trusted: boolean }).trusted).toBe(false);
  });

  it("cannot toggle another account's session (404)", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieB = await makeWebSession(h.deps, b.id);
    const sessionA = await makeAgentSession(h.deps, a.id);

    // B has a recent assertion, but the session belongs to A.
    await h.server.inject({
      method: "POST",
      url: "/v1/auth/passkey-assertion",
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: {},
    });
    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/mcp/sessions/${sessionA}`,
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { trusted: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
