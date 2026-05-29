// PR-8 — agent-driven vault management by reference (store_credential /
// rotate_credential / delete_credential MCP tools' HTTP surface).

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
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, customerId: CUSTOMER_ID });
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

async function store(h: Harness, token: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { service: "OpenAI", value: "sk-original", type: "api_key" },
  });
  return (res.json() as { reference: string }).reference;
}

describe("agent vault management by reference", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("store returns allowed_hosts + created_at", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI", value: "sk-x", type: "api_key" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { reference: string; allowed_hosts: string[]; created_at: string };
    expect(body.allowed_hosts).toEqual(["api.openai.com"]);
    expect(typeof body.created_at).toBe("string");
  });

  it("rotate by reference returns rotated_at + revoked_grant_count", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    const reference = await store(h, token);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/rotate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reference, new_value: "sk-rotated" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revoked_grant_count: number }).revoked_grant_count).toBe(0);
  });

  it("delete by reference returns deleted_at", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(h.deps, account.id);
    const reference = await store(h, token);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/delete",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reference },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof (res.json() as { deleted_at: string }).deleted_at).toBe("string");
  });

  it("cannot rotate/delete another account's credential (404)", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const tokenA = await agentToken(h.deps, a.id);
    const tokenB = await agentToken(h.deps, b.id);
    const refA = await store(h, tokenA);

    const rot = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/rotate",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      payload: { reference: refA, new_value: "sk-hijack" },
    });
    expect(rot.statusCode).toBe(404);

    const del = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/delete",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      payload: { reference: refA },
    });
    expect(del.statusCode).toBe(404);
  });
});
