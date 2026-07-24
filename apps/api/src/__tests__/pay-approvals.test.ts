import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "synthetic-payment-approval-test-secret";

async function makeWebSession(deps: ApiDeps, accountId: string, now: Date): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now,
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function makeAgentToken(deps: ApiDeps, accountId: string, now: Date): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "synthetic-payment-test-agent",
    agent_version: "test",
    now,
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

describe("payment approval relay", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let nowMs: number;
  let agentToken: string;
  let webCookie: string;
  let otherAgentToken: string;
  let otherWebCookie: string;

  beforeEach(async () => {
    nowMs = Date.parse("2026-07-23T12:00:00.000Z");
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date(nowMs),
    });
    server = await buildServer({ deps });
    const account = await deps.accountStore.createAccount("payer@example.test", "Payer");
    const other = await deps.accountStore.createAccount("other@example.test", "Other");
    agentToken = await makeAgentToken(deps, account.id, new Date(nowMs));
    webCookie = await makeWebSession(deps, account.id, new Date(nowMs));
    otherAgentToken = await makeAgentToken(deps, other.id, new Date(nowMs));
    otherWebCookie = await makeWebSession(deps, other.id, new Date(nowMs));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await server.close();
  });

  async function createApproval(): Promise<{ id: string; nonce: string; expires_at: string }> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; nonce: string; expires_at: string };
  }

  it("creates a pending approval and returns it", async () => {
    const created = await createApproval();
    expect(created.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.expires_at).toBe("2026-07-23T12:10:00.000Z");

    const response = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: created.id,
      status: "pending",
      merchant: "Synthetic Books",
      checkout_origin: "https://checkout.synthetic.test",
      amount_cents: 2599,
      currency: "USD",
      nonce: created.nonce,
      card_ref: "card_synthetic_1",
      operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      item: "",
      reason: "",
      agent: "",
      jws: null,
      sealed_card: null,
      expires_at: created.expires_at,
    });
  });

  it("stores and returns item/reason/agent when provided", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Synthetic Widget",
        reason: "Restocking synthetic inventory",
        agent: "synthetic-shopping-agent",
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string };

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      item: "Synthetic Widget",
      reason: "Restocking synthetic inventory",
      agent: "synthetic-shopping-agent",
    });
  });

  it("returns the configured Vouchflow audience to an authenticated operator", async () => {
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", "customer_test");
    const response = await server.inject({
      method: "GET",
      url: "/v1/pay/config",
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vouchflow_audience: "customer_test" });
  });

  it("omits the Vouchflow audience when the server is not configured", async () => {
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", "");
    const response = await server.inject({
      method: "GET",
      url: "/v1/pay/config",
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it("approves once and stores the opaque payloads verbatim", async () => {
    const created = await createApproval();
    const jws = "synthetic.header.signature";
    const sealedCard = "c2VhbGVkLXN5bnRoZXRpYy1jYXJk";
    const approved = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws, sealed_card: sealedCard },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ status: "approved" });

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ status: "approved", jws, sealed_card: sealedCard });

    const second = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws, sealed_card: sealedCard },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "payment_approval_already_approved" });
  });

  it("reads a past pending approval as expired", async () => {
    const created = await createApproval();
    nowMs += 10 * 60 * 1000 + 1;
    const response = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, status: "expired" });

    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: "expired.synthetic.jws", sealed_card: "ZXhwaXJlZC1zZWFsZWQtY2FyZA" },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toEqual({ error: "payment_approval_expired" });
  });

  it("pushes to Telegram on create when the account has a linked chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");

    const created = await createApproval();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botsynthetic-bot-token/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("555000111");
    expect(body.text).toContain("USD 25.99");
    expect(body.text).toContain(`/vault/pay/${created.id}`);
  });

  it("does not push to Telegram when the account has no linked chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");

    await createApproval();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies cross-account reads and approvals", async () => {
    const created = await createApproval();
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
    });
    expect(get.statusCode).toBe(404);

    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: otherWebCookie },
      payload: { jws: "other.synthetic.jws", sealed_card: "b3RoZXItc2VhbGVkLWNhcmQ" },
    });
    expect(approve.statusCode).toBe(404);
  });
});
