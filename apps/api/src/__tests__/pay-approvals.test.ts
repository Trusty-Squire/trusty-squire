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

async function makeAgentToken(
  deps: ApiDeps,
  accountId: string,
  now: Date,
  agentIdentity: string | null = "synthetic-payment-test-agent",
): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: agentIdentity,
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

  async function createApproval(): Promise<{
    id: string;
    nonce: string;
    agent: string;
    expires_at: string;
  }> {
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
    return response.json() as {
      id: string;
      nonce: string;
      agent: string;
      expires_at: string;
    };
  }

  async function createCardlessApproval(): Promise<{ id: string }> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  // Creates an E2ECredential (card) owned by the account behind `cookie`,
  // returning its id — the value the JIT ceremony binds as card_ref.
  async function createOwnedCard(cookie: string, last4 = "4242"): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie },
      payload: {
        label: "Synthetic Visa",
        blob: '{ "ciphertext": "synthetic-sealed-card" }',
        brand: "visa",
        last4,
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it("creates a pending approval and returns it", async () => {
    const created = await createApproval();
    expect(created.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.agent).toBe("synthetic-payment-test-agent");
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
      agent: "synthetic-payment-test-agent",
      jws: null,
      sealed_card: null,
      expires_at: created.expires_at,
    });
  });

  it("stores item/reason and ignores a body-supplied agent", async () => {
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
    const created = response.json() as { id: string; agent: string };
    expect(created.agent).toBe("synthetic-payment-test-agent");

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      item: "Synthetic Widget",
      reason: "Restocking synthetic inventory",
      agent: "synthetic-payment-test-agent",
    });
  });

  it("defaults an absent authenticated agent identity to unknown-agent", async () => {
    const account = await deps.accountStore.createAccount("unknown-agent@example.test", "Unknown");
    const token = await makeAgentToken(deps, account.id, new Date(nowMs), null);
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${token}` },
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
    const created = response.json() as { id: string; agent: string };
    expect(created.agent).toBe("unknown-agent");

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ agent: "unknown-agent" });
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

  it("notifies Telegram when 3-D Secure is required", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");
    const created = await createApproval();
    fetchMock.mockClear();

    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("Synthetic Books");
    expect(body.text).toContain("USD 25.99");
  });

  it("does not notify Telegram about 3-D Secure without a linked chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const created = await createApproval();

    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns not found when notifying for another account's approval", async () => {
    const created = await createApproval();
    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  // ── JIT add-card ceremony: card-less create → bind → approve ──────────

  it("gives a card-less JIT create an 18-min TTL and a has-card create 10 min", async () => {
    // nowMs is pinned to 2026-07-23T12:00:00.000Z in beforeEach.
    const cardless = await createCardlessApproval();
    expect(cardless).toMatchObject({});
    const cardlessGet = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${cardless.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    // 12:00:00 + 18 min.
    expect((cardlessGet.json() as { expires_at: string }).expires_at).toBe(
      "2026-07-23T12:18:00.000Z",
    );

    const hasCard = await createApproval();
    // createApproval sends card_ref → keeps the 10-min tap window.
    expect(hasCard.expires_at).toBe("2026-07-23T12:10:00.000Z");
  });

  it("creates a card-less approval (JIT add-card handle) with a null card_ref", async () => {
    const created = await createCardlessApproval();
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.statusCode).toBe(200);
    // Card-less, but the operator pubkey is minted at create regardless.
    expect(get.json()).toMatchObject({
      card_ref: null,
      operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      status: "pending",
    });
  });

  it("binds an owned card to a card-less approval, then approve succeeds", async () => {
    const created = await createCardlessApproval();
    const cardId = await createOwnedCard(webCookie);

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: cardId },
    });
    expect(bind.statusCode).toBe(200);
    expect(bind.json()).toEqual({ card_ref: cardId });

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ card_ref: cardId });

    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: "synthetic.header.sig", sealed_card: "c2VhbGVkLXN5bnRoZXRpYy1jYXJk" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toEqual({ status: "approved" });
  });

  it("refuses to approve a card-less approval (409 card_required)", async () => {
    const created = await createCardlessApproval();
    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: "synthetic.header.sig", sealed_card: "c2VhbGVkLXN5bnRoZXRpYy1jYXJk" },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toEqual({ error: "card_required" });
  });

  it("rejects binding an owned card after the approval expires", async () => {
    const created = await createCardlessApproval();
    const cardId = await createOwnedCard(webCookie, "0007");
    // Card-less approvals get an 18-min JIT TTL — advance past it. That also
    // exceeds the 15-min web-session idle window, so re-mint the cookie (a
    // real user is still signed in) to isolate approval expiry from session
    // expiry.
    nowMs += 18 * 60 * 1000 + 1;
    const payer = await deps.accountStore.findAccountByEmail("payer@example.test");
    const freshCookie = await makeWebSession(deps, payer!.id, new Date(nowMs));

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: freshCookie },
      payload: { card_ref: cardId },
    });
    expect(bind.statusCode).toBe(409);
    expect(bind.json()).toEqual({ error: "payment_approval_expired" });

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ status: "expired", card_ref: null });
  });

  it("is write-once: a second bind on an already-bound approval is rejected", async () => {
    const created = await createCardlessApproval();
    const firstCard = await createOwnedCard(webCookie, "4242");
    const secondCard = await createOwnedCard(webCookie, "1111");

    const bind1 = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: firstCard },
    });
    expect(bind1.statusCode).toBe(200);

    const bind2 = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: secondCard },
    });
    expect(bind2.statusCode).toBe(409);
    expect(bind2.json()).toEqual({ error: "card_already_bound" });

    // The originally-bound card is unchanged.
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ card_ref: firstCard });
  });

  it("rejects binding a card owned by a different account (404 card_not_found)", async () => {
    const created = await createCardlessApproval();
    const foreignCard = await createOwnedCard(otherWebCookie);

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: foreignCard },
    });
    expect(bind.statusCode).toBe(404);
    expect(bind.json()).toEqual({ error: "card_not_found" });

    // The approval stays card-less — no foreign card leaked in.
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ card_ref: null });
  });

  it("keeps an approval card-less when its selected card was deleted", async () => {
    const created = await createCardlessApproval();
    const deletedCard = await createOwnedCard(webCookie, "1001");
    const deleted = await server.inject({
      method: "DELETE",
      url: `/v1/vault/e2e/${deletedCard}`,
      headers: { cookie: webCookie },
    });
    expect(deleted.statusCode).toBe(204);

    const rejected = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: deletedCard },
    });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toEqual({ error: "card_not_found" });

    const pending = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ card_ref: null, status: "pending" });

    const freshCard = await createOwnedCard(webCookie, "1002");
    const rebound = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: freshCard },
    });
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json()).toEqual({ card_ref: freshCard });
  });

  it("rejects binding a card to another account's approval (404 not_found)", async () => {
    const created = await createCardlessApproval();
    const otherCard = await createOwnedCard(otherWebCookie);

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: otherWebCookie },
      payload: { card_ref: otherCard },
    });
    expect(bind.statusCode).toBe(404);
    expect(bind.json()).toEqual({ error: "payment_approval_not_found" });
  });

  it("is pending-only: cannot rebind after the approval is approved", async () => {
    const created = await createCardlessApproval();
    const cardId = await createOwnedCard(webCookie);

    await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: cardId },
    });
    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: "synthetic.header.sig", sealed_card: "c2VhbGVkLXN5bnRoZXRpYy1jYXJk" },
    });
    expect(approve.statusCode).toBe(200);

    const rebind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: cardId },
    });
    expect(rebind.statusCode).toBe(409);
    expect(rebind.json()).toEqual({ error: "payment_approval_not_pending" });
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
