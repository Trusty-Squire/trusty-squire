// Resend inbound webhook — signature + dispatch tests. The route MUST
// fail-closed when RESEND_WEBHOOK_SECRET is unset (503) or when the
// Svix signature is forged / replayed (401). Valid payloads land at
// the forwarder (alias match) or the ResendHandler (bot inbox).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { buildInMemoryDeps } from "../services/deps.js";

const SECRET_RAW_B64 = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const WHSEC = `whsec_${SECRET_RAW_B64}`;

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const keyBytes = Buffer.from(SECRET_RAW_B64, "base64");
  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const mac = createHmac("sha256", keyBytes).update(signed).digest("base64");
  return `v1,${mac}`;
}

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import("fastify")).default;
  const { registerResendWebhookRoute } = await import("../routes/resend-webhook.js");
  const deps = buildInMemoryDeps({
    sessionSecret: "test",
    customerId: "ts-test",
  });
  const app = Fastify({ logger: false });
  await app.register(registerResendWebhookRoute, {
    deps: {
      resendHandler: deps.resendHandler,
      nowSeconds: () => 1779800000,
    },
  });
  return app;
}

describe("/v1/webhooks/resend-inbound", () => {
  const origSecret = process.env.RESEND_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = WHSEC;
  });
  afterEach(() => {
    if (origSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = origSecret;
  });

  it("fails closed (503) when RESEND_WEBHOOK_SECRET is unset", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend-inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_x",
        "svix-timestamp": "1779800000",
        "svix-signature": "v1,abc",
      },
      payload: { type: "email.received", data: {} },
    });
    expect(res.statusCode).toBe(503);
  });

  it("rejects (401) a forged signature", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend-inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_x",
        "svix-timestamp": "1779800000",
        "svix-signature": "v1,Zm9yZ2VkLXNpZ25hdHVyZQ==",
      },
      payload: { type: "email.received", data: { from: "x@y.com" } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_svix_signature");
  });

  it("rejects (401) a replay-window-stale timestamp", async () => {
    const app = await buildApp();
    const rawBody = JSON.stringify({ type: "email.received", data: {} });
    const staleTs = String(1779800000 - 10 * 60); // 10 min ago
    const sig = signSvix(rawBody, "msg_stale", staleTs);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend-inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_stale",
        "svix-timestamp": staleTs,
        "svix-signature": sig,
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toBe("timestamp_outside_replay_window");
  });

  it("acks (200) and ignores non-inbound events without dispatch", async () => {
    const app = await buildApp();
    const rawBody = JSON.stringify({ type: "email.delivered", data: { id: "msg_x" } });
    const ts = "1779800000";
    const sig = signSvix(rawBody, "msg_x", ts);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend-inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_x",
        "svix-timestamp": ts,
        "svix-signature": sig,
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored_event).toBe("email.delivered");
  });

  it("hands a bot-alias-bound inbound to the ResendHandler", async () => {
    const app = await buildApp();
    const data = {
      message_id: "<test-msg-1@example.com>",
      from: "noreply@service.com",
      to: ["abc.testsvc.run-1@trustysquire.com"],
      subject: "Verify your email",
      text: "Click https://service.com/verify?token=abc to verify. Code: 482915",
    };
    const rawBody = JSON.stringify({ type: "email.received", data });
    const ts = "1779800000";
    const sig = signSvix(rawBody, "msg_inb_1", ts);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend-inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_inb_1",
        "svix-timestamp": ts,
        "svix-signature": sig,
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    // No alias was registered → ResendHandler returns no_alias_match.
    expect(res.json().kind).toBe("no_alias_match");
  });

  it("rejects an invalid inbound payload shape with 400", async () => {
    const app = await buildApp();
    const rawBody = JSON.stringify({ type: "email.received", data: { from: "x@y.com" } }); // missing message_id / to / subject
    const ts = "1779800000";
    const sig = signSvix(rawBody, "msg_bad", ts);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend-inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_bad",
        "svix-timestamp": ts,
        "svix-signature": sig,
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_inbound_payload");
  });
});
