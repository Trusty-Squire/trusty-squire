// Rotation-age surfacing on GET /v1/vault/credentials — the list exposes
// age_days + a `stale` flag (vs VAULT_ROTATION_STALE_DAYS, default 90) so
// the web can nudge a rotation. We drive the clock via the injectable
// deps.now (issuing the session on the same clock so it stays valid).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness { server: FastifyInstance; deps: ApiDeps; }

async function setup(now?: () => Date): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, ...(now ? { now } : {}) });
  const server = await buildServer({ deps });
  return { server, deps };
}

async function makeWebSession(deps: ApiDeps, accountId: string, now: Date): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

interface ListedCred { id: string; service: string; age_days: number; stale: boolean; last_changed_at: string; rotated_at: string | null; }

async function firstCred(server: FastifyInstance, cookie: string): Promise<ListedCred> {
  const list = await server.inject({ method: "GET", url: "/v1/vault/credentials", headers: { cookie } });
  return (list.json() as { credentials: ListedCred[] }).credentials[0]!;
}

async function createCred(server: FastifyInstance, cookie: string): Promise<void> {
  const res = await server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: { service: "OpenAI", value: "sk-x" },
  });
  expect(res.statusCode).toBe(201);
}

describe("rotation-age surfacing", () => {
  let h: Harness;
  afterEach(async () => { await h.server.close(); });

  it("a freshly stored credential is not stale (age_days 0)", async () => {
    h = await setup();
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id, new Date());
    await createCred(h.server, cookie);
    const cred = await firstCred(h.server, cookie);
    expect(cred.age_days).toBe(0);
    expect(cred.stale).toBe(false);
    expect(cred.rotated_at).toBeNull();
    expect(typeof cred.last_changed_at).toBe("string");
  });

  it("a credential older than the stale threshold reports stale", async () => {
    // Clock 200 days ahead of the credential's creation; session issued on
    // the same future clock so it stays valid.
    const future = new Date(Date.now() + 200 * DAY_MS);
    h = await setup(() => future);
    const account = await h.deps.accountStore.createAccount("u@example.test", "U");
    const cookie = await makeWebSession(h.deps, account.id, future);
    await createCred(h.server, cookie);
    const cred = await firstCred(h.server, cookie);
    expect(cred.age_days).toBeGreaterThanOrEqual(90);
    expect(cred.stale).toBe(true);
  });
});
