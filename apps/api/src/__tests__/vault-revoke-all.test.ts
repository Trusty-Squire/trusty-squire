// Vault kill-switch (POST /v1/vault/credentials/revoke-all) — the "a key
// leaked, burn it all down" panic button. Soft-deletes every active
// credential for the account, audits each, requires explicit confirm.

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

async function createCred(server: FastifyInstance, cookie: string, service: string): Promise<void> {
  const res = await server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service, value: `sk-${service}` },
  });
  expect(res.statusCode).toBe(201);
}

async function listCount(server: FastifyInstance, cookie: string): Promise<number> {
  const res = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  return (res.json() as { credentials: unknown[] }).credentials.length;
}

describe("POST /v1/vault/credentials/revoke-all", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); });
  afterEach(async () => { await h.server.close(); });

  it("requires explicit confirmation", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    await createCred(h.server, cookie, "OpenAI");

    const noBody = await h.server.inject({ method: "POST", url: "/v1/vault/credentials/revoke-all", headers: { cookie, "content-type": "application/json" }, payload: {} });
    expect(noBody.statusCode).toBe(400);
    const wrong = await h.server.inject({ method: "POST", url: "/v1/vault/credentials/revoke-all", headers: { cookie, "content-type": "application/json" }, payload: { confirm: false } });
    expect(wrong.statusCode).toBe(400);
    // nothing revoked
    expect(await listCount(h.server, cookie)).toBe(1);
  });

  it("revokes every active credential and audits each", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    for (const s of ["OpenAI", "Stripe", "GitHub"]) await createCred(h.server, cookie, s);
    expect(await listCount(h.server, cookie)).toBe(3);

    const res = await h.server.inject({ method: "POST", url: "/v1/vault/credentials/revoke-all", headers: { cookie, "content-type": "application/json" }, payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revoked: number }).revoked).toBe(3);
    expect(await listCount(h.server, cookie)).toBe(0);

    // three deleted events, all tagged as the revoke-all path
    const audit = await h.server.inject({ method: "GET", url: "/v1/vault/audit?type=vault.credential_deleted&limit=50", headers: { cookie } });
    const events = (audit.json() as { events: { purpose?: string }[] }).events;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.purpose === "user:revoke_all")).toBe(true);
  });

  it("is account-scoped — one account's kill-switch leaves another's vault intact", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    await createCred(h.server, cookieA, "OpenAI");
    await createCred(h.server, cookieB, "Stripe");

    await h.server.inject({ method: "POST", url: "/v1/vault/credentials/revoke-all", headers: { cookie: cookieA, "content-type": "application/json" }, payload: { confirm: true } });
    expect(await listCount(h.server, cookieA)).toBe(0);
    expect(await listCount(h.server, cookieB)).toBe(1);
  });
});
