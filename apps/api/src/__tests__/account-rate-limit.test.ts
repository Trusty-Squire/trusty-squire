// Per-account rate limit on the authed control plane — a DoS backstop so one
// token can't hammer the vault/grant routes. Limit is read from
// API_ACCOUNT_HOURLY_LIMIT at server build; set it low here and confirm the 429.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const prevLimit = process.env.API_ACCOUNT_HOURLY_LIMIT;

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

describe("per-account rate limit", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(async () => {
    process.env.API_ACCOUNT_HOURLY_LIMIT = "2"; // tiny for the test
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    server = await buildServer({ deps });
  });
  afterEach(async () => {
    await server.close();
    if (prevLimit === undefined) delete process.env.API_ACCOUNT_HOURLY_LIMIT;
    else process.env.API_ACCOUNT_HOURLY_LIMIT = prevLimit;
  });

  it("returns 429 once an account exceeds the hourly limit", async () => {
    const account = await deps.accountStore.createAccount("rl@example.test", "RL");
    const token = await agentToken(deps, account.id);
    const hit = () =>
      server.inject({
        method: "GET",
        url: "/v1/vault/credentials",
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const third = await hit();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "rate_limited", scope: "account" });
  });

  it("limits per-account — a second account is unaffected by the first's burst", async () => {
    const a = await deps.accountStore.createAccount("a@example.test", "A");
    const b = await deps.accountStore.createAccount("b@example.test", "B");
    const ta = await agentToken(deps, a.id);
    const tb = await agentToken(deps, b.id);
    const hit = (t: string) =>
      server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { authorization: `Bearer ${t}` } });

    await hit(ta);
    await hit(ta);
    expect((await hit(ta)).statusCode).toBe(429); // A is over
    expect((await hit(tb)).statusCode).toBe(200); // B is fine
  });
});
