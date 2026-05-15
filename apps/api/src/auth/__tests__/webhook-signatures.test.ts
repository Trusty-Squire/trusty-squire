// Unit tests for the per-provider webhook signature verifiers.
//   - SNS (SES): RSA signature over the canonical string-to-sign
//   - Mailgun: HMAC-SHA256 of (timestamp + token)
//   - Svix (Resend): HMAC-SHA256 over `${id}.${timestamp}.${body}`
//
// Each verifier is checked with a genuine signature and a forged one.

import { describe, expect, it } from "vitest";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import {
  buildSnsStringToSign,
  isAwsSnsHost,
  verifyMailgunSignature,
  verifySnsSignature,
  verifySvixSignature,
} from "../webhook-signatures.js";

describe("isAwsSnsHost", () => {
  it("accepts genuine SNS hosts", () => {
    expect(isAwsSnsHost("https://sns.us-east-1.amazonaws.com/cert.pem")).toBe(true);
    expect(isAwsSnsHost("https://sns.eu-west-2.amazonaws.com/x")).toBe(true);
  });

  it("rejects non-AWS and non-https hosts", () => {
    expect(isAwsSnsHost("https://evil.example.com/cert.pem")).toBe(false);
    expect(isAwsSnsHost("https://sns.us-east-1.amazonaws.com.evil.com/x")).toBe(false);
    expect(isAwsSnsHost("http://sns.us-east-1.amazonaws.com/x")).toBe(false);
    expect(isAwsSnsHost("not a url")).toBe(false);
  });
});

describe("verifySnsSignature", () => {
  // A throwaway RSA key pair stands in for the AWS SNS signing cert.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  function signSns(sns: Record<string, unknown>): string {
    const signer = createSign("RSA-SHA256");
    signer.update(buildSnsStringToSign(sns));
    signer.end();
    return signer.sign(privateKey, "base64");
  }

  it("accepts a genuinely signed Notification", async () => {
    const sns: Record<string, unknown> = {
      Type: "Notification",
      MessageId: "msg-1",
      TopicArn: "arn:aws:sns:us-east-1:1:topic",
      Message: JSON.stringify({ mail: { messageId: "ses-1" } }),
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);

    const res = await verifySnsSignature(sns, { certFetcher: async () => publicPem });
    expect(res.ok).toBe(true);
  });

  it("rejects a forged Notification (tampered Message)", async () => {
    const sns: Record<string, unknown> = {
      Type: "Notification",
      MessageId: "msg-1",
      TopicArn: "arn:aws:sns:us-east-1:1:topic",
      Message: JSON.stringify({ mail: { messageId: "ses-1" } }),
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);
    // Attacker swaps in their own verification email after signing.
    sns["Message"] = JSON.stringify({ mail: { messageId: "attacker" } });

    const res = await verifySnsSignature(sns, { certFetcher: async () => publicPem });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid");
  });

  it("rejects a cert URL that is not an AWS SNS host", async () => {
    const sns: Record<string, unknown> = {
      Type: "Notification",
      MessageId: "msg-1",
      TopicArn: "arn",
      Message: "{}",
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://evil.example.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);
    const res = await verifySnsSignature(sns, { certFetcher: async () => publicPem });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBe("signing_cert_url_not_aws_sns");
  });

  it("signs SubscriptionConfirmation over the subscription key set", async () => {
    const sns: Record<string, unknown> = {
      Type: "SubscriptionConfirmation",
      MessageId: "msg-1",
      Token: "tok",
      TopicArn: "arn",
      Message: "confirm me",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
      Timestamp: "2026-05-12T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    sns["Signature"] = signSns(sns);
    const res = await verifySnsSignature(sns, { certFetcher: async () => publicPem });
    expect(res.ok).toBe(true);
  });
});

describe("verifyMailgunSignature", () => {
  const signingKey = "key-test-mailgun";

  function sign(timestamp: string, token: string): string {
    return createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
  }

  it("accepts a genuine signature", () => {
    const res = verifyMailgunSignature({
      timestamp: "1700000000",
      token: "tok-abc",
      signature: sign("1700000000", "tok-abc"),
      signingKey,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a forged signature", () => {
    const res = verifyMailgunSignature({
      timestamp: "1700000000",
      token: "tok-abc",
      signature: "deadbeef",
      signingKey,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid");
  });

  it("fails closed when the signing key is missing", () => {
    const res = verifyMailgunSignature({
      timestamp: "1700000000",
      token: "tok-abc",
      signature: sign("1700000000", "tok-abc"),
      signingKey: undefined,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });
});

describe("verifySvixSignature", () => {
  // Svix secrets are `whsec_<base64>`.
  const secret = `whsec_${Buffer.from("svix-test-secret").toString("base64")}`;
  const svixId = "msg_abc";
  const svixTimestamp = "1700000000";

  function sign(id: string, ts: string, body: string): string {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
    return `v1,${sig}`;
  }

  it("accepts a genuine signature over the raw body", () => {
    const body = JSON.stringify({ type: "email.received" });
    const res = verifySvixSignature({
      svixId,
      svixTimestamp,
      svixSignature: sign(svixId, svixTimestamp, body),
      rawBody: body,
      secret,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects when the body is tampered after signing", () => {
    const body = JSON.stringify({ type: "email.received" });
    const res = verifySvixSignature({
      svixId,
      svixTimestamp,
      svixSignature: sign(svixId, svixTimestamp, body),
      rawBody: JSON.stringify({ type: "email.received", injected: true }),
      secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid");
  });

  it("rejects when svix headers are missing", () => {
    const res = verifySvixSignature({
      svixId: undefined,
      svixTimestamp,
      svixSignature: "v1,whatever",
      rawBody: "{}",
      secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBe("missing_svix_headers");
  });

  it("fails closed when the secret is missing", () => {
    const res = verifySvixSignature({
      svixId,
      svixTimestamp,
      svixSignature: "v1,whatever",
      rawBody: "{}",
      secret: undefined,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });
});
