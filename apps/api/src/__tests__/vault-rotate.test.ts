// PR-2 — PATCH /v1/vault/credentials/:id (rotate value).
//
// Rotating swaps the stored ciphertext while keeping the reference; a
// subsequent reveal returns the new value. revoked_grant_count is 0
// until the AccessGrant cascade lands in a later PR. Cross-account ids
// and unknown ids 404.

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

// Manual-create a credential and return its id + reference.
async function createCred(
  h: Harness,
  cookie: string,
  value: string,
): Promise<{ id: string; reference: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service: "OpenAI", value, type: "api_key" },
  });
  const reference = (res.json() as { reference: string }).reference;
  const list = await h.server.inject({
    method: "GET",
    url: "/v1/vault/credentials",
    headers: { cookie },
  });
  const creds = (list.json() as { credentials: Array<{ id: string; reference: string }> }).credentials;
  return creds.find((c) => c.reference === reference)!;
}

describe("PATCH /v1/vault/credentials/:id", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("rotates the value; reveal returns the new secret", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const { id } = await createCred(h, cookie, "sk-original-value");

    const rotate = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { new_value: "sk-rotated-value" },
    });
    expect(rotate.statusCode).toBe(200);
    const body = rotate.json() as { rotated_at: string; revoked_grant_count: number };
    expect(typeof body.rotated_at).toBe("string");
    expect(body.revoked_grant_count).toBe(0);

    const reveal = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/reveal`,
      headers: { cookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect((reveal.json() as { value: string }).value).toBe("sk-rotated-value");
  });

  it("rejects an empty new_value with 400", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const { id } = await createCred(h, cookie, "sk-original");
    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { new_value: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown id", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/01HNONEXISTENTAAAAAAAAAAAA`,
      headers: { cookie, "content-type": "application/json" },
      payload: { new_value: "sk-x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("cannot rotate another account's credential", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const { id: idA } = await createCred(h, cookieA, "sk-account-a");

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${idA}`,
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { new_value: "sk-hijack" },
    });
    expect(res.statusCode).toBe(404);

    // A's value is untouched.
    const reveal = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${idA}/reveal`,
      headers: { cookie: cookieA },
    });
    expect((reveal.json() as { value: string }).value).toBe("sk-account-a");
  });
});
