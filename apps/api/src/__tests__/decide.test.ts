// POST /v1/decide + GET /v1/usage — platform Jev. See
// docs/DESIGN-jev-platform-route.md test plan.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { InMemoryDecisionEventStore } from "../services/decision-events.js";
import { buildServer } from "../server.js";
import { HttpProxyExecutor, ProxyError } from "../services/http-proxy.js";
import { CRITERIA_LIMIT, JEV_ENDPOINT, JEV_MODEL, QUESTION_LIMIT, STATE_LIMIT_BYTES } from "../routes/decide.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

interface Captured {
  url: string;
  auth: string | undefined;
  body: string | undefined;
}

function fakeExecutor(
  captured: Captured[],
  respond: () => {
    status: number;
    headers?: Record<string, string>;
    body: string;
  } = () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      usage: { input_tokens: 420, output_tokens: 73 },
      answers: { pick: { choice: "@e:reveal" } },
    }),
  }),
): HttpProxyExecutor {
  return new HttpProxyExecutor({
    lookup: async () => ({ address: "203.0.113.9", family: 4 }),
    dispatch: async (input) => {
      captured.push({
        url: input.url.toString(),
        auth: input.headers.authorization,
        body: input.body,
      });
      const response = respond();
      return {
        status: response.status,
        headers: response.headers ?? { "content-type": "application/json" },
        body: response.body,
        truncated: false,
      };
    },
  });
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

const QUESTIONS = {
  pick: {
    type: "choice" as const,
    instructions: "Which element advances the goal?",
    criteria: { "@e:reveal": "reveal button" },
  },
};

describe("POST /v1/decide", () => {
  const prevKey = process.env.TYPESAFE_API_KEY;
  const prevLimit = process.env.API_ACCOUNT_HOURLY_LIMIT;
  let server: FastifyInstance;
  let deps: ApiDeps;
  let captured: Captured[];
  let ledger: InMemoryDecisionEventStore;

  beforeEach(async () => {
    process.env.TYPESAFE_API_KEY = "sk-platform-typesafe";
    captured = [];
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    ledger = new InMemoryDecisionEventStore();
    deps.decisionEventStore = ledger;
    server = await buildServer({ deps, proxyExecutor: fakeExecutor(captured) });
  });
  afterEach(async () => {
    await server.close();
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prevKey;
    if (prevLimit === undefined) delete process.env.API_ACCOUNT_HOURLY_LIMIT;
    else process.env.API_ACCOUNT_HOURLY_LIMIT = prevLimit;
  });

  it("requires agent auth", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "content-type": "application/json" },
      payload: { state: "page", questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "agent_session_required" });
  });

  it("forwards body and returns upstream status/body verbatim", async () => {
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "https://fixture.test/page", questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      model: JEV_MODEL,
      usage: { input_tokens: 420, output_tokens: 73 },
      answers: { pick: { choice: "@e:reveal" } },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(JEV_ENDPOINT);
    expect(captured[0]?.auth).toBe("Bearer sk-platform-typesafe");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({
      state: "https://fixture.test/page",
      model: JEV_MODEL,
      questions: QUESTIONS,
    });
  });

  it("passes through upstream 503 verbatim", async () => {
    await server.close();
    captured = [];
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    ledger = new InMemoryDecisionEventStore();
    deps.decisionEventStore = ledger;
    server = await buildServer({
      deps,
      proxyExecutor: fakeExecutor(captured, () => ({
        status: 503,
        body: JSON.stringify({ detail: { error_type: "model_unavailable" } }),
      })),
    });
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "page", questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ detail: { error_type: "model_unavailable" } });
  });

  it("rejects oversized state with the limit named", async () => {
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "x".repeat(STATE_LIMIT_BYTES + 1), questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "state_too_large", limit_bytes: STATE_LIMIT_BYTES });
    expect(captured).toHaveLength(0);
  });

  it("rejects too many questions with the limit named", async () => {
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const questions: Record<string, (typeof QUESTIONS)["pick"]> = {};
    for (let i = 0; i < QUESTION_LIMIT + 1; i++) questions[`q${i}`] = QUESTIONS.pick;
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "page", questions },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "too_many_questions", limit: QUESTION_LIMIT });
  });

  it("rejects too many choice criteria with the limit named", async () => {
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const criteria: Record<string, string> = {};
    for (let i = 0; i < CRITERIA_LIMIT + 1; i++) criteria[`opt${i}`] = `option ${i}`;
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        state: "page",
        questions: {
          pick: { type: "choice", instructions: "pick", criteria },
        },
      },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "too_many_criteria", limit: CRITERIA_LIMIT });
  });

  it("returns 504 jev_timeout when the outbound fetch times out", async () => {
    await server.close();
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    ledger = new InMemoryDecisionEventStore();
    deps.decisionEventStore = ledger;
    server = await buildServer({
      deps,
      proxyExecutor: new HttpProxyExecutor({
        lookup: async () => ({ address: "203.0.113.9", family: 4 }),
        dispatch: async () => {
          throw new ProxyError("timeout", "upstream timed out");
        },
      }),
    });
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "page", questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: "jev_timeout" });
  });

  it("returns 503 jev_unconfigured when the platform secret is absent", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "page", questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "jev_unconfigured" });
    expect(captured).toHaveLength(0);
  });

  it("writes a ledger row with token counts", async () => {
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const token = await agentToken(deps, account.id);
    const res = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "page", questions: QUESTIONS },
    });
    expect(res.statusCode).toBe(200);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({
      account_id: account.id,
      model: JEV_MODEL,
      input_tokens: 420,
      output_tokens: 73,
      upstream_status: 200,
      questions: 1,
    });
    expect(ledger.events[0]?.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("is not counted by the per-account hourly limit", async () => {
    process.env.API_ACCOUNT_HOURLY_LIMIT = "2";
    await server.close();
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    ledger = new InMemoryDecisionEventStore();
    deps.decisionEventStore = ledger;
    server = await buildServer({ deps, proxyExecutor: fakeExecutor(captured) });

    const account = await deps.accountStore.createAccount("rl@example.test", "RL");
    const token = await agentToken(deps, account.id);
    const vaultHit = () =>
      server.inject({
        method: "GET",
        url: "/v1/vault/credentials",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await vaultHit()).statusCode).toBe(200);
    expect((await vaultHit()).statusCode).toBe(200);
    expect((await vaultHit()).statusCode).toBe(429);

    const decide = await server.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { state: "page", questions: QUESTIONS },
    });
    expect(decide.statusCode).toBe(200);
    expect((await vaultHit()).statusCode).toBe(429);
  });
});

describe("GET /v1/usage", () => {
  const prevKey = process.env.TYPESAFE_API_KEY;
  let server: FastifyInstance;
  let deps: ApiDeps;
  let ledger: InMemoryDecisionEventStore;

  beforeEach(async () => {
    process.env.TYPESAFE_API_KEY = "sk-platform-typesafe";
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date("2026-09-18T12:00:00Z"),
    });
    ledger = new InMemoryDecisionEventStore();
    deps.decisionEventStore = ledger;
    server = await buildServer({
      deps,
      proxyExecutor: fakeExecutor([]),
    });
  });
  afterEach(async () => {
    await server.close();
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prevKey;
  });

  it("sums the current UTC month from the ledger", async () => {
    const account = await deps.accountStore.createAccount("u@example.test", "U");
    const other = await deps.accountStore.createAccount("o@example.test", "O");
    const token = await agentToken(deps, account.id);
    await ledger.record({
      account_id: account.id,
      occurred_at: new Date("2026-09-01T00:00:00Z"),
      model: JEV_MODEL,
      input_tokens: 100,
      output_tokens: 10,
      upstream_status: 200,
      latency_ms: 40,
      questions: 2,
    });
    await ledger.record({
      account_id: account.id,
      occurred_at: new Date("2026-09-18T11:00:00Z"),
      model: JEV_MODEL,
      input_tokens: 320,
      output_tokens: 63,
      upstream_status: 200,
      latency_ms: 50,
      questions: 1,
    });
    await ledger.record({
      account_id: account.id,
      occurred_at: new Date("2026-08-31T23:59:59Z"),
      model: JEV_MODEL,
      input_tokens: 9999,
      output_tokens: 9999,
      upstream_status: 200,
      latency_ms: 10,
      questions: 1,
    });
    await ledger.record({
      account_id: other.id,
      occurred_at: new Date("2026-09-18T11:00:00Z"),
      model: JEV_MODEL,
      input_tokens: 50,
      output_tokens: 5,
      upstream_status: 200,
      latency_ms: 10,
      questions: 1,
    });

    const res = await server.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      decisions: { month_calls: 2, month_input_tokens: 420, month_output_tokens: 73 },
    });
  });
});
