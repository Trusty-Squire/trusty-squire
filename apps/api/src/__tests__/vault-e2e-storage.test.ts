import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "synthetic-e2e-storage-test-secret";

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

async function makeAgentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "synthetic-test-agent",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

describe("E2E credential and payment audit routes", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let accountId: string;
  let otherAccountId: string;
  let webCookie: string;
  let otherWebCookie: string;
  let agentToken: string;
  let nowMs: number;

  beforeEach(async () => {
    nowMs = Date.parse("2026-07-23T12:00:00.000Z");
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date(nowMs),
    });
    server = await buildServer({ deps });
    accountId = (await deps.accountStore.createAccount("one@example.test", "One")).id;
    otherAccountId = (await deps.accountStore.createAccount("two@example.test", "Two")).id;
    webCookie = await makeWebSession(deps, accountId);
    otherWebCookie = await makeWebSession(deps, otherAccountId);
    agentToken = await makeAgentToken(deps, accountId);
  });

  afterEach(async () => {
    await server.close();
  });

  it("stores an opaque blob, omits it from lists, scopes reads, and deletes", async () => {
    const blob = '{ "ciphertext": "synthetic-only", "spacing": true }';
    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: { label: "Synthetic card", blob },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };

    const list = await server.inject({
      method: "GET",
      url: "/v1/vault/e2e",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ id, label: "Synthetic card" }),
    ]);
    expect(list.json()[0]).not.toHaveProperty("blob");

    const get = await server.inject({
      method: "GET",
      url: `/v1/vault/e2e/${id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id, label: "Synthetic card", blob });

    const crossAccount = await server.inject({
      method: "GET",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: otherWebCookie },
    });
    expect(crossAccount.statusCode).toBe(404);

    const crossDelete = await server.inject({
      method: "DELETE",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: otherWebCookie },
    });
    expect(crossDelete.statusCode).toBe(404);

    const remove = await server.inject({
      method: "DELETE",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(remove.statusCode).toBe(204);

    const missing = await server.inject({
      method: "GET",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a full PAN in last4", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/payments/audit",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        amountCents: 1200,
        currency: "USD",
        last4: "4242424242424242",
        status: "approved",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects payment amounts outside the database integer range", async () => {
    for (const amountCents of [-1, 2_147_483_648]) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/vault/payments/audit",
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          merchant: "Synthetic Books",
          amountCents,
          currency: "USD",
          last4: "4242",
          status: "approved",
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("records last4-only payment audits and paginates newest first", async () => {
    const first = await server.inject({
      method: "POST",
      url: "/v1/vault/payments/audit",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        amountCents: 1200,
        currency: "USD",
        last4: "1111",
        status: "approved",
        mandateId: "mandate_synthetic",
        pan: "4111111111111111",
        cvv: "123",
      },
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;

    const second = await server.inject({
      method: "POST",
      url: "/v1/vault/payments/audit",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Cafe",
        amountCents: 450,
        currency: "USD",
        last4: "4242",
        status: "declined",
      },
    });
    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { id: string }).id;

    const third = await server.inject({
      method: "POST",
      url: "/v1/vault/payments/audit",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Market",
        amountCents: 975,
        currency: "USD",
        last4: "1234",
        status: "approved",
      },
    });
    expect(third.statusCode).toBe(201);
    const thirdId = (third.json() as { id: string }).id;
    const expectedIds = [firstId, secondId, thirdId].sort().reverse();

    const list = await server.inject({
      method: "GET",
      url: "/v1/vault/payments/audit?limit=2",
      headers: { cookie: webCookie },
    });
    expect(list.statusCode).toBe(200);
    const firstPage = list.json() as {
      events: Array<Record<string, unknown>>;
      next_before: string | null;
    };
    const events = firstPage.events;
    expect(events.map((event) => event.id)).toEqual(expectedIds.slice(0, 2));
    expect(firstPage.next_before).not.toBeNull();

    const next = await server.inject({
      method: "GET",
      url: `/v1/vault/payments/audit?limit=2&before=${encodeURIComponent(firstPage.next_before!)}`,
      headers: { cookie: webCookie },
    });
    const secondPage = next.json() as {
      events: Array<Record<string, unknown>>;
      next_before: string | null;
    };
    expect(secondPage.events).toHaveLength(1);
    expect([...events, ...secondPage.events].map((event) => event.id)).toEqual(expectedIds);
    expect([...events, ...secondPage.events].find((event) => event.id === firstId)).toMatchObject({
      merchant: "Synthetic Books",
      amountCents: 1200,
      currency: "USD",
      last4: "1111",
      status: "approved",
      mandateId: "mandate_synthetic",
    });
    expect(secondPage.next_before).toBeNull();
    expect(JSON.stringify([...events, ...secondPage.events])).not.toContain("4111111111111111");
    expect(events[0]).not.toHaveProperty("pan");
    expect(events[0]).not.toHaveProperty("cvv");

    const otherList = await server.inject({
      method: "GET",
      url: "/v1/vault/payments/audit",
      headers: { cookie: otherWebCookie },
    });
    expect(otherList.json()).toEqual({ events: [], next_before: null });
  });
});
