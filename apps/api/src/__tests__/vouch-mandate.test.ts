import { createHash, generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAYMENT_VOUCH_CONTEXT, createVouchMandateVerifier } from "../services/vouch-mandate.js";

describe("Vouchflow mandate verification", () => {
  const now = Date.parse("2026-08-29T12:00:00.000Z");
  const audience = "customer_test";
  const payloadHash = createHash("sha256").update("bound payment payload").digest();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function verifier() {
    const jwk = await exportJWK(publicKey);
    return createVouchMandateVerifier(
      async () => Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] }),
      "https://vouchflow.test",
    );
  }

  async function assertion(input: {
    expiredMs: number;
    expectedAudience?: string;
  }): Promise<string> {
    const expiresAt = Math.floor((now - input.expiredMs) / 1_000);
    return await new SignJWT({
      payload_sha256: payloadHash.toString("base64url"),
      context: PAYMENT_VOUCH_CONTEXT,
      confidence: "high",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://vouchflow.dev")
      .setAudience(input.expectedAudience ?? audience)
      .setIssuedAt(expiresAt - 60)
      .setExpirationTime(expiresAt)
      .sign(privateKey);
  }

  it("keeps first acceptance current-time and fail-closed", async () => {
    const verify = await verifier();
    await expect(
      verify({
        jws: await assertion({ expiredMs: 60_000 }),
        expectedPayloadHash: payloadHash,
        expectedContext: PAYMENT_VOUCH_CONTEXT,
        expectedAudience: audience,
      }),
    ).rejects.toMatchObject({
      code: "mandate_verification_failed",
    });
  });

  it("re-verifies a recently expired candidate that was accepted into the relay", async () => {
    const verify = await verifier();
    await expect(
      verify({
        jws: await assertion({ expiredMs: 60_000 }),
        expectedPayloadHash: payloadHash,
        expectedContext: PAYMENT_VOUCH_CONTEXT,
        expectedAudience: audience,
        previouslyVerifiedRelay: true,
      }),
    ).resolves.toMatchObject({ context: PAYMENT_VOUCH_CONTEXT });
  });

  it("rejects relayed assertions beyond the longest approval window", async () => {
    const verify = await verifier();
    await expect(
      verify({
        jws: await assertion({ expiredMs: 19 * 60_000 }),
        expectedPayloadHash: payloadHash,
        expectedContext: PAYMENT_VOUCH_CONTEXT,
        expectedAudience: audience,
        previouslyVerifiedRelay: true,
      }),
    ).rejects.toMatchObject({
      code: "mandate_assertion_expired",
    });
  });

  it("does not relax audience verification for an expired relay candidate", async () => {
    const verify = await verifier();
    await expect(
      verify({
        jws: await assertion({ expiredMs: 60_000, expectedAudience: "other-customer" }),
        expectedPayloadHash: payloadHash,
        expectedContext: PAYMENT_VOUCH_CONTEXT,
        expectedAudience: audience,
        previouslyVerifiedRelay: true,
      }),
    ).rejects.toMatchObject({
      code: "mandate_verification_failed",
    });
  });
});
