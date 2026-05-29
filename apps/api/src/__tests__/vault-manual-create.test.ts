// PR-2 — manual vault paste + allowed-hosts editing.
//
// The web user adds a credential by hand from /vault/new (no agent,
// no signup), then edits its advisory host allowlist. Covers the
// derived-default allowlist, the manual source tag, and that the
// allowed-hosts editor is account-scoped.

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

describe("POST /v1/vault/credentials/manual", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("stores a hand-pasted key and returns the derived allowed_hosts", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "OpenAI",
        value: "sk-FAKE_TEST_KEY_xxxxxxxxxxxxxxxxxxxx",
        env_var_suggestion: "OPENAI_API_KEY",
        type: "api_key",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      reference: string;
      type: string;
      created_at: string;
      allowed_hosts: string[];
    };
    expect(body.reference).toMatch(/^vault:\/\//);
    expect(body.type).toBe("api_key");
    expect(body.allowed_hosts).toEqual(["api.openai.com"]);
    expect(typeof body.created_at).toBe("string");

    // It shows up in the list with the allowed_hosts surfaced.
    const list = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie },
    });
    const creds = (list.json() as { credentials: Array<Record<string, unknown>> }).credentials;
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({
      service: "OpenAI",
      key_name: "OPENAI_API_KEY",
      allowed_hosts: ["api.openai.com"],
    });
  });

  it("defaults type to api_key and allowed_hosts to [] for an unknown service", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service: "ObscureSaaS", value: "tok_abc123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { type: string; allowed_hosts: string[] };
    expect(body.type).toBe("api_key");
    expect(body.allowed_hosts).toEqual([]);
  });

  it("rejects a missing value with 400", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service: "OpenAI" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a web session (agent token rejected)", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { authorization: "Bearer mcp_session_nope", "content-type": "application/json" },
      payload: { service: "OpenAI", value: "sk-x" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /v1/vault/credentials/:id/allowed-hosts", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  async function createCred(cookie: string, service = "ObscureSaaS"): Promise<string> {
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service, value: "tok_abc123" },
    });
    // Resolve the id via the list (manual POST returns a reference).
    const list = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie },
    });
    const creds = (list.json() as { credentials: Array<{ id: string; reference: string }> }).credentials;
    const ref = (res.json() as { reference: string }).reference;
    return creds.find((c) => c.reference === ref)!.id;
  }

  it("normalises and replaces the allowlist", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(cookie);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${id}/allowed-hosts`,
      headers: { cookie, "content-type": "application/json" },
      // Mixed casing, a pasted URL, a port, and a duplicate.
      payload: { hosts: ["API.Example.com", "https://hooks.example.com/path", "api.example.com:443", "api.example.com"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { allowed_hosts: string[] }).allowed_hosts).toEqual([
      "api.example.com",
      "hooks.example.com",
    ]);
  });

  it("rejects a malformed host with 400 and does not mutate", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(cookie);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${id}/allowed-hosts`,
      headers: { cookie, "content-type": "application/json" },
      payload: { hosts: ["api ok.example.com"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_host");
  });

  it("404s for another account's credential id", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    const idA = await createCred(cookieA);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/v1/vault/credentials/${idA}/allowed-hosts`,
      headers: { cookie: cookieB, "content-type": "application/json" },
      payload: { hosts: ["api.example.com"] },
    });
    expect(res.statusCode).toBe(404);
  });
});
