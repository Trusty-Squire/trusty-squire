// Coverage for POST /v1/notify/heightened-auth — the bot fires this
// when Google throws a number-match challenge mid-OAuth. The API
// resolves the machine token to a paired account and emails the
// digit to the account's OAuth-registered address.
//
// Focus areas:
//   - Auth: 401 without token, 401 with unknown token
//   - Anonymous tier: 412 when token isn't paired (no email to send)
//   - Happy path: 200 + emailForwarder.sendDirect called with the
//     account.email and a body containing the digit
//   - Dedupe: second identical send within 5min returns deduped:true
//   - Body shape: subject mentions service + digit; "unreadable"
//     branch (digit=null) sends a different subject

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { EmailForwarder } from "../services/email-forwarder.js";
import { _resetNotifyDedupeForTests } from "../routes/notify.js";

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
  });

  async function issueToken(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/install" });
    return (res.json() as { machine_token: string }).machine_token;
  }

  async function issueAndPairToken(email: string): Promise<string> {
    const token = await issueToken();
    const account = await deps.accountStore.createAccount(email, "test user");
    await deps.machineTokenStore.markPaired(token, account.id);
    return token;
  }

  async function post(token: string | null, body: unknown) {
    return app.inject({
      method: "POST",
      url: "/v1/notify/heightened-auth",
      headers: {
        "content-type": "application/json",
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: JSON.stringify(body),
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

  it("returns 412 when the machine token isn't paired to an account", async () => {
    const token = await issueToken();
    const res = await post(token, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ error: "not_paired" });
    expect(forwarder.calls).toHaveLength(0);
  });

  it("sends to the account's email on a valid digit", async () => {
    const token = await issueAndPairToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sent: true });
    expect(forwarder.calls).toHaveLength(1);
    const call = forwarder.calls[0]!;
    expect(call.to).toBe("user@example.com");
    expect(call.subject).toContain("8");
    expect(call.subject).toContain("IPInfo");
    expect(call.text ?? "").toContain("Tap: 8");
  });

  it("uses a different subject when digit is null (unreadable)", async () => {
    const token = await issueAndPairToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: null });
    expect(res.statusCode).toBe(200);
    expect(forwarder.calls).toHaveLength(1);
    const call = forwarder.calls[0]!;
    expect(call.subject).toContain("unreadable");
    expect(call.subject).toContain("IPInfo");
  });

  it("dedupes identical sends within the 5-min window", async () => {
    const token = await issueAndPairToken("user@example.com");
    const first = await post(token, { service: "IPInfo", digit: "8" });
    const second = await post(token, { service: "IPInfo", digit: "8" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ sent: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ sent: false, deduped: true });
    expect(forwarder.calls).toHaveLength(1);
  });

  it("does NOT dedupe when service or digit differs", async () => {
    const token = await issueAndPairToken("user@example.com");
    await post(token, { service: "IPInfo", digit: "8" });
    await post(token, { service: "IPInfo", digit: "42" });
    await post(token, { service: "Postmark", digit: "8" });
    expect(forwarder.calls).toHaveLength(3);
  });

  it("rejects missing service", async () => {
    const token = await issueAndPairToken("user@example.com");
    const res = await post(token, { digit: "8" });
    expect(res.statusCode).toBe(400);
    expect(forwarder.calls).toHaveLength(0);
  });

  it("returns 503 when SMTP send fails", async () => {
    const failing = new FailingEmailForwarder([]);
    await app.close();
    app = await buildServer({ deps, emailForwarder: failing });
    const token = await issueAndPairToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: "8" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ sent: false });
  });

  it("treats non-numeric digit as unreadable rather than rejecting", async () => {
    const token = await issueAndPairToken("user@example.com");
    const res = await post(token, { service: "IPInfo", digit: "abc" });
    expect(res.statusCode).toBe(200);
    expect(forwarder.calls[0]?.subject).toContain("unreadable");
  });
});
