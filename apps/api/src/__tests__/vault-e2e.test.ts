// End-to-end vault flows the product depends on.
//
// E2E #1 — "install → signup → vault" data path:
//   The bot, after a successful signup, POSTs the captured credential
//   to /v1/vault/credentials with its account-bound agent_session_token.
//   The user then reads /v1/vault/credentials from the web app with
//   their web session cookie and sees the credential. Both directions
//   of the read (agent + web) must work — the agent reads to dedupe a
//   future signup; the human reads to see / reveal the key.
//
// E2E #2 — vault persistence across web sessions:
//   The user signs out (web session destroyed), signs back in (new
//   web session), and the vault still contains the previously captured
//   credentials. This is the "is the vault actually persistent or did
//   it just hide" test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
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
  const deps = buildInMemoryDeps({
    sessionSecret: SESSION_SECRET,
    customerId: CUSTOMER_ID,
  });
  const server = await buildServer({ deps });
  return { server, deps };
}

// Mint a web session for `accountId` and return the cookie string the
// fastify.inject() call needs to send, plus the jti (for revocation
// in the sign-out test).
async function makeWebSession(
  deps: ApiDeps,
  accountId: string,
): Promise<{ cookie: string; jti: string }> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now: new Date(),
  });
  const token = signSessionJwt(jwt, SESSION_SECRET);
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  await deps.sessionStore.insert(record);
  return { cookie, jti: record.jwt_id };
}

// Mint an agent-session bearer token for `accountId` and return the raw
// value to put in an Authorization header.
async function makeAgentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "e2e-test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

describe("E2E #1 — install → signup → vault data path", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("bot writes a Resend key via agent auth; web AND agent reads both surface it", async () => {
    // Set up: an account exists (the install handshake's /claim step
    // creates it; we shortcut that by creating it directly).
    const account = await h.deps.accountStore.createAccount(
      "user@example.test",
      "Test User",
    );
    const agentToken = await makeAgentToken(h.deps, account.id);
    const { cookie: webCookie } = await makeWebSession(h.deps, account.id);

    // ── The bot stores the key it captured during signup ───────
    // This mirrors what apps/mcp/src/tools/provision-any.ts does on a
    // successful Resend signup — POST /v1/vault/credentials with the
    // bot's agent_session_token, the captured value, and the env-var
    // suggestion the LLM should surface.
    const captured = "re_FAKE_TEST_KEY_BUT_VALID_SHAPE_xxxxx";
    const storeRes = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      payload: {
        service: "Resend",
        value: captured,
        env_var_suggestion: "RESEND_API_KEY",
        type: "api_key",
      },
    });
    expect(storeRes.statusCode).toBe(201);
    const stored = storeRes.json() as { reference: string; field_names: string[] };
    expect(stored.reference).toMatch(/^vault:\/\//);
    expect(stored.field_names).toEqual(["value"]);

    // ── The web user reads their vault and sees the new key ────
    const webList = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie: webCookie },
    });
    expect(webList.statusCode).toBe(200);
    const webBody = webList.json() as { credentials: Array<Record<string, unknown>> };
    expect(webBody.credentials).toHaveLength(1);
    expect(webBody.credentials[0]).toMatchObject({
      service: "Resend",
      key_name: "RESEND_API_KEY",
      type: "api_key",
      reference: stored.reference,
    });

    // ── The agent reads its own vault and also sees the new key ─
    // This is the "agent dedupes a future signup by listing what's
    // already there" path — list_credentials in the MCP server.
    const agentList = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentList.statusCode).toBe(200);
    const agentBody = agentList.json() as { credentials: Array<Record<string, unknown>> };
    expect(agentBody.credentials).toHaveLength(1);
    expect(agentBody.credentials[0]).toMatchObject({
      service: "Resend",
      reference: stored.reference,
    });

    // ── The web user reveals the secret and gets the real value ─
    // The reveal route is web-only (requireWeb) and audits the read.
    const reveal = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${encodeURIComponent(stored.reference.split("/").pop() ?? "")}/reveal`,
      headers: { cookie: webCookie },
    });
    // The reveal path is keyed on the credential's `id`, not its
    // reference — look the id up from the list response.
    const credId = webBody.credentials[0]?.id as string;
    const reveal2 = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${encodeURIComponent(credId)}/reveal`,
      headers: { cookie: webCookie },
    });
    expect(reveal2.statusCode).toBe(200);
    const revealed = reveal2.json() as { value: string };
    expect(revealed.value).toBe(captured);

    // Make TS happy about the unused first attempt — left in so the
    // log shows the id-vs-reference distinction load-bearing here.
    void reveal;
  });

  it("a different account's web session sees an empty vault", async () => {
    // Tenant isolation: the bot from account A cannot leak into
    // account B's vault view.
    const accountA = await h.deps.accountStore.createAccount("a@example.test", "A");
    const accountB = await h.deps.accountStore.createAccount("b@example.test", "B");
    const tokenA = await makeAgentToken(h.deps, accountA.id);
    const { cookie: cookieB } = await makeWebSession(h.deps, accountB.id);

    await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
      },
      payload: { service: "Resend", value: "re_account_A_secret", type: "api_key" },
    });

    const listB = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie: cookieB },
    });
    expect(listB.statusCode).toBe(200);
    const bodyB = listB.json() as { credentials: unknown[] };
    expect(bodyB.credentials).toHaveLength(0);
  });
});

describe("E2E #2 — vault persistence across web sessions", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("credentials persist after sign-out and sign-back-in", async () => {
    const account = await h.deps.accountStore.createAccount("user@example.test", "Test");
    const agentToken = await makeAgentToken(h.deps, account.id);

    // First session: store a credential.
    const { cookie: firstCookie, jti: firstJti } = await makeWebSession(
      h.deps,
      account.id,
    );
    await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      payload: { service: "Resend", value: "re_pre_signout_value", type: "api_key" },
    });

    const firstList = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie: firstCookie },
    });
    expect(firstList.statusCode).toBe(200);
    expect((firstList.json() as { credentials: unknown[] }).credentials).toHaveLength(1);

    // Sign out: revoke the first session by its jti — modelling the
    // user clicking "sign out." After this, the first cookie is dead.
    await h.deps.sessionStore.revoke(firstJti, "user_signout");

    // Stale cookie now fails.
    const staleList = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie: firstCookie },
    });
    expect(staleList.statusCode).toBe(401);

    // Sign back in: a fresh web session for the same account.
    const { cookie: secondCookie } = await makeWebSession(h.deps, account.id);

    // The vault still has the credential — persistence verified.
    const secondList = await h.server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { cookie: secondCookie },
    });
    expect(secondList.statusCode).toBe(200);
    const body = secondList.json() as { credentials: Array<Record<string, unknown>> };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).toMatchObject({
      service: "Resend",
      type: "api_key",
    });

    // And the reveal still works post-resignin — proves the encrypted
    // blob + KEK survived, not just the metadata row.
    const credId = body.credentials[0]?.id as string;
    const reveal = await h.server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${encodeURIComponent(credId)}/reveal`,
      headers: { cookie: secondCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect((reveal.json() as { value: string }).value).toBe("re_pre_signout_value");
  });
});
