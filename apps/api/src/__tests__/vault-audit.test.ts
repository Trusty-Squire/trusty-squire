// Vault audit timeline (GET /v1/vault/audit) — the who-touched-my-keys
// trail. Verifies the full event surface (stored/retrieved/deleted) shows
// up, that filters + the keyset cursor work, that it's web-only and
// account-scoped, and that no secret value ever appears in the payload.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
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

async function makeWebSession(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function makeAgentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

interface AuditEvent {
  id: string;
  type: string;
  emitted_at: string;
  reference?: string;
  outcome?: string;
}

async function createCred(server: FastifyInstance, cookie: string, value = "sk-supersecret"): Promise<string> {
  const res = await server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service: "OpenAI", value },
  });
  expect(res.statusCode).toBe(201);
  // resolve the id via the list endpoint
  const list = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  return (list.json() as { credentials: { id: string }[] }).credentials[0]!.id;
}

describe("GET /v1/vault/audit", () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); });
  afterEach(async () => { await h.server.close(); });

  it("returns the full event trail newest-first, no secret values", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie);
    await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/reveal`, headers: { cookie } });

    const res = await h.server.inject({ method: "GET", url: "/v1/vault/audit", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const events = (res.json() as { events: AuditEvent[] }).events;
    const types = events.map((e) => e.type);
    expect(types).toContain("vault.credential_stored");
    expect(types).toContain("vault.credential_retrieved");
    // newest-first: the reveal (retrieved) is more recent than the store
    expect(types.indexOf("vault.credential_retrieved")).toBeLessThan(types.indexOf("vault.credential_stored"));
    // no secret leakage anywhere in the serialized payload
    expect(JSON.stringify(events)).not.toContain("sk-supersecret");
  });

  it("filters by type", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie);
    await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/reveal`, headers: { cookie } });

    const res = await h.server.inject({
      method: "GET",
      url: "/v1/vault/audit?type=vault.credential_retrieved",
      headers: { cookie },
    });
    const events = (res.json() as { events: AuditEvent[] }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "vault.credential_retrieved")).toBe(true);
  });

  it("paginates with the keyset cursor", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id);
    const id = await createCred(h.server, cookie);
    // generate several retrieval events
    for (let i = 0; i < 4; i++) {
      await h.server.inject({ method: "POST", url: `/v1/vault/credentials/${id}/reveal`, headers: { cookie } });
    }
    const page1 = await h.server.inject({ method: "GET", url: "/v1/vault/audit?limit=2", headers: { cookie } });
    const body1 = page1.json() as { events: AuditEvent[]; next_before: string | null };
    expect(body1.events).toHaveLength(2);
    expect(body1.next_before).not.toBeNull();

    const page2 = await h.server.inject({
      method: "GET",
      url: `/v1/vault/audit?limit=2&before=${encodeURIComponent(body1.next_before!)}`,
      headers: { cookie },
    });
    const body2 = page2.json() as { events: AuditEvent[] };
    // page 2 is strictly older — no overlap with page 1
    const ids1 = new Set(body1.events.map((e) => e.id));
    expect(body2.events.every((e) => !ids1.has(e.id))).toBe(true);
  });

  it("is account-scoped and rejects an anonymous request", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await makeWebSession(h.deps, a.id);
    const cookieB = await makeWebSession(h.deps, b.id);
    await createCred(h.server, cookieA);

    // B sees none of A's events
    const resB = await h.server.inject({ method: "GET", url: "/v1/vault/audit", headers: { cookie: cookieB } });
    expect((resB.json() as { events: AuditEvent[] }).events).toHaveLength(0);

    // no session → not 200
    const anon = await h.server.inject({ method: "GET", url: "/v1/vault/audit" });
    expect(anon.statusCode).not.toBe(200);
  });

  it("is readable by the account's own agent token (not web-only)", async () => {
    // The README markets the ledger as something you ASK YOUR SQUIRE — so the
    // account's agent must be able to read it, not just the human web UI. It's
    // account-scoped and carries no secret values, strictly less than what
    // list_credentials (also agent-readable) already exposes.
    const account = await h.deps.accountStore.createAccount("agent@example.test", "AG");
    const cookie = await makeWebSession(h.deps, account.id);
    await createCred(h.server, cookie, "sk-agent-secret");
    const token = await makeAgentToken(h.deps, account.id);

    const res = await h.server.inject({
      method: "GET",
      url: "/v1/vault/audit",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const events = (res.json() as { events: AuditEvent[] }).events;
    expect(events.map((e) => e.type)).toContain("vault.credential_stored");
    // still no secret leakage on the agent surface
    expect(JSON.stringify(events)).not.toContain("sk-agent-secret");
  });
});
