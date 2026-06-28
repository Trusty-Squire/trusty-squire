// Vault credential health probe (POST /v1/vault/credentials/:id/health).
// Confirms the encrypted envelope still decrypts — no secret returned,
// no upstream call. Covers the healthy path, 404, and account scoping.

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
    payload: { service, value: "sk-do-not-leak-me" },
  });
  expect(res.statusCode).toBe(201);
  const list = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  const creds = (list.json() as { credentials: { id: string; service: string }[] }).credentials;
  return creds.find((c) => c.service === service)!.id;
}

describe("POST /v1/vault/credentials/:id/health", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); });
  afterEach(async () => { await h.server.close(); });

  it("reports healthy, never leaks the secret, and counts no retrieval", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie, "OpenAI");

    const res = await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/health`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { healthy: boolean; field_count: number; checked_at: string };
    expect(body.healthy).toBe(true);
    expect(body.field_count).toBe(1);
    expect(res.body).not.toContain("sk-do-not-leak-me");

    // a health probe is not a retrieval — retrieval_count stays 0
    const list = await h.server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
    const cred = (list.json() as { credentials: { id: string; retrieval_count: number }[] }).credentials.find((c) => c.id === id);
    expect(cred!.retrieval_count).toBe(0);
  });

  it("404 for unknown id and across accounts", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const idA = await createCred(h.server, cookieA, "OpenAI");

    const unknown = await h.server.inject({ method: "POST", url: "/v1/vault/credentials/01HNOPE/health", headers: { cookie: cookieA } });
    expect(unknown.statusCode).toBe(404);
    const cross = await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${idA}/health`, headers: { cookie: cookieB } });
    expect(cross.statusCode).toBe(404);
  });
});
