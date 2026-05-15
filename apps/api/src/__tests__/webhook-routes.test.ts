// Integration tests for inbound-mail webhook signature enforcement.
//
// Each webhook is exercised with a forged request (must be rejected) and
// a genuine signed request (must be accepted). A forged email otherwise
// lets an attacker inject a verification code/link the signup bot reads.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { buildSnsStringToSign } from "../auth/webhook-signatures.js";

const CUSTOMER_ID = "ts-test";

function makeDeps() {
  return buildInMemoryDeps({
    sessionSecret: "test-secret-not-used",
    customerId: CUSTOMER_ID,
  });
}

// ── Mailgun ──────────────────────────────────────────────────

describe("/v1/webhooks/mailgun signature enforcement", () => {
  let app: FastifyInstance;
  const signingKey = "mailgun-key-under-test";
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env["MAILGUN_WEBHOOK_SIGNING_KEY"];
    process.env["MAILGUN_WEBHOOK_SIGNING_KEY"] = signingKey;
    app = await buildServer({ deps: makeDeps() });
  });

  afterEach(async () => {
    await app.close();
    if (savedKey === undefined) delete process.env["MAILGUN_WEBHOOK_SIGNING_KEY"];
    else process.env["MAILGUN_WEBHOOK_SIGNING_KEY"] = savedKey;
  });

  function basePayload() {
    return {
      sender: "verify@service.test",
      recipient: "inbox-bot@test.local",
      subject: "Your code is 123456",
      "message-id": "mg-1",
      "stripped-text": "code 123456",
    };
  }

  it("rejects a forged payload (bad signature) with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mailgun",
      headers: { "content-type": "application/json" },
      payload: { ...basePayload(), timestamp: "1700000000", token: "tok", signature: "forged" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("accepts a genuinely signed payload", async () => {
    const timestamp = "1700000000";
    const token = "tok-genuine";
    const signature = createHmac("sha256", signingKey)
      .update(timestamp + token)
      .digest("hex");
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/mailgun",
      headers: { "content-type": "application/json" },
      payload: { ...basePayload(), timestamp, token, signature },
    });
    // No alias registered → handler returns no_alias_match, but the
    // request was authenticated and ingested (200, not 401).
    expect(res.statusCode).toBe(200);
  });

  it("fails closed (503) when the signing key is unset", async () => {
    delete process.env["MAILGUN_WEBHOOK_SIGNING_KEY"];
    const blindApp = await buildServer({ deps: makeDeps() });
    const res = await blindApp.inject({
      method: "POST",
      url: "/v1/webhooks/mailgun",
      headers: { "content-type": "application/json" },
      payload: { ...basePayload(), timestamp: "1", token: "t", signature: "s" },
    });
    expect(res.statusCode).toBe(503);
    await blindApp.close();
  });
});

// ── Resend (Svix) ────────────────────────────────────────────

describe("/v1/webhooks/resend signature enforcement", () => {
  let app: FastifyInstance;
  const secret = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`;
  let savedSecret: string | undefined;

  beforeEach(async () => {
    savedSecret = process.env["RESEND_WEBHOOK_SECRET"];
    process.env["RESEND_WEBHOOK_SECRET"] = secret;
    app = await buildServer({ deps: makeDeps() });
  });

  afterEach(async () => {
    await app.close();
    if (savedSecret === undefined) delete process.env["RESEND_WEBHOOK_SECRET"];
    else process.env["RESEND_WEBHOOK_SECRET"] = savedSecret;
  });

  const validBody = {
    type: "email.received",
    created_at: "2026-05-12T00:00:00.000Z",
    data: {
      from: "verify@service.test",
      to: ["inbox-bot@test.local"],
      subject: "Verify your email",
      text: "code 654321",
      email_id: "re-1",
    },
  };

  function svixSign(id: string, ts: string, body: string): string {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
    return `v1,${sig}`;
  }

  it("rejects a forged payload (bad svix-signature) with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_1",
        "svix-timestamp": "1700000000",
        "svix-signature": "v1,forged",
      },
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("accepts a genuinely signed payload", async () => {
    // The signature must cover the EXACT serialised body bytes.
    const body = JSON.stringify(validBody);
    const svixId = "msg_genuine";
    const svixTimestamp = "1700000000";
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSign(svixId, svixTimestamp, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects when the body is tampered after signing", async () => {
    const signedBody = JSON.stringify(validBody);
    const svixId = "msg_tamper";
    const svixTimestamp = "1700000000";
    const tampered = JSON.stringify({
      ...validBody,
      data: { ...validBody.data, text: "code 000000" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSign(svixId, svixTimestamp, signedBody),
      },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
  });

  it("fails closed (503) when the webhook secret is unset", async () => {
    delete process.env["RESEND_WEBHOOK_SECRET"];
    const blindApp = await buildServer({ deps: makeDeps() });
    const res = await blindApp.inject({
      method: "POST",
      url: "/v1/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": "x",
        "svix-timestamp": "1",
        "svix-signature": "v1,x",
      },
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    await blindApp.close();
  });
});

// ── Postfix (admin bearer) ───────────────────────────────────

describe("/v1/webhooks/postfix auth enforcement", () => {
  let app: FastifyInstance;
  const adminKey = "postfix-admin-key";
  let savedKey: string | undefined;

  const RAW_EMAIL = [
    "From: verify@service.test",
    "To: inbox-bot@test.local",
    "Subject: Verify",
    "Message-ID: <pf-1@service.test>",
    "",
    "Your code is 222333",
  ].join("\r\n");

  beforeEach(async () => {
    savedKey = process.env["UNIVERSAL_BOT_API_KEY"];
    process.env["UNIVERSAL_BOT_API_KEY"] = adminKey;
    app = await buildServer({ deps: makeDeps() });
  });

  afterEach(async () => {
    await app.close();
    if (savedKey === undefined) delete process.env["UNIVERSAL_BOT_API_KEY"];
    else process.env["UNIVERSAL_BOT_API_KEY"] = savedKey;
  });

  it("rejects a request without the admin bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/postfix",
      headers: { "content-type": "message/rfc822", "x-original-to": "inbox-bot@test.local" },
      payload: RAW_EMAIL,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a request with the correct admin bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/postfix",
      headers: {
        "content-type": "message/rfc822",
        "x-original-to": "inbox-bot@test.local",
        authorization: `Bearer ${adminKey}`,
      },
      payload: RAW_EMAIL,
    });
    expect(res.statusCode).toBe(200);
  });

  it("fails closed (503) when UNIVERSAL_BOT_API_KEY is unset", async () => {
    delete process.env["UNIVERSAL_BOT_API_KEY"];
    const blindApp = await buildServer({ deps: makeDeps() });
    const res = await blindApp.inject({
      method: "POST",
      url: "/v1/webhooks/postfix",
      headers: { "content-type": "message/rfc822", "x-original-to": "inbox-bot@test.local" },
      payload: RAW_EMAIL,
    });
    expect(res.statusCode).toBe(503);
    await blindApp.close();
  });
});

// ── SES (SNS signature) ──────────────────────────────────────

describe("/v1/webhooks/ses SNS signature enforcement", () => {
  // A throwaway RSA key pair stands in for the AWS SNS signing cert.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  function signSns(sns: Record<string, unknown>): string {
    const signer = createSign("RSA-SHA256");
    signer.update(buildSnsStringToSign(sns));
    signer.end();
    return signer.sign(privateKey, "base64");
  }

  // Build a minimal Fastify app with only the SES route, wired to a
  // stub cert fetcher so verification never hits the AWS network.
  async function buildSesApp(): Promise<FastifyInstance> {
    const Fastify = (await import("fastify")).default;
    const { registerSesWebhookRoute } = await import("../routes/ses-webhook.js");
    const deps = makeDeps();
    const fastify = Fastify({ logger: false });
    fastify.addContentTypeParser(
      "text/plain",
      { parseAs: "string" },
      (_req, body: string | Buffer, done) => {
        try {
          done(null, JSON.parse(typeof body === "string" ? body : body.toString()));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );
    await fastify.register(registerSesWebhookRoute, {
      deps: { sesHandler: deps.sesHandler, snsCertFetcher: async () => publicPem },
    });
    return fastify;
  }

  it("rejects an unsigned/forged SNS notification with 401", async () => {
    const app = await buildSesApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/ses",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({
        Type: "Notification",
        MessageId: "m1",
        TopicArn: "arn",
        Message: JSON.stringify({ mail: { messageId: "ses-1" } }),
        Timestamp: "2026-05-12T00:00:00.000Z",
        SignatureVersion: "2",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
        Signature: "forged-signature",
      }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_sns_signature" });
    await app.close();
  });

  it("rejects a tampered Notification (valid sig over a different Message)", async () => {
    const app = await buildSesApp();
    const sns: Record<string, unknown> = {
      Type: "Notification",
      MessageId: "m1",
      TopicArn: "arn",
      Message: JSON.stringify({ mail: { messageId: "ses-1" } }),
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);
    // Attacker swaps the Message to inject a verification email.
    sns["Message"] = JSON.stringify({ mail: { messageId: "attacker" } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/ses",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(sns),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts a genuinely signed SubscriptionConfirmation with an AWS SubscribeURL", async () => {
    const fastify = await buildSesApp();

    const sns: Record<string, unknown> = {
      Type: "SubscriptionConfirmation",
      MessageId: "m1",
      Token: "tok",
      TopicArn: "arn",
      Message: "confirm",
      // SubscribeURL must be an AWS SNS host; we never actually fetch it
      // here because confirmation only logs on a non-200.
      SubscribeURL:
        "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok",
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/webhooks/ses",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(sns),
    });
    // Signature verification passed; the route then tries to fetch
    // SubscribeURL — a network call we can't stub. It catches the error
    // and still returns 200 (confirmation is best-effort).
    expect(res.statusCode).toBe(200);
    await fastify.close();
  });

  it("rejects a SubscriptionConfirmation whose SubscribeURL is not an AWS host", async () => {
    const fastify = await buildSesApp();

    const sns: Record<string, unknown> = {
      Type: "SubscriptionConfirmation",
      MessageId: "m1",
      Token: "tok",
      TopicArn: "arn",
      Message: "confirm",
      SubscribeURL: "https://evil.example.com/?Action=ConfirmSubscription",
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/webhooks/ses",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(sns),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_subscribe_url" });
    await fastify.close();
  });
});
