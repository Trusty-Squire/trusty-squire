// Egress Grants v1a — the transparent injecting proxy (POST /v1/egress/...).
//
// The load-bearing property: a deployed machine presents only a revocable
// EGRESS token; the server swaps it for the real vault secret and forwards
// upstream. The agent/app never holds the provider key.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { HttpProxyExecutor } from "../services/http-proxy.js";
import {
  EgressGrantStoreUnavailableError,
  type EgressGrant,
  type EgressGrantStore,
} from "../services/egress-grant.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

const seen: Array<{ url: string; auth: string | undefined; method: string; headers: Record<string, string> }> = [];
function fakeExecutor(): HttpProxyExecutor {
  return new HttpProxyExecutor({
    lookup: async () => ({ address: "203.0.113.9", family: 4 }),
    dispatch: async (input) => {
      seen.push({
        url: input.url.toString(),
        auth: input.headers.authorization,
        method: input.method,
        headers: { ...input.headers },
      });
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }), truncated: false };
    },
  });
}

interface Harness { server: FastifyInstance; deps: ApiDeps }
async function setup(opts: { egressGrantStore?: EgressGrantStore } = {}): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
  const server = await buildServer({
    deps,
    proxyExecutor: fakeExecutor(),
    ...(opts.egressGrantStore !== undefined ? { egressGrantStore: opts.egressGrantStore } : {}),
  });
  return { server, deps };
}
async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}
async function agentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({ account_id: accountId, agent_identity: "claude-code", agent_version: "test", now: new Date() });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}
async function storeCred(h: Harness, cookie: string, service: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST", url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service, value: "sk-the-real-secret", type: "api_key" },
  });
  return (res.json() as { reference: string }).reference;
}
async function mintGrantHttp(h: Harness, token: string, body: object): Promise<{ grant_id: string; base_url: string; egressToken: string }> {
  const res = await h.server.inject({
    method: "POST", url: "/v1/egress/grants",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: body,
  });
  const j = res.json() as { grant_id: string; base_url: string; token: string };
  return { grant_id: j.grant_id, base_url: j.base_url, egressToken: j.token };
}

describe("Egress Grants — /v1/egress", () => {
  let h: Harness;
  beforeEach(async () => { seen.length = 0; h = await setup(); });
  afterEach(async () => { await h.server.close(); });

  it("mints a grant and proxies: egress token swapped for the real secret server-side", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI"); // → api.openai.com

    const { grant_id, base_url, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });
    expect(grant_id.startsWith("g_")).toBe(true);
    expect(base_url).toContain(`/v1/egress/${grant_id}`);
    expect(egressToken.startsWith("sqr_egress_")).toBe(true);

    const res = await h.server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { model: "gpt-4o", messages: [] },
    });
    expect(res.statusCode).toBe(200);
    // The executor saw the REAL secret, not the egress token, at the right URL.
    expect(seen.at(-1)?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen.at(-1)?.auth).toBe("Bearer sk-the-real-secret");
    expect(seen.at(-1)?.method).toBe("POST");
  });

  it("rejects a bad/missing egress token (401) and never calls upstream", async () => {
    const account = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id } = await mintGrantHttp(h, token, { service: "OpenAI" });

    const bad = await h.server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: "Bearer sqr_egress_wrong", "content-type": "application/json" },
      payload: {},
    });
    expect(bad.statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("a revoked grant 403s", async () => {
    const account = await h.deps.accountStore.createAccount("r@example.test", "R");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    const del = await h.server.inject({ method: "DELETE", url: `/v1/egress/grants/${grant_id}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
    const res = await h.server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" }, payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("enforces the per-grant rate limit (429)", async () => {
    const account = await h.deps.accountStore.createAccount("rl@example.test", "RL");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI", rate_limit_per_hour: 1 });

    const call = () => h.server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" }, payload: {},
    });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
  });

  it("limits are OPT-IN: no rate_limit → unlimited (never 429), response shows null", async () => {
    const account = await h.deps.accountStore.createAccount("ul@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const res = await h.server.inject({
      method: "POST", url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI" }, // no rate_limit_per_hour, no spend_cap_usd
    });
    const j = res.json() as { grant_id: string; token: string; rate_limit_per_hour: number | null; spend_cap_usd: number | null };
    // Unlimited surfaces as null, not a default cap.
    expect(j.rate_limit_per_hour).toBeNull();
    expect(j.spend_cap_usd).toBeNull();

    const call = () => h.server.inject({
      method: "POST", url: `/v1/egress/${j.grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${j.token}`, "content-type": "application/json" }, payload: {},
    });
    // Many calls, never rate-limited.
    for (let i = 0; i < 5; i++) expect((await call()).statusCode).toBe(200);
  });

  it("refuses to mint a grant for a credential with an empty host allowlist", async () => {
    const account = await h.deps.accountStore.createAccount("empty-hosts@example.test", "Empty");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "UnknownProvider");

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "UnknownProvider" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "credential_unavailable",
      reason: "empty_allowed_hosts",
    });
  });

  it("maps grant-store connection collapse to retryable 503 instead of raw 500", async () => {
    await h.server.close();
    const backing = buildInMemoryDeps({ sessionSecret: SESSION_SECRET}).egressGrantStore;
    let failReads = false;
    const flakyStore: EgressGrantStore = {
      create: (grant: EgressGrant) => backing.create(grant),
      listByAccount: (accountId: string) => backing.listByAccount(accountId),
      revoke: (id: string, accountId: string, at: string) => backing.revoke(id, accountId, at),
      getById: async (id: string) => {
        if (failReads) throw new EgressGrantStoreUnavailableError("P1017 after retry");
        return backing.getById(id);
      },
    };
    h = await setup({ egressGrantStore: flakyStore });
    const account = await h.deps.accountStore.createAccount("p1017@example.test", "P");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    failReads = true;
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    // #231 — the 503 must carry a Retry-After (so a client backs off past the
    // outage window instead of burning a fixed retry budget) and a scope marker
    // (so it's distinguishable from an upstream model 503 and treated as
    // non-rung-consuming).
    expect(res.headers["retry-after"]).toBe("30");
    const body = res.json();
    expect(body.error).toBe("egress_temporarily_unavailable");
    expect(body.retryable).toBe(true);
    expect(body.scope).toBe("proxy");
    expect(body.retry_after_seconds).toBe(30);
    expect(seen).toHaveLength(0);
  });

  it("serves a repeat request from the credential cache (one DB read per streaming burst, #227/#231)", async () => {
    const account = await h.deps.accountStore.createAccount("cache@example.test", "C");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const originalFindActive = h.deps.credentialStore.findActive.bind(h.deps.credentialStore);
    let findActiveCalls = 0;
    h.deps.credentialStore.findActive = async (reference: string) => {
      findActiveCalls += 1;
      return originalFindActive(reference);
    };
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    for (let i = 0; i < 3; i++) {
      const res = await h.server.inject({
        method: "POST",
        url: `/v1/egress/${grant_id}/v1/chat/completions`,
        headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }
    // Three proxied requests, one credential DB read — the rest are cache hits.
    expect(findActiveCalls).toBe(1);
  });

  it("resolves the granted credential by reference instead of listing every account credential", async () => {
    const account = await h.deps.accountStore.createAccount("narrow@example.test", "N");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const originalList = h.deps.credentialStore.listByAccount.bind(h.deps.credentialStore);
    const originalFindActive = h.deps.credentialStore.findActive.bind(h.deps.credentialStore);
    let findActiveCalls = 0;
    h.deps.credentialStore.listByAccount = async (accountId: string) => originalList(accountId);
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });
    h.deps.credentialStore.listByAccount = async () => {
      throw new Error("egress proxy should not list all credentials");
    };
    h.deps.credentialStore.findActive = async (reference: string) => {
      findActiveCalls += 1;
      return originalFindActive(reference);
    };

    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(findActiveCalls).toBe(1);
  });

  it("injects the secret per the credential's stored auth_shape (header, not bearer)", async () => {
    const account = await h.deps.accountStore.createAccount("hdr@example.test", "H");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    // A non-bearer provider: the key rides in x-api-key, NOT Authorization.
    const store = await h.server.inject({
      method: "POST", url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "Anthropic",
        value: "sk-the-real-secret",
        type: "api_key",
        auth_shape: "header:x-api-key",
        observed_hosts: ["api.anthropic.com"],
      },
    });
    expect(store.statusCode).toBe(201);

    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "Anthropic" });
    const res = await h.server.inject({
      method: "POST", url: `/v1/egress/${grant_id}/v1/messages`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { model: "claude", messages: [] },
    });
    expect(res.statusCode).toBe(200);
    const last = seen.at(-1)!;
    // Secret injected into x-api-key; Authorization NOT set to the secret.
    expect(last.headers["x-api-key"]).toBe("sk-the-real-secret");
    expect(last.auth).toBeUndefined();
  });

  it("rejects an invalid auth_shape at store time (400)", async () => {
    const account = await h.deps.accountStore.createAccount("bad@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST", url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service: "OpenAI", value: "sk-x", auth_shape: "cookie:foo" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("the grant list never leaks the token hash", async () => {
    const account = await h.deps.accountStore.createAccount("l@example.test", "L");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    await mintGrantHttp(h, token, { service: "OpenAI" });
    const res = await h.server.inject({ method: "GET", url: "/v1/egress/grants", headers: { authorization: `Bearer ${token}` } });
    const body = res.json() as { grants: Array<Record<string, unknown>> };
    expect(body.grants).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });
});
