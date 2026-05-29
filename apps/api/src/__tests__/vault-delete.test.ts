// PR-2 — DELETE /v1/vault/credentials/:id (soft delete).
//
// Soft-deleting removes the credential from the list and makes a reveal
// 404. The account-scoped lookup is the ownership gate; another
// account's id 404s and leaves the credential intact.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, customerId: CUSTOMER_ID });
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

async function createCred(h: Harness, cookie: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service: "OpenAI", value: "sk-to-be-deleted", type: "api_key" },
  });
  const reference = (res.json() as { reference: string }).reference;
  const list = await h.server.inject({
    method: "GET",
    url: "/v1/vault/credentials",
    headers: { cookie },
  });
  const creds = (list.json() as { credentials: Array<{ id: string; reference: string }> }).credentials;
  return creds.find((c) => c.reference === reference)!.id;
}

describe("DELETE /v1/vault/credentials/:id", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("soft-deletes: gone from the list, reveal 404s", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h, cookie);

    const del = await h.server.inject({
      method: "DELETE",
      url: `/v1/vault/credentials/${id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const list = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie },
    });
    expect((list.json() as { credentials: unknown[] }).credentials).toHaveLength(0);

    const reveal = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/reveal`,
      headers: { cookie },
    });
    expect(reveal.statusCode).toBe(404);
  });

  it("404s an unknown id", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const res = await h.server.inject({
      method: "DELETE",
      url: `/v1/vault/credentials/01HNONEXISTENTAAAAAAAAAAAA`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("cannot delete another account's credential", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const idA = await createCred(h, cookieA);

    const res = await h.server.inject({
      method: "DELETE",
      url: `/v1/vault/credentials/${idA}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);

    // Still there for A.
    const list = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie: cookieA },
    });
    expect((list.json() as { credentials: unknown[] }).credentials).toHaveLength(1);
  });
});
