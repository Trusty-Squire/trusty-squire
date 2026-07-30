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
    expect(list.json()).toEqual([expect.objectContaining({ id, label: "Synthetic card" })]);
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

  it("stores and returns card brand/last4 display metadata; legacy rows are null", async () => {
    const withMeta = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: {
        label: "Personal Visa",
        blob: '{ "ciphertext": "synthetic-sealed-pan" }',
        brand: "visa",
        last4: "4242",
      },
    });
    expect(withMeta.statusCode).toBe(201);
    const metaId = (withMeta.json() as { id: string }).id;

    // A card added before the metadata columns existed — no brand/last4.
    const legacy = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: { label: "Legacy card", blob: '{ "ciphertext": "synthetic-legacy" }' },
    });
    expect(legacy.statusCode).toBe(201);
    const legacyId = (legacy.json() as { id: string }).id;

    const list = await server.inject({
      method: "GET",
      url: "/v1/vault/e2e",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{
      id: string;
      brand: string | null;
      last4: string | null;
    }>;
    const meta = rows.find((r) => r.id === metaId);
    const legacyRow = rows.find((r) => r.id === legacyId);
    expect(meta).toMatchObject({ brand: "visa", last4: "4242" });
    expect(legacyRow).toMatchObject({ brand: null, last4: null });
    // The sealed blob never leaks into the list.
    expect(JSON.stringify(rows)).not.toContain("synthetic-sealed-pan");
  });

  it("rejects a full PAN supplied as last4 on the card blob route", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: {
        label: "Bad card",
        blob: '{ "ciphertext": "x" }',
        brand: "visa",
        last4: "4242424242424242",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a PAN smuggled into the brand field", async () => {
    for (const brand of ["4242424242424242", "4242 4242 4242 4242", "visa1"]) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/vault/e2e",
        headers: { cookie: webCookie },
        payload: { label: "Bad brand", blob: '{ "ciphertext": "x" }', brand, last4: "4242" },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("edits a card label in place (own record only)", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: { label: "Old label", blob: '{ "ciphertext": "x" }', brand: "mc", last4: "1111" },
    });
    const id = (create.json() as { id: string }).id;

    const patch = await server.inject({
      method: "PATCH",
      url: `/v1/vault/e2e/${id}/label`,
      headers: { cookie: webCookie },
      payload: { label: "New label" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ id, label: "New label" });

    // The single-record GET returns the sealed blob; confirm the label moved.
    const get = await server.inject({
      method: "GET",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(get.json()).toMatchObject({ label: "New label" });

    // brand/last4 (surfaced only on the list) untouched by the label-only edit.
    const list = await server.inject({
      method: "GET",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
    });
    const row = (
      list.json() as Array<{ id: string; label: string; brand: string; last4: string }>
    ).find((r) => r.id === id);
    expect(row).toMatchObject({ label: "New label", brand: "mc", last4: "1111" });
  });

  it("rejects an empty label on PATCH", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: { label: "Keep", blob: '{ "ciphertext": "x" }' },
    });
    const id = (create.json() as { id: string }).id;
    const patch = await server.inject({
      method: "PATCH",
      url: `/v1/vault/e2e/${id}/label`,
      headers: { cookie: webCookie },
      payload: { label: "" },
    });
    expect(patch.statusCode).toBe(400);
  });

  it("denies a cross-account label PATCH", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: { label: "Owner label", blob: '{ "ciphertext": "x" }' },
    });
    const id = (create.json() as { id: string }).id;

    const patch = await server.inject({
      method: "PATCH",
      url: `/v1/vault/e2e/${id}/label`,
      headers: { cookie: otherWebCookie },
      payload: { label: "Hijacked" },
    });
    expect(patch.statusCode).toBe(404);

    // The victim's label is unchanged.
    const get = await server.inject({
      method: "GET",
      url: `/v1/vault/e2e/${id}`,
      headers: { cookie: webCookie },
    });
    expect(get.json()).toMatchObject({ label: "Owner label" });
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
