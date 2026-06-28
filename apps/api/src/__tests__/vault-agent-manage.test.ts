// Agent vault writes: store is an upsert (create, then overwrite the
// same service+label). Agents have no rotate/delete (those routes are
// gone — rotation = re-store; delete is web-only).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
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

async function agentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

describe("agent store (upsert)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("first store creates (201) with field_names + allowed_hosts", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI", value: "sk-x", type: "api_key" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { service: string; label: string; field_names: string[]; allowed_hosts: string[]; updated: boolean };
    expect(body.service).toBe("OpenAI");
    expect(body.label).toBe("default");
    expect(body.field_names).toEqual(["value"]);
    expect(body.allowed_hosts).toEqual(["api.openai.com"]);
    expect(body.updated).toBe(false);
  });

  it("re-store of the same service overwrites (200, updated:true), no duplicate row", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    const post = (value: string) =>
      h.server.inject({
        method: "POST",
        url: "/v1/vault/credentials",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { service: "OpenAI", value },
      });
    const first = await post("sk-old");
    const second = await post("sk-new");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { updated: boolean }).updated).toBe(true);

    const list = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((list.json() as { credentials: unknown[] }).credentials).toHaveLength(1);
  });

  it("stores a multi-field credential", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "AWS", fields: { access_key_id: "AKIA", secret_access_key: "shh" } },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { field_names: string[] }).field_names.sort()).toEqual([
      "access_key_id",
      "secret_access_key",
    ]);
  });

  it("the removed agent rotate/delete routes are gone (404)", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    for (const url of ["/v1/vault/credentials/rotate", "/v1/vault/credentials/delete"]) {
      const res = await h.server.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { reference: "vault://x", new_value: "y" },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
