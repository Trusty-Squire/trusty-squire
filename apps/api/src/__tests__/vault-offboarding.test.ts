// Vault GDPR surfaces — export (everything we hold, no secrets) and the
// irreversible account deletion (purge credentials + audit trail, delete
// the account identity, revoke the session).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness { server: FastifyInstance; deps: ApiDeps; }

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, customerId: CUSTOMER_ID });
  const server = await buildServer({ deps });
  return { server, deps };
}

async function makeWebSession(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function createCred(server: FastifyInstance, cookie: string, service: string): Promise<string> {
  const res = await server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service, value: `sk-${service}-secret` },
  });
  expect(res.statusCode).toBe(201);
  const list = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  const creds = (list.json() as { credentials: { id: string; service: string }[] }).credentials;
  return creds.find((c) => c.service === service)!.id;
}

interface Export {
  exported_at: string;
  account_id: string;
  credentials: { service: string | null; deleted_at: string | null; field_names: string[] }[];
  audit_events: { type: string }[];
}

describe("GDPR export + erasure", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); });
  afterEach(async () => { await h.server.close(); });

  it("export returns all credentials + audit trail, no secret values", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie, "OpenAI");
    await createCred(h.server, cookie, "Stripe");
    await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/reveal`, headers: { cookie } });
    // soft-delete one so export must include deleted rows
    await h.server.inject({ method: "DELETE", url: `/v1/vault/credentials/${id}`, headers: { cookie } });

    const res = await h.server.inject({ method: "GET", url: "/v1/vault/export", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const data = res.json() as Export;
    expect(data.credentials).toHaveLength(2); // active + soft-deleted
    expect(data.credentials.some((c) => c.deleted_at !== null)).toBe(true);
    expect(data.audit_events.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain("secret"); // no sk-*-secret values
  });

  it("deletion requires confirm, then purges data + removes the account + kills the session", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    await createCred(h.server, cookie, "OpenAI");

    const noConfirm = await h.server.inject({ method: "DELETE", url: "/v1/vault/account", headers: { cookie, "content-type": "application/json" }, payload: {} });
    expect(noConfirm.statusCode).toBe(400);

    const purge = await h.server.inject({ method: "DELETE", url: "/v1/vault/account", headers: { cookie, "content-type": "application/json" }, payload: { confirm: true } });
    expect(purge.statusCode).toBe(200);
    const body = purge.json() as { credentials_purged: number; audit_purged: number; account_deleted: boolean };
    expect(body.credentials_purged).toBe(1);
    expect(body.audit_purged).toBeGreaterThan(0);
    expect(body.account_deleted).toBe(true);

    // account identity is gone
    expect(await h.deps.accountStore.findAccountById(account.id)).toBeNull();

    // session is dead — the cookie no longer authenticates
    const exp = await h.server.inject({ method: "GET", url: "/v1/vault/export", headers: { cookie } });
    expect(exp.statusCode).toBe(401);
  });

  it("erasure is account-scoped", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    await createCred(h.server, cookieA, "OpenAI");
    await createCred(h.server, cookieB, "Stripe");

    await h.server.inject({ method: "DELETE", url: "/v1/vault/account", headers: { cookie: cookieA, "content-type": "application/json" }, payload: { confirm: true } });

    const expB = await h.server.inject({ method: "GET", url: "/v1/vault/export", headers: { cookie: cookieB } });
    expect((expB.json() as Export).credentials).toHaveLength(1);
  });
});
