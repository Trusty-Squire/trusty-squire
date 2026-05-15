// Unit tests for the SES inbound-mail webhook signature verifier:
// the SNS RSA signature over the canonical string-to-sign, checked
// with a genuine signature and a forged one.

import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  buildSnsStringToSign,
  isAwsSnsHost,
  verifySnsSignature,
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
