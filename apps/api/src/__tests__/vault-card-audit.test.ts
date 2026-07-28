// Card + payment + grant lifecycle on the vault audit trail.
//
// The load-bearing properties: (1) card add/delete and payment executions
// land as VaultAuditEvent rows the Activity page can render — display
// metadata only, never a PAN; (2) the card detail route's response shape
// carries the sealed blob + display metadata and NO cvv/pan field for any
// caller — the server cannot read those out of the E2E blob by design.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryVaultAuditStore, VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { NotifyingVaultAuditStore, type TelegramSend } from "../services/vault-notify.js";

const SESSION_SECRET = "synthetic-card-audit-test-secret";

interface AuditEvent {
  id: string;
  type: string;
  [key: string]: unknown;
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

describe("card / payment / grant events on the vault audit trail", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let accountId: string;
  let webCookie: string;
  let agentToken: string;

  beforeEach(async () => {
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    server = await buildServer({ deps });
    accountId = (await deps.accountStore.createAccount("card@example.test", "Card")).id;
    webCookie = await makeWebSession(deps, accountId);
    agentToken = await makeAgentToken(deps, accountId);
  });

  afterEach(async () => {
    await server.close();
  });

  async function auditEvents(): Promise<AuditEvent[]> {
    const res = await server.inject({
      method: "GET",
      url: "/v1/vault/audit",
      headers: { cookie: webCookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { events: AuditEvent[] }).events;
  }

  it("records card_stored and card_deleted with display metadata only", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: {
        label: "Personal Visa",
        blob: '{ "ciphertext": "synthetic-sealed" }',
        brand: "Visa",
        last4: "4242",
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };

    const remove = await server.inject({
      method: "DELETE",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(remove.statusCode).toBe(204);

    const events = await auditEvents();
    const stored = events.find((e) => e.type === "vault.card_stored");
    const deleted = events.find((e) => e.type === "vault.card_deleted");
    expect(stored).toMatchObject({
      reference: `card://${id}`,
      requester: "user",
      label: "Personal Visa",
      brand: "Visa",
      last4: "4242",
    });
    expect(deleted).toMatchObject({
      reference: `card://${id}`,
      requester: "user",
      label: "Personal Visa",
      last4: "4242",
    });
    // The sealed blob never reaches the audit trail.
    expect(JSON.stringify(events)).not.toContain("synthetic-sealed");
  });

  it("mirrors a payment execution onto the audit trail — merchant, amount, last4, never a PAN", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/vault/payments/audit",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        amountCents: 1234,
        currency: "USD",
        last4: "4242",
        status: "approved",
      },
    });
    expect(res.statusCode).toBe(201);

    const events = await auditEvents();
    const payment = events.find((e) => e.type === "vault.payment_executed");
    expect(payment).toMatchObject({
      requester: "agent",
      merchant: "Synthetic Books",
      amount_cents: 1234,
      currency: "USD",
      last4: "4242",
      payment_status: "approved",
    });
    expect(String(payment!.reference)).toMatch(/^pay:\/\//);
  });

  it("keeps card and payment mutations successful when audit writes fail", async () => {
    deps.vaultAuditStore.record = async () => {
      throw new Error("synthetic audit outage");
    };

    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: {
        label: "Offline audit card",
        blob: "synthetic-sealed",
        brand: "Visa",
        last4: "4242",
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };
    expect(await deps.e2eCredentialStore.getByIdForAccount(id, accountId)).not.toBeNull();

    const payment = await server.inject({
      method: "POST",
      url: "/v1/vault/payments/audit",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        amountCents: 1234,
        currency: "USD",
        last4: "4242",
        status: "approved",
      },
    });
    expect(payment.statusCode).toBe(201);
    expect(await deps.paymentAuditStore.listByAccount(accountId)).toHaveLength(1);

    const remove = await server.inject({
      method: "DELETE",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(remove.statusCode).toBe(204);
    expect(await deps.e2eCredentialStore.getByIdForAccount(id, accountId)).toBeNull();
  });

  it("records grant_minted and grant_revoked around an egress grant's life", async () => {
    const cred = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie: webCookie },
      payload: { service: "openrouter", value: "sk-synthetic", type: "api_key" },
    });
    expect(cred.statusCode).toBe(201);
    const reference = (cred.json() as { reference: string }).reference;

    const mint = await server.inject({
      method: "POST",
      url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { reference },
    });
    expect(mint.statusCode).toBe(201);
    const grantId = (mint.json() as { grant_id: string }).grant_id;

    const revoke = await server.inject({
      method: "DELETE",
      url: `/v1/egress/grants/${grantId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(revoke.statusCode).toBe(200);

    const events = await auditEvents();
    expect(events.find((e) => e.type === "vault.grant_minted")).toMatchObject({
      reference,
      requester: "agent",
      grant_id: grantId,
    });
    expect(events.find((e) => e.type === "vault.grant_revoked")).toMatchObject({
      reference,
      requester: "agent",
      grant_id: grantId,
    });
    // The grant's bearer token never lands on the audit trail.
    const token = (mint.json() as { token: string }).token;
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("emits one subject-rich revoke event and notification across retries", async () => {
    const audit = new InMemoryVaultAuditStore();
    const send = vi.fn<Parameters<TelegramSend>, ReturnType<TelegramSend>>(async () => true);
    await deps.accountStore.setTelegramChatId(accountId, "chat-42");
    deps.vaultAuditStore = new NotifyingVaultAuditStore(
      audit,
      deps.accountStore,
      () => new Date("2026-07-23T12:00:00.000Z"),
      send,
    );

    const cred = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie: webCookie },
      payload: {
        service: "openrouter",
        label: "production",
        value: "sk-synthetic",
        type: "api_key",
      },
    });
    const reference = (cred.json() as { reference: string }).reference;
    const mint = await server.inject({
      method: "POST",
      url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { reference },
    });
    const grantId = (mint.json() as { grant_id: string }).grant_id;

    for (let attempt = 0; attempt < 2; attempt++) {
      const revoke = await server.inject({
        method: "DELETE",
        url: `/v1/egress/grants/${grantId}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(revoke.statusCode).toBe(200);
    }
    await new Promise((resolve) => setImmediate(resolve));

    const events = await audit.list(accountId);
    expect(events.filter((event) => event.type === VAULT_AUDIT_TYPES.grantRevoked)).toHaveLength(1);
    expect(
      events.find((event) => event.type === VAULT_AUDIT_TYPES.grantMinted)?.payload,
    ).toMatchObject({
      reference,
      service: "openrouter",
      label: "production",
      grant_id: grantId,
    });
    expect(
      events.find((event) => event.type === VAULT_AUDIT_TYPES.grantRevoked)?.payload,
    ).toMatchObject({
      reference,
      service: "openrouter",
      label: "production",
      grant_id: grantId,
    });
    const revokeMessages = send.mock.calls
      .map(([, message]) => message)
      .filter((message) => message.includes("Egress grant revoked"));
    expect(revokeMessages).toHaveLength(1);
    expect(revokeMessages[0]).toContain("openrouter (production)");
    expect(revokeMessages[0]).toContain(grantId);
  });

  it("card detail response carries metadata + sealed blob and never a cvv/pan field", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: {
        label: "Detail card",
        blob: '{ "v": 1, "cipher": "aes-256-gcm", "iv": "aXY=", "ct": "c2VhbGVk" }',
        brand: "Mastercard",
        last4: "1111",
      },
    });
    const { id } = create.json() as { id: string };

    const detail = await server.inject({
      method: "GET",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as Record<string, unknown>;
    // Exact response shape — a CVV (or PAN) field can never appear, for any
    // caller: the server only ever holds them inside the sealed blob.
    expect(Object.keys(body).sort()).toEqual([
      "blob",
      "brand",
      "createdAt",
      "id",
      "label",
      "last4",
    ]);
    expect(body).toMatchObject({ id, brand: "Mastercard", last4: "1111" });
    expect(body).not.toHaveProperty("cvv");
    expect(body).not.toHaveProperty("pan");
  });
});
