// Egress Grants v1a — the transparent injecting proxy (POST /v1/egress/...).
//
// The load-bearing property: a deployed machine presents only a revocable
// EGRESS token; the server swaps it for the real vault secret and forwards
// upstream. The agent/app never holds the provider key.

import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { VAULT_AUDIT_TYPES, type VaultAuditPayload } from "@trusty-squire/vault";
import { HttpProxyExecutor } from "../services/http-proxy.js";
import {
  EgressGrantStoreUnavailableError,
  type EgressGrant,
  type EgressGrantStore,
} from "../services/egress-grant.js";
import { streamOf } from "./dispatch-fixture.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

const seen: Array<{
  url: string;
  auth: string | undefined;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}> = [];
function fakeExecutor(): HttpProxyExecutor {
  return new HttpProxyExecutor({
    lookup: async () => ({ address: "203.0.113.9", family: 4 }),
    dispatch: async (input) => {
      seen.push({
        url: input.url.toString(),
        auth: input.headers.authorization,
        method: input.method,
        headers: { ...input.headers },
        body: input.body,
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyStream: streamOf(JSON.stringify({ ok: true })),
        truncated: false,
      };
    },
  });
}

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}
// The streamed row's amendment is fire-and-forget by design (the route must not
// wait on it), so read it back with a bounded poll rather than a fixed sleep.
async function pollAudit(
  deps: ApiDeps,
  accountId: string,
  match: (payload: VaultAuditPayload) => boolean,
): Promise<VaultAuditPayload> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await deps.vaultAuditStore.list(accountId, {
      type: VAULT_AUDIT_TYPES.proxyExecuted,
      limit: 50,
    });
    const hit = rows.map((r) => r.payload).find(match);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no matching vault.proxy_executed audit row");
}
async function setup(opts: { egressGrantStore?: EgressGrantStore } = {}): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
  const server = await buildServer({
    deps,
    proxyExecutor: fakeExecutor(),
    ...(opts.egressGrantStore !== undefined ? { egressGrantStore: opts.egressGrantStore } : {}),
  });
  return { server, deps };
}
async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now: new Date(),
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
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
async function storeCred(h: Harness, cookie: string, service: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service, value: "sk-the-real-secret", type: "api_key" },
  });
  return (res.json() as { reference: string }).reference;
}
async function mintGrantHttp(
  h: Harness,
  token: string,
  body: object,
): Promise<{ grant_id: string; base_url: string; egressToken: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/egress/grants",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: body,
  });
  const j = res.json() as { grant_id: string; base_url: string; token: string };
  return { grant_id: j.grant_id, base_url: j.base_url, egressToken: j.token };
}

describe("Egress Grants — /v1/egress", () => {
  let h: Harness;
  beforeEach(async () => {
    seen.length = 0;
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("mints a grant and proxies: egress token swapped for the real secret server-side", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI"); // → api.openai.com

    const { grant_id, base_url, egressToken } = await mintGrantHttp(h, token, {
      service: "OpenAI",
    });
    expect(grant_id.startsWith("g_")).toBe(true);
    expect(base_url).toContain(`/v1/egress/${grant_id}`);
    expect(egressToken.startsWith("sqr_egress_")).toBe(true);

    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { model: "gpt-4o", messages: [] },
    });
    expect(res.statusCode).toBe(200);
    // The executor saw the REAL secret, not the egress token, at the right URL.
    expect(seen.at(-1)?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen.at(-1)?.auth).toBe("Bearer sk-the-real-secret");
    expect(seen.at(-1)?.method).toBe("POST");
  });

  it("forwards a multi-MiB egress body instead of 413ing (long LLM context)", async () => {
    const account = await h.deps.accountStore.createAccount("bigbody@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    // Past Fastify's 1MiB default bodyLimit but well under the egress route's
    // raised 256MiB cap — this is the payload shape that used to 413.
    const bigContent = "x".repeat(5 * 1024 * 1024);
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: bigContent }] },
    });
    expect(res.statusCode).toBe(200);
    expect(seen.at(-1)?.body?.length ?? 0).toBeGreaterThan(5 * 1024 * 1024);
  });

  it("returns and revokes a persisted grant when lifecycle audit writes fail", async () => {
    const account = await h.deps.accountStore.createAccount("audit-down@example.test", "A");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    h.deps.vaultAuditStore.record = async () => {
      throw new Error("synthetic audit outage");
    };

    const mint = await h.server.inject({
      method: "POST",
      url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI" },
    });
    expect(mint.statusCode).toBe(201);
    const body = mint.json() as { grant_id: string; token: string };
    expect(body.token).toMatch(/^sqr_egress_/);
    expect(await h.deps.egressGrantStore.getById(body.grant_id)).not.toBeNull();

    const revoke = await h.server.inject({
      method: "DELETE",
      url: `/v1/egress/grants/${body.grant_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await h.deps.egressGrantStore.getById(body.grant_id))?.revoked_at).not.toBeNull();
  });

  it("base_url advertises the forwarded (https) scheme so the Authorization header survives the edge", async () => {
    // Behind Fly, req.protocol is "http" (TLS terminates at the edge). Advertising
    // http:// makes a backend follow the http→https redirect, dropping the auth
    // header → a spurious 401 on the first call. base_url must carry x-forwarded-proto.
    const account = await h.deps.accountStore.createAccount("https@example.test", "H");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/egress/grants",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      payload: { service: "OpenAI" },
    });
    const j = res.json() as { base_url: string };
    expect(j.base_url.startsWith("https://")).toBe(true);
  });

  it("rejects a bad/missing egress token (401) and never calls upstream", async () => {
    const account = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id } = await mintGrantHttp(h, token, { service: "OpenAI" });

    const bad = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
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

    const del = await h.server.inject({
      method: "DELETE",
      url: `/v1/egress/grants/${grant_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("enforces the per-grant rate limit (429)", async () => {
    const account = await h.deps.accountStore.createAccount("rl@example.test", "RL");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, {
      service: "OpenAI",
      rate_limit_per_hour: 1,
    });

    const call = () =>
      h.server.inject({
        method: "POST",
        url: `/v1/egress/${grant_id}/v1/chat/completions`,
        headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
        payload: {},
      });
    expect((await call()).statusCode).toBe(200);
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(3600);
    expect(limited.json()).toMatchObject({
      error: "rate_limited",
      scope: "grant",
      limit_per_hour: 1,
      window_seconds: 3600,
    });
    expect((limited.json() as { reset_at: string }).reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("limits are opt-in: a grant minted without a rate is unlimited", async () => {
    const account = await h.deps.accountStore.createAccount("ul@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { service: "OpenAI" }, // no rate_limit_per_hour, no spend_cap_usd
    });
    const j = res.json() as {
      grant_id: string;
      token: string;
      rate_limit_per_hour: number | null;
      spend_cap_usd: number | null;
    };
    expect(j.rate_limit_per_hour).toBeNull();
    expect(j.spend_cap_usd).toBeNull(); // spend cap stays opt-in

    const call = () =>
      h.server.inject({
        method: "POST",
        url: `/v1/egress/${j.grant_id}/v1/chat/completions`,
        headers: { authorization: `Bearer ${j.token}`, "content-type": "application/json" },
        payload: {},
      });
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
    const backing = buildInMemoryDeps({ sessionSecret: SESSION_SECRET }).egressGrantStore;
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

  it("caches resolution while re-reading live authorization metadata per spend", async () => {
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
    expect(findActiveCalls).toBe(4);
  });

  it("refuses a cached credential after it is soft-deleted", async () => {
    const account = await h.deps.accountStore.createAccount("deleted-cache@example.test", "D");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });
    const call = () =>
      h.server.inject({
        method: "POST",
        url: `/v1/egress/${grant_id}/v1/chat/completions`,
        headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
        payload: {},
      });

    expect((await call()).statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    await h.deps.vault.delete(reference, account.id);
    const afterDelete = await call();
    expect(afterDelete.statusCode).toBe(404);
    expect(afterDelete.json()).toEqual({ error: "credential_not_found" });
    expect(seen).toHaveLength(1);
  });

  it("uses an allowed-host edit immediately after caching an empty allowlist", async () => {
    const account = await h.deps.accountStore.createAccount("allowlist-edit@example.test", "A");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });
    const call = () =>
      h.server.inject({
        method: "POST",
        url: `/v1/egress/${grant_id}/v1/chat/completions`,
        headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
        payload: {},
      });

    const current = (await h.deps.credentialStore.findActive(reference))!;
    await h.deps.credentialStore.updateMetadata(
      reference,
      {
        label: current.label,
        allowed_hosts: current.allowed_hosts,
        metadata: current.metadata,
      },
      { allowed_hosts: [] },
    );

    await h.server.close();
    h.server = await buildServer({ deps: h.deps, proxyExecutor: fakeExecutor() });
    expect((await call()).statusCode).toBe(404);

    const empty = (await h.deps.credentialStore.findActive(reference))!;
    await h.deps.credentialStore.updateMetadata(
      reference,
      {
        label: empty.label,
        allowed_hosts: empty.allowed_hosts,
        metadata: empty.metadata,
      },
      { allowed_hosts: ["api.changed.example"] },
    );

    expect((await call()).statusCode).toBe(200);
    expect(seen.at(-1)?.url).toBe("https://api.changed.example/v1/chat/completions");
  });

  it("maps a spend-time active-check outage to retryable 503", async () => {
    const account = await h.deps.accountStore.createAccount("active-check@example.test", "A");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });
    const call = () =>
      h.server.inject({
        method: "POST",
        url: `/v1/egress/${grant_id}/v1/chat/completions`,
        headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
        payload: {},
      });
    expect((await call()).statusCode).toBe(200);
    h.deps.credentialStore.findActive = async () => {
      throw Object.assign(new Error("connection closed"), { code: "P1017" });
    };

    const response = await call();
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toMatchObject({
      error: "egress_temporarily_unavailable",
      retryable: true,
      scope: "proxy",
    });
    expect(seen).toHaveLength(1);
  });

  it("coalesces concurrent cold cache misses while rechecking each spend", async () => {
    const account = await h.deps.accountStore.createAccount("stampede@example.test", "S");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const originalFindActive = h.deps.credentialStore.findActive.bind(h.deps.credentialStore);
    let findActiveCalls = 0;
    h.deps.credentialStore.findActive = async (reference: string) => {
      findActiveCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalFindActive(reference);
    };
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        h.server.inject({
          method: "POST",
          url: `/v1/egress/${grant_id}/v1/chat/completions`,
          headers: {
            authorization: `Bearer ${egressToken}`,
            "content-type": "application/json",
          },
          payload: {},
        }),
      ),
    );

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(findActiveCalls).toBe(5);
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
    expect(findActiveCalls).toBe(2);
  });

  it("injects the secret per the credential's stored auth_shape (header, not bearer)", async () => {
    const account = await h.deps.accountStore.createAccount("hdr@example.test", "H");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    // A non-bearer provider: the key rides in x-api-key, NOT Authorization.
    const store = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
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
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/messages`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { model: "claude", messages: [] },
    });
    expect(res.statusCode).toBe(200);
    const last = seen.at(-1)!;
    // Secret injected into x-api-key; Authorization NOT set to the secret.
    expect(last.headers["x-api-key"]).toBe("sk-the-real-secret");
    expect(last.auth).toBeUndefined();
  });

  it("honors a client-placed ${SECRET} and does NOT also stamp the stored shape", async () => {
    const account = await h.deps.accountStore.createAccount("place@example.test", "P");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    // Stored with the DEFAULT (bearer) shape. Without the client-placement path
    // the proxy would stamp `Authorization: Bearer <secret>`, which an xi-api-key
    // provider (ElevenLabs) rejects — the real bug this fixes.
    const store = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "elevenlabs",
        value: "sk-the-real-secret",
        type: "api_key",
        observed_hosts: ["api.elevenlabs.io"],
      },
    });
    expect(store.statusCode).toBe(201);

    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "elevenlabs" });
    // The app places the marker itself — it knows ElevenLabs wants xi-api-key.
    const res = await h.server.inject({
      method: "GET",
      url: `/v1/egress/${grant_id}/v2/voices?page_size=3`,
      headers: { authorization: `Bearer ${egressToken}`, "xi-api-key": "${SECRET}" },
    });
    expect(res.statusCode).toBe(200);
    const last = seen.at(-1)!;
    // Placement honored + substituted…
    expect(last.headers["xi-api-key"]).toBe("sk-the-real-secret");
    // …and the bearer-default shape was NOT stamped on top (no collision).
    expect(last.auth).toBeUndefined();
  });

  it("forwards a body containing literal ${SECRET} / ${SECRET.field} unchanged, with auth still injected", async () => {
    const account = await h.deps.accountStore.createAccount("body@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const store = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "OpenRouter",
        value: "sk-the-real-secret",
        type: "api_key",
        observed_hosts: ["openrouter.ai"],
      },
    });
    expect(store.statusCode).toBe(201);
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenRouter" });

    // A conversation whose content happens to quote Squire's own placeholder
    // syntax — this is opaque LLM payload, not the app describing where the
    // key goes.
    const payload = {
      model: "anthropic/claude",
      messages: [
        {
          role: "user",
          content: 'the docs say to use "${SECRET}" or "${SECRET.access_key}" for auth',
        },
      ],
    };
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/api/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const last = seen.at(-1)!;
    // Body reached upstream byte-for-byte — the placeholder text was never
    // scanned, resolved, or replaced with the real secret.
    expect(last.body).toBe(JSON.stringify(payload));
    // The grant's own auth (bearer-default here) was still injected — the
    // literal text in the body did not suppress auth_shape stamping.
    expect(last.auth).toBe("Bearer sk-the-real-secret");
  });

  it("an egress body placeholder never surfaces as a proxy_error in the audit ledger", async () => {
    const account = await h.deps.accountStore.createAccount("bodyaudit@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const store = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "OpenRouterAudit",
        value: "sk-the-real-secret",
        type: "api_key",
        observed_hosts: ["openrouter.ai"],
      },
    });
    const reference = (store.json() as { reference: string }).reference;
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenRouterAudit" });

    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/api/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { messages: [{ role: "user", content: "please use ${SECRET.field_that_does_not_exist}" }] },
    });
    expect(res.statusCode).toBe(200);
    const [audit] = await h.deps.vaultAuditStore.list(account.id, {
      type: "vault.proxy_executed",
      reference,
    });
    expect(audit?.payload).not.toHaveProperty("proxy_error");
  });

  it("injects Basic auth (key as username, blank password) — base64 server-side", async () => {
    const account = await h.deps.accountStore.createAccount("basic@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const store = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "StripeBasic",
        value: "sk-the-real-secret",
        type: "api_key",
        auth_shape: "basic",
        observed_hosts: ["api.stripe.com"],
      },
    });
    expect(store.statusCode).toBe(201);
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "StripeBasic" });
    const res = await h.server.inject({
      method: "GET",
      url: `/v1/egress/${grant_id}/v1/charges`,
      headers: { authorization: `Bearer ${egressToken}` },
    });
    expect(res.statusCode).toBe(200);
    // base64("sk-the-real-secret:") — encoded AFTER substitution, not the placeholder.
    expect(seen.at(-1)!.auth).toBe(
      `Basic ${Buffer.from("sk-the-real-secret:").toString("base64")}`,
    );
  });

  it("injects Basic auth with a fixed username (Mailgun api:<key>)", async () => {
    const account = await h.deps.accountStore.createAccount("basicu@example.test", "M");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const store = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        service: "Mailgun",
        value: "key-123",
        type: "api_key",
        auth_shape: "basic:api",
        observed_hosts: ["api.mailgun.net"],
      },
    });
    expect(store.statusCode).toBe(201);
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "Mailgun" });
    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v3/messages`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(seen.at(-1)!.auth).toBe(`Basic ${Buffer.from("api:key-123").toString("base64")}`);
  });

  it("rejects a request-signing auth_shape (SigV4) at store time (400)", async () => {
    const account = await h.deps.accountStore.createAccount("sig@example.test", "S");
    const cookie = await webCookie(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service: "AWS", value: "AKIAEXAMPLE", auth_shape: "sigv4" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid auth_shape at store time (400)", async () => {
    const account = await h.deps.accountStore.createAccount("bad@example.test", "B");
    const cookie = await webCookie(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
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
    const res = await h.server.inject({
      method: "GET",
      url: "/v1/egress/grants",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { grants: Array<Record<string, unknown>> };
    expect(body.grants).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  it("forwards the upstream content-type to the caller", async () => {
    await h.server.close();
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.9", family: 4 }),
      dispatch: async (input) => {
        seen.push({
          url: input.url.toString(),
          auth: input.headers.authorization,
          method: input.method,
          headers: { ...input.headers },
          body: input.body,
        });
        return {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-request-id": "up-1" },
          bodyStream: streamOf("data: hello\n\n"),
          truncated: false,
        };
      },
    });
    h.server = await buildServer({ deps: h.deps, proxyExecutor: executor });
    const account = await h.deps.accountStore.createAccount("sse-ct@example.test", "S");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: { stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["x-request-id"]).toBe("up-1");
    expect(res.body).toBe("data: hello\n\n");
  });

  it("does not forward upstream set-cookie", async () => {
    await h.server.close();
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.9", family: 4 }),
      dispatch: async () => ({
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "session=secret" },
        bodyStream: streamOf('{"ok":true}'),
        truncated: false,
      }),
    });
    h.server = await buildServer({ deps: h.deps, proxyExecutor: executor });
    const account = await h.deps.accountStore.createAccount("cookie@example.test", "C");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    const res = await h.server.inject({
      method: "POST",
      url: `/v1/egress/${grant_id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${egressToken}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body).toBe('{"ok":true}');
  });

  it("streams an upstream body to the caller incrementally", async () => {
    await h.server.close();
    const upstream = new PassThrough();
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.9", family: 4 }),
      dispatch: async () => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        truncated: false,
        bodyStream: upstream,
      }),
    });
    h.server = await buildServer({ deps: h.deps, proxyExecutor: executor });
    const account = await h.deps.accountStore.createAccount("sse-live@example.test", "S");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    await h.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.server.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const arrivals: Array<{ at: number; text: string }> = [];
    const started = Date.now();
    let sawHeaders: () => void = () => undefined;
    const headersReady = new Promise<void>((resolve) => {
      sawHeaders = resolve;
    });
    const finished = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/v1/egress/${grant_id}/v1/chat/completions`,
          headers: {
            authorization: `Bearer ${egressToken}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          expect(String(res.headers["content-type"])).toMatch(/text\/event-stream/);
          sawHeaders();
          res.on("data", (chunk: Buffer) => {
            arrivals.push({ at: Date.now() - started, text: chunk.toString("utf8") });
          });
          res.on("end", () => resolve());
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ stream: true }));
      req.end();
    });

    upstream.write("data: first\n\n");
    await headersReady;
    await new Promise((resolve) => setTimeout(resolve, 200));
    upstream.write("data: second\n\n");
    upstream.end();
    await finished;

    expect(arrivals.length).toBeGreaterThanOrEqual(1);
    expect(arrivals[0]!.text).toContain("data: first");
    expect(arrivals.at(-1)!.text).toContain("data: second");
    // Ordering is the property under test — the first event reached the client
    // on its own, before the second was written. An absolute latency bound on
    // arrival[0] would flake on a loaded runner; the GAP between them cannot.
    expect(arrivals.at(-1)!.at - arrivals[0]!.at).toBeGreaterThanOrEqual(150);

    // The audit row is written at dispatch (a crash mid-stream still leaves
    // one) and amended with the true byte count once the body ends.
    const expectedBytes = Buffer.byteLength("data: first\n\ndata: second\n\n", "utf8");
    const executed = await pollAudit(
      h.deps,
      account.id,
      (p) => p.grant_id === grant_id && p.response_size === expectedBytes,
    );
    expect(executed.response_size).toBe(expectedBytes);
    expect(executed.response_status).toBe(200);
    expect(executed.upstream_duration_ms).toBeGreaterThanOrEqual(150);
    expect(executed.proxy_error).toBeUndefined();
  });

  it("marks the audit row when the upstream body is cut short mid-stream", async () => {
    await h.server.close();
    const upstream = new PassThrough();
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.9", family: 4 }),
      dispatch: async () => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        truncated: false,
        bodyStream: upstream,
      }),
    });
    h.server = await buildServer({ deps: h.deps, proxyExecutor: executor });
    const account = await h.deps.accountStore.createAccount("sse-torn@example.test", "S");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    await h.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.server.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    let sawHeaders: () => void = () => undefined;
    const headersReady = new Promise<void>((resolve) => {
      sawHeaders = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/v1/egress/${grant_id}/v1/chat/completions`,
          headers: {
            authorization: `Bearer ${egressToken}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          sawHeaders();
          res.on("data", () => undefined);
          res.on("end", () => resolve());
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.write(JSON.stringify({ stream: true }));
      req.end();
    });

    upstream.write("data: first\n\n");
    await headersReady;
    // The generation dies half-way: the caller already holds a 200, so only the
    // ledger can say the transfer never finished.
    upstream.destroy(new Error("upstream connection reset"));
    await settled;

    const executed = await pollAudit(
      h.deps,
      account.id,
      (p) => p.grant_id === grant_id && p.proxy_error !== undefined,
    );
    expect(executed.response_status).toBe(200);
    expect(executed.proxy_error).toContain("upstream connection reset");
    expect(executed.client_closed).toBeUndefined();
    expect(executed.response_size).toBe(Buffer.byteLength("data: first\n\n", "utf8"));
  });

  it("records a caller's own cancel as a client close, not a proxy failure", async () => {
    await h.server.close();
    const upstream = new PassThrough();
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.9", family: 4 }),
      dispatch: async () => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        truncated: false,
        bodyStream: upstream,
      }),
    });
    h.server = await buildServer({ deps: h.deps, proxyExecutor: executor });
    const account = await h.deps.accountStore.createAccount("sse-cancel@example.test", "S");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");
    const { grant_id, egressToken } = await mintGrantHttp(h, token, { service: "OpenAI" });

    await h.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.server.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    // An SDK aborting a generation part-way: the caller hangs up while the
    // upstream is still perfectly healthy.
    const aborted = new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/v1/egress/${grant_id}/v1/chat/completions`,
          headers: {
            authorization: `Bearer ${egressToken}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => resolve());
      req.write(JSON.stringify({ stream: true }));
      req.end();
    });

    upstream.write("data: first\n\n");
    await aborted;

    const executed = await pollAudit(
      h.deps,
      account.id,
      (p) => p.grant_id === grant_id && p.client_closed === true,
    );
    expect(executed.response_status).toBe(200);
    expect(executed.proxy_error).toBeUndefined();
    expect(upstream.destroyed).toBe(true);
  });
});
