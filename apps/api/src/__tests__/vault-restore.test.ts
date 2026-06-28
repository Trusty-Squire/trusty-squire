// Vault undelete (POST /v1/vault/credentials/:id/restore) — soft-deletes
// are recoverable until a GDPR purge. Covers happy-path resurrection,
// the (service,label) conflict guard (409), 404s, and account scoping.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness { server: FastifyInstance; deps: ApiDeps; }

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
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
    payload: { service, value: `sk-${service}` },
  });
  expect(res.statusCode).toBe(201);
  const list = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  const creds = (list.json() as { credentials: { id: string; service: string }[] }).credentials;
  return creds.find((c) => c.service === service)!.id;
}

async function listServices(server: FastifyInstance, cookie: string): Promise<string[]> {
  const res = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  return (res.json() as { credentials: { service: string }[] }).credentials.map((c) => c.service);
}

describe("POST /v1/vault/credentials/:id/restore", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); });
  afterEach(async () => { await h.server.close(); });

  it("restores a soft-deleted credential and audits it", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie, "OpenAI");
    await h.server.inject({ method: "DELETE", url: `/v1/vault/credentials/${id}`, headers: { cookie } });
    expect(await listServices(h.server, cookie)).toHaveLength(0);

    const res = await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/restore`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(await listServices(h.server, cookie)).toEqual(["OpenAI"]);

    const audit = await h.server.inject({ method: "GET", url: "/v1/vault/audit?type=vault.credential_restored", headers: { cookie } });
    expect((audit.json() as { events: unknown[] }).events).toHaveLength(1);
  });

  it("refuses (409) when a live (service,label) twin occupies the slot", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie, "OpenAI");
    await h.server.inject({ method: "DELETE", url: `/v1/vault/credentials/${id}`, headers: { cookie } });
    // a new OpenAI takes the slot
    await createCred(h.server, cookie, "OpenAI");

    const res = await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/restore`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("restore_conflict");
  });

  it("404 for unknown id, and is account-scoped", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const idA = await createCred(h.server, cookieA, "OpenAI");
    await h.server.inject({ method: "DELETE", url: `/v1/vault/credentials/${idA}`, headers: { cookie: cookieA } });

    const unknown = await h.server.inject({ method: "POST", url: "/v1/vault/credentials/01HNOPE/restore", headers: { cookie: cookieA } });
    expect(unknown.statusCode).toBe(404);

    // B cannot restore A's deleted credential
    const cross = await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${idA}/restore`, headers: { cookie: cookieB } });
    expect(cross.statusCode).toBe(404);
  });
});
