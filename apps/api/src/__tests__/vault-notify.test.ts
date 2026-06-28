// Bot-store notification — when the universal bot stores a NEW credential
// (agent path), the account owner gets a "new key added" email. Rotations
// (re-stores) and manual web pastes do NOT notify, and a failing mailer
// never breaks the store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface SentMail { to: string; subject: string; text: string; }

function stubForwarder(sent: SentMail[], fail = false): EmailForwarder {
  return {
    async sendDirect(p: { to: string; subject: string; text: string }) {
      if (fail) throw new Error("mailer down");
      sent.push(p);
      return { success: true };
    },
  } as unknown as EmailForwarder;
}

interface Harness { server: FastifyInstance; deps: ApiDeps; sent: SentMail[]; }

async function setup(opts: { failMailer?: boolean } = {}): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
  const sent: SentMail[] = [];
  const server = await buildServer({ deps, emailForwarder: stubForwarder(sent, opts.failMailer) });
  return { server, deps, sent };
}

async function agentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({ account_id: accountId, agent_identity: "claude-code", agent_version: "test", now: new Date() });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

function agentStore(server: FastifyInstance, token: string, value: string) {
  return server.inject({
    method: "POST",
    url: "/v1/vault/credentials",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { service: "OpenAI", value },
  });
}

describe("bot-store notification", () => {
  let h: Harness;
  afterEach(async () => { await h.server.close(); });

  it("emails the owner when the bot stores a NEW credential", async () => {
    h = await setup();
    const account = await h.deps.accountStore.createAccount("owner@example.test", "Owner");
    const token = await agentToken(h.deps, account.id);
    const res = await agentStore(h.server, token, "sk-new");
    expect(res.statusCode).toBe(201);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe("owner@example.test");
    expect(h.sent[0]!.subject).toContain("OpenAI");
    expect(h.sent[0]!.text).not.toContain("sk-new");
  });

  it("does NOT email on a re-store (rotation)", async () => {
    h = await setup();
    const account = await h.deps.accountStore.createAccount("owner@example.test", "Owner");
    const token = await agentToken(h.deps, account.id);
    await agentStore(h.server, token, "sk-old"); // create → 1 email
    await agentStore(h.server, token, "sk-new"); // rotate → no email
    expect(h.sent).toHaveLength(1);
  });

  it("does NOT email on a manual web paste", async () => {
    h = await setup();
    const account = await h.deps.accountStore.createAccount("owner@example.test", "Owner");
    const cookie = await webCookie(h.deps, account.id);
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/credentials/manual",
      headers: { cookie, "content-type": "application/json" },
      payload: { service: "OpenAI", value: "sk-x" },
    });
    expect(res.statusCode).toBe(201);
    expect(h.sent).toHaveLength(0);
  });

  it("a failing mailer does not break the store", async () => {
    h = await setup({ failMailer: true });
    const account = await h.deps.accountStore.createAccount("owner@example.test", "Owner");
    const token = await agentToken(h.deps, account.id);
    const res = await agentStore(h.server, token, "sk-new");
    expect(res.statusCode).toBe(201); // store still succeeds
  });
});
