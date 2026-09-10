import { issueAgentSession, hashToken } from "../auth/agent.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { EmailForwarder } from "../services/email-forwarder.js";
import { _notifyInFlightJoinsForTests, _resetNotifyDedupeForTests } from "../routes/notify.js";

type SendDirectCall = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

class StubEmailForwarder extends EmailForwarder {
  public calls: SendDirectCall[] = [];
  public override async sendDirect(params: SendDirectCall) {
    this.calls.push(params);
    return { success: true };
  }
}

class FailingEmailForwarder extends EmailForwarder {
  public override async sendDirect() {
    return { success: false as const, error: "smtp_error" };
  }
}

class DeferredEmailForwarder extends StubEmailForwarder {
  release: (() => void) | null = null;
  public override async sendDirect(params: SendDirectCall) {
    this.calls.push(params);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return { success: true };
  }
}

describe("POST /v1/notify/heightened-auth", () => {
  let app: FastifyInstance;
  let forwarder: StubEmailForwarder;
  let deps: ReturnType<typeof buildInMemoryDeps>;

  beforeEach(async () => {
    _resetNotifyDedupeForTests();
    forwarder = new StubEmailForwarder([]);
    deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
    });
    app = await buildServer({ deps, emailForwarder: forwarder });
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  async function issueToken(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/install" });
    return (res.json() as { machine_token: string }).machine_token;
  }

  async function issueAccountToken(email: string): Promise<string> {
    const account = await deps.accountStore.createAccount(email, "test user");
    const issued = issueAgentSession({
      account_id: account.id,
      agent_identity: "operator",
      agent_version: "test",
      now: new Date(),
    });
    await deps.agentSessionStore.insert(issued.record);
    return issued.raw_token;
  }

  async function post(token: string | null, body: unknown) {
    const payload =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? {
            attempt_id: "attempt-1",
            challenge_revision: "revision-1",
            observed_at: "2026-09-10T12:00:00.000Z",
            window_seconds: 120,
            ...body,
          }
        : body;
    return app.inject({
      method: "POST",
      url: "/v1/notify/heightened-auth",
      headers: {
        "content-type": "application/json",
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: JSON.stringify(payload),
    });
  }

  it("rejects requests without a machine token", async () => {
    const res = await post(null, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(401);
    expect(forwarder.calls).toHaveLength(0);
  });

  it("rejects unknown machine tokens", async () => {
    const res = await post("tsm_nonexistent", { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects legacy machine tokens without dispatching notifications", async () => {
    const token = await issueToken();
    const res = await post(token, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "agent_session_required" });
    expect(forwarder.calls).toHaveLength(0);
  });

  it("rejects revoked agent sessions and ignores caller account overrides", async () => {
    const token = await issueAccountToken("owner@example.com");
    const record = await deps.agentSessionStore.findActiveByHash(hashToken(token), new Date());
    const sent = await post(token, { service: "Example", digit: "8", account_id: "foreign" });
    expect(sent.statusCode).toBe(200);
    expect(forwarder.calls[0]?.to).toBe("owner@example.com");
    await deps.agentSessionStore.revoke(record!.id, "test");
    expect((await post(token, { service: "Example", digit: "8" })).statusCode).toBe(401);
    expect(forwarder.calls).toHaveLength(1);
  });

  it("sends to the account's email on a valid digit", async () => {
    const token = await issueAccountToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sent: true });
    expect(forwarder.calls).toHaveLength(1);
    const call = forwarder.calls[0]!;
    expect(call.to).toBe("user@example.com");
    expect(call.subject).toContain("8");
    expect(call.subject).toContain("IPInfo");
    expect(call.text ?? "").toContain("Tap: 8");
    expect(call.text ?? "").toContain("Attempt: attempt-1 / revision-1");
  });

  it("uses a different subject when digit is null (unreadable)", async () => {
    const token = await issueAccountToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: null });
    expect(res.statusCode).toBe(200);
    expect(forwarder.calls).toHaveLength(1);
    const call = forwarder.calls[0]!;
    expect(call.subject).toContain("unreadable");
    expect(call.subject).toContain("IPInfo");
  });

  it("dedupes the same attempt and challenge revision within the 5-min window", async () => {
    const token = await issueAccountToken("user@example.com");
    const first = await post(token, { service: "IPInfo", digit: "8" });
    const second = await post(token, { service: "IPInfo", digit: "8" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ sent: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ sent: false, deduped: true });
    expect(forwarder.calls).toHaveLength(1);
  });

  it("notifies again for a new revision or attempt even when the number is unchanged", async () => {
    const token = await issueAccountToken("user@example.com");
    await post(token, { service: "IPInfo", digit: "8" });
    await post(token, { service: "IPInfo", digit: "8", challenge_revision: "revision-2" });
    await post(token, { service: "IPInfo", digit: "8", attempt_id: "attempt-2" });
    expect(forwarder.calls).toHaveLength(3);
  });

  it("shares one in-flight delivery across concurrent retries", async () => {
    const deferred = new DeferredEmailForwarder([]);
    await app.close();
    app = await buildServer({ deps, emailForwarder: deferred });
    const token = await issueAccountToken("user@example.com");
    const first = post(token, { service: "IPInfo", digit: "8" });
    await vi.waitFor(() => expect(deferred.calls).toHaveLength(1));
    const second = post(token, { service: "IPInfo", digit: "8" });
    await vi.waitFor(() => expect(_notifyInFlightJoinsForTests()).toBe(1));
    expect(deferred.calls).toHaveLength(1);
    deferred.release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.json()).toMatchObject({ sent: true, deduped: false });
    expect(secondResult.json()).toMatchObject({ sent: true, deduped: true });
  });

  it("prefers the paired Telegram channel and does not also email", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const telegramFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const token = await issueAccountToken("user@example.com");
    const tokenRow = await deps.agentSessionStore.findActiveByHash(hashToken(token), new Date());
    await deps.accountStore.setTelegramChatId(tokenRow!.account_id, "chat-42");

    const res = await post(token, { service: "IPInfo", digit: "8" });

    expect(res.json()).toMatchObject({
      sent: true,
      delivery: { channel: "telegram", status: "sent" },
    });
    expect(telegramFetch).toHaveBeenCalledOnce();
    expect(forwarder.calls).toHaveLength(0);
  });

  it("falls back to email when paired Telegram delivery fails", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    const token = await issueAccountToken("user@example.com");
    const tokenRow = await deps.agentSessionStore.findActiveByHash(hashToken(token), new Date());
    await deps.accountStore.setTelegramChatId(tokenRow!.account_id, "chat-42");

    const res = await post(token, { service: "IPInfo", digit: "8" });

    expect(res.json()).toMatchObject({
      sent: true,
      delivery: { channel: "email", status: "sent" },
    });
    expect(forwarder.calls).toHaveLength(1);
  });

  it("rejects missing service", async () => {
    const token = await issueAccountToken("user@example.com");
    const res = await post(token, { digit: "8" });
    expect(res.statusCode).toBe(400);
    expect(forwarder.calls).toHaveLength(0);
  });

  it("rejects missing or unbounded challenge identity", async () => {
    const token = await issueAccountToken("user@example.com");
    const res = await post(token, {
      service: "IPInfo",
      digit: "8",
      attempt_id: "",
      challenge_revision: "x".repeat(161),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_challenge_identity" });
    expect(forwarder.calls).toHaveLength(0);
  });

  it("returns 503 when SMTP send fails", async () => {
    const failing = new FailingEmailForwarder([]);
    await app.close();
    app = await buildServer({ deps, emailForwarder: failing });
    const token = await issueAccountToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ sent: false });
  });

  it("treats non-numeric digit as unreadable rather than rejecting", async () => {
    const token = await issueAccountToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: "abc" });
    expect(res.statusCode).toBe(200);
    expect(forwarder.calls[0]?.subject).toContain("unreadable");
  });
});
