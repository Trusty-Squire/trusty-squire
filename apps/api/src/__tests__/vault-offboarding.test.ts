// Vault GDPR surfaces — export (everything we hold, no plaintext secrets) and the
// irreversible account deletion (purge credentials + audit trail, delete
// the account identity, revoke the session).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
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

async function createCred(
  server: FastifyInstance,
  cookie: string,
  service: string,
): Promise<string> {
  const res = await server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service, value: `sk-${service}-secret` },
  });
  expect(res.statusCode).toBe(201);
  const list = await server.inject({
    method: "GET",
    url: "/v1/vault/credentials",
    headers: { cookie },
  });
  const creds = (list.json() as { credentials: { id: string; service: string }[] }).credentials;
  return creds.find((c) => c.service === service)!.id;
}

interface Export {
  exported_at: string;
  account_id: string;
  credentials: { service: string | null; deleted_at: string | null; field_names: string[] }[];
  audit_events: { type: string }[];
  e2e_credentials: { id: string; label: string; blob: string; created_at: string }[];
  payment_audit_events: {
    id: string;
    merchant: string;
    amount_cents: number;
    currency: string;
    last4: string;
    status: string;
    mandate_id: string | null;
    created_at: string;
  }[];
}

describe("GDPR export + erasure", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("export returns all credentials + audit trail, no secret values", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie, "OpenAI");
    await createCred(h.server, cookie, "Stripe");
    await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/reveal`,
      headers: { cookie },
    });
    // soft-delete one so export must include deleted rows
    await h.server.inject({
      method: "DELETE",
      url: `/v1/vault/credentials/${id}`,
      headers: { cookie },
    });

    const res = await h.server.inject({
      method: "GET",
      url: "/v1/vault/export",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const data = res.json() as Export;
    expect(data.credentials).toHaveLength(2); // active + soft-deleted
    expect(data.credentials.some((c) => c.deleted_at !== null)).toBe(true);
    expect(data.audit_events.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain("secret"); // no sk-*-secret values
  });

  it("export includes account-scoped E2E credentials and payment audit events", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const other = await h.deps.accountStore.createAccount("other@example.test", "Other");
    const cookie = await makeWebSession(h.deps, account.id);
    const e2eId = await h.deps.e2eCredentialStore.create(
      account.id,
      "Primary card",
      "opaque-card-blob",
    );
    const paymentId = await h.deps.paymentAuditStore.create(account.id, {
      merchant: "Example Store",
      amountCents: 2599,
      currency: "USD",
      last4: "4242",
      status: "approved",
      mandateId: "mandate-1",
    });
    await h.deps.e2eCredentialStore.create(other.id, "Other card", "other-account-blob");
    await h.deps.paymentAuditStore.create(other.id, {
      merchant: "Other Store",
      amountCents: 999,
      currency: "USD",
      last4: "1111",
      status: "declined",
    });

    const res = await h.server.inject({
      method: "GET",
      url: "/v1/vault/export",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json() as Export;
    expect(data.e2e_credentials).toEqual([
      {
        id: e2eId,
        label: "Primary card",
        blob: "opaque-card-blob",
        created_at: expect.any(String),
      },
    ]);
    expect(data.payment_audit_events).toEqual([
      {
        id: paymentId,
        merchant: "Example Store",
        amount_cents: 2599,
        currency: "USD",
        last4: "4242",
        status: "approved",
        mandate_id: "mandate-1",
        created_at: expect.any(String),
      },
    ]);
  });

  it("deletion requires confirm, then purges data + removes the account + kills the session", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    await createCred(h.server, cookie, "OpenAI");

    const noConfirm = await h.server.inject({
      method: "DELETE",
      url: "/v1/vault/account",
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(noConfirm.statusCode).toBe(400);

    const purge = await h.server.inject({
      method: "DELETE",
      url: "/v1/vault/account",
      headers: { cookie, "content-type": "application/json" },
      payload: { confirm: true },
    });
    expect(purge.statusCode).toBe(200);
    const body = purge.json() as {
      credentials_purged: number;
      audit_purged: number;
      account_deleted: boolean;
    };
    expect(body.credentials_purged).toBe(1);
    expect(body.audit_purged).toBeGreaterThan(0);
    expect(body.account_deleted).toBe(true);

    // account identity is gone
    expect(await h.deps.accountStore.findAccountById(account.id)).toBeNull();

    // session is dead — the cookie no longer authenticates
    const exp = await h.server.inject({
      method: "GET",
      url: "/v1/vault/export",
      headers: { cookie },
    });
    expect(exp.statusCode).toBe(401);
  });

  it("erasure is account-scoped", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    await createCred(h.server, cookieA, "OpenAI");
    await createCred(h.server, cookieB, "Stripe");

    await h.server.inject({
      method: "DELETE",
      url: "/v1/vault/account",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { confirm: true },
    });

    const expB = await h.server.inject({
      method: "GET",
      url: "/v1/vault/export",
      headers: { cookie: cookieB },
    });
    expect((expB.json() as Export).credentials).toHaveLength(1);
  });
});
