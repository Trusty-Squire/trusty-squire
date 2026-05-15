// Integration tests for SES inbound-mail webhook signature enforcement.
//
// The SES webhook is exercised with a forged request (must be rejected)
// and a genuine signed request (must be accepted). A forged email
// otherwise lets an attacker inject a verification code/link the signup
// bot reads.

import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createSign, generateKeyPairSync } from "node:crypto";
import { buildInMemoryDeps } from "../services/deps.js";
import { buildSnsStringToSign } from "../auth/webhook-signatures.js";

const CUSTOMER_ID = "ts-test";

function makeDeps() {
  return buildInMemoryDeps({
    sessionSecret: "test-secret-not-used",
    customerId: CUSTOMER_ID,
  });
}

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
