// Telegram account linking + webhook — mirrors pay-approvals.test.ts's
// harness (buildInMemoryDeps + buildServer + server.inject).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "synthetic-telegram-test-secret";
const WEBHOOK_SECRET = "synthetic-webhook-secret";

async function makeWebSession(deps: ApiDeps, accountId: string, now: Date): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now,
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

describe("telegram linking + webhook", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let nowMs: number;
  let accountId: string;
  let webCookie: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    nowMs = Date.parse("2026-07-23T12:00:00.000Z");
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "trusty_squire_bot");
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date(nowMs),
    });
    server = await buildServer({ deps });
    const account = await deps.accountStore.createAccount("linker@example.test", "Linker");
    accountId = account.id;
    webCookie = await makeWebSession(deps, accountId, new Date(nowMs));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await server.close();
  });

  async function mintLinkToken(): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/telegram/link",
      headers: { cookie: webCookie },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { url: string };
    expect(body.url).toMatch(
      /^https:\/\/t\.me\/trusty_squire_bot\?start=[a-f0-9]{32}$/,
    );
    return body.url.split("start=")[1]!;
  }

  it("connects the account on a valid /start webhook and confirms via Telegram", async () => {
    const token = await mintLinkToken();

    const response = await server.inject({
      method: "POST",
      url: "/v1/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      payload: {
        message: { text: `/start ${token}`, chat: { id: 987654321 } },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const account = await deps.accountStore.findAccountById(accountId);
    expect(account?.telegram_chat_id).toBe("987654321");

    // Confirmation push to the newly-linked chat.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botsynthetic-bot-token/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("987654321");
  });

  it("rejects a webhook call with the wrong secret header", async () => {
    const token = await mintLinkToken();
    const response = await server.inject({
      method: "POST",
      url: "/v1/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      payload: { message: { text: `/start ${token}`, chat: { id: 1 } } },
    });
    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const account = await deps.accountStore.findAccountById(accountId);
    expect(account?.telegram_chat_id).toBeNull();
  });

  it("200s on an unknown token without linking or sending", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      payload: { message: { text: "/start not-a-real-token", chat: { id: 1 } } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200s on an expired token without linking or sending", async () => {
    const token = await mintLinkToken();
    nowMs += 15 * 60 * 1000 + 1;

    const response = await server.inject({
      method: "POST",
      url: "/v1/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      payload: { message: { text: `/start ${token}`, chat: { id: 1 } } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();

    const account = await deps.accountStore.findAccountById(accountId);
    expect(account?.telegram_chat_id).toBeNull();
  });

  it("reports disconnected before linking and connected after", async () => {
    const before = await server.inject({
      method: "GET",
      url: "/v1/telegram/status",
      headers: { cookie: webCookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ connected: false });

    const token = await mintLinkToken();
    await server.inject({
      method: "POST",
      url: "/v1/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      payload: { message: { text: `/start ${token}`, chat: { id: 42 } } },
    });

    const after = await server.inject({
      method: "GET",
      url: "/v1/telegram/status",
      headers: { cookie: webCookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ connected: true });
  });
});
