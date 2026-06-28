// PATCH /v1/vault/credentials/:id/label (rename) +
// POST  /v1/vault/credentials/:id/fields (add a field).
//
// Rename changes the non-secret label only. Add-field merges a new field
// into the encrypted blob server-side (the UI never supplies existing
// values — write-only vault); a name collision is rejected 409. Both are
// web-session only and account-scoped.

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
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
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
  h: Harness,
  cookie: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; reference: string; label: string; field_names: string[] }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service: "OpenAI", type: "api_key", ...payload },
  });
  const reference = (res.json() as { reference: string }).reference;
  const list = await h.server.inject({
    method: "GET",
    url: "/v1/vault/credentials",
    headers: { cookie },
  });
  const creds = (
    list.json() as {
      credentials: Array<{ id: string; reference: string; label: string; field_names: string[] }>;
    }
  ).credentials;
  return creds.find((c) => c.reference === reference)!;
}

describe("PATCH /v1/vault/credentials/:id/label (rename)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("renames the entry; the list reflects the new label", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const { id, label } = await createCred(h, cookie, { value: "sk-x" });
    expect(label).toBe("default");

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${id}/label`,
      headers: { cookie, "content-type": "application/json" },
      payload: { label: "prod" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { label: string }).label).toBe("prod");

    const list = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie },
    });
    const found = (list.json() as { credentials: Array<{ id: string; label: string }> }).credentials.find(
      (c) => c.id === id,
    );
    expect(found?.label).toBe("prod");
  });

  it("rejects an empty label with 400", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const { id } = await createCred(h, cookie, { value: "sk-x" });
    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${id}/label`,
      headers: { cookie, "content-type": "application/json" },
      payload: { label: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot rename another account's entry (404)", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const { id: idA } = await createCred(h, cookieA, { value: "sk-a" });
    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${idA}/label`,
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { label: "stolen" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/vault/credentials/:id/fields (add field)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("adds a field; reveal returns existing + new, field_names updated", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    // Start with a multi-field cred so we prove existing fields survive.
    const { id } = await createCred(h, cookie, {
      fields: { access_key_id: "AKIA123", secret_access_key: "s3cr3t" },
    });

    const res = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/fields`,
      headers: { cookie, "content-type": "application/json" },
      payload: { name: "region", value: "us-east-1" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { field_names: string[] }).field_names.sort()).toEqual(
      ["access_key_id", "region", "secret_access_key"],
    );

    const reveal = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/reveal`,
      headers: { cookie },
    });
    const fields = (reveal.json() as { fields: Record<string, string> }).fields;
    expect(fields).toEqual({
      access_key_id: "AKIA123",
      secret_access_key: "s3cr3t",
      region: "us-east-1",
    });
  });

  it("rejects a duplicate field name with 409", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const { id } = await createCred(h, cookie, { fields: { token: "t1" } });
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/fields`,
      headers: { cookie, "content-type": "application/json" },
      payload: { name: "token", value: "t2" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("field_exists");
  });

  it("rejects a missing value with 400", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const { id } = await createCred(h, cookie, { value: "sk-x" });
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${id}/fields`,
      headers: { cookie, "content-type": "application/json" },
      payload: { name: "region" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot add a field to another account's entry (404)", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const { id: idA } = await createCred(h, cookieA, { value: "sk-a" });
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${idA}/fields`,
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { name: "region", value: "us-east-1" },
    });
    expect(res.statusCode).toBe(404);
  });
});
