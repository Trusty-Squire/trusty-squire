// Vouchflow verifier tests. We build a local JWS using jose's SignJWT
// against a freshly-generated Ed25519 key, then point the verifier at
// a JWKS that contains just that key. No network needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createHash } from "node:crypto";
import {
  VouchflowVerificationError,
  VouchflowVerifier,
  confidenceMeets,
  type ConfidenceLevel,
  type VouchflowSignedBundle,
} from "../index.js";

const CUSTOMER_ID = "ts-test-customer";
const ISSUER = "https://vouchflow.dev";

interface MakeBundleOpts {
  payload: unknown;
  context?: string;
  confidence?: ConfidenceLevel;
  audience?: string;
  issuer?: string;
  iatOffsetSec?: number;
  expOffsetSec?: number;
  payloadHashOverride?: string;
  contextInClaimsOverride?: string;
}

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "EdDSA", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  const verifier = new VouchflowVerifier({ customerId: CUSTOMER_ID, jwks });

  async function makeBundle(opts: MakeBundleOpts): Promise<VouchflowSignedBundle> {
    const payloadString = JSON.stringify(opts.payload);
    const payloadHash =
      opts.payloadHashOverride ??
      createHash("sha256").update(payloadString, "utf8").digest("hex");
    const ctxInClaims = opts.contextInClaimsOverride ?? opts.context ?? "mandate_signing";

    const iat = Math.floor(Date.now() / 1000) + (opts.iatOffsetSec ?? -1);
    const exp = iat + (opts.expOffsetSec ?? 60);

    const assertion = await new SignJWT({
      v: 1,
      context: ctxInClaims,
      device_token: "dvt_test",
      signing_device_id: "sdv_test",
      confidence: opts.confidence ?? "high",
      platform: "web",
      payload_sha256: payloadHash,
      session_id: `ses_${Math.random().toString(36).slice(2, 12)}`,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-kid" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? CUSTOMER_ID)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKey);

    return {
      payload: payloadString,
      context: opts.context ?? "mandate_signing",
      assertion,
      signingDeviceId: "sdv_test",
      deviceToken: "dvt_test",
      confidence: opts.confidence ?? "high",
      signedAt: new Date(iat * 1000).toISOString(),
      platform: "web",
    };
  }

  return { verifier, makeBundle };
}

describe("VouchflowVerifier.verify", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifies a well-formed bundle and returns claims", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({ payload: { foo: "bar" } });
    const claims = await verifier.verify(bundle, "mandate_signing", "high");
    expect(claims.context).toBe("mandate_signing");
    expect(claims.confidence).toBe("high");
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(CUSTOMER_ID);
  });

  it("rejects when claims.context ≠ expected", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({
      payload: { foo: "bar" },
      context: "mandate_signing",
      contextInClaimsOverride: "transaction_approval",
    });
    await expect(verifier.verify(bundle, "mandate_signing", "high")).rejects.toMatchObject({
      code: "context_mismatch",
    });
  });

  it("rejects when SHA-256(bundle.payload) ≠ claims.payload_sha256 (tampering)", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({
      payload: { foo: "bar" },
      payloadHashOverride: "0".repeat(64),
    });
    await expect(verifier.verify(bundle, "mandate_signing", "high")).rejects.toMatchObject({
      code: "payload_tampering",
    });
  });

  it("rejects bundle whose claims.confidence is below minimum", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({ payload: { x: 1 }, confidence: "medium" });
    await expect(verifier.verify(bundle, "mandate_signing", "high")).rejects.toMatchObject({
      code: "confidence_too_low",
    });
  });

  it("rejects wrong audience (issued for a different customer)", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({ payload: { x: 1 }, audience: "other-customer" });
    await expect(verifier.verify(bundle, "mandate_signing", "high")).rejects.toMatchObject({
      code: "jws_verification_failed",
    });
  });

  it("rejects wrong issuer", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({ payload: { x: 1 }, issuer: "https://attacker.example" });
    await expect(verifier.verify(bundle, "mandate_signing", "high")).rejects.toMatchObject({
      code: "jws_verification_failed",
    });
  });

  it("rejects expired JWS", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({
      payload: { x: 1 },
      iatOffsetSec: -3600,
      expOffsetSec: 60, // exp = iat + 60 = 59 minutes ago
    });
    await expect(verifier.verify(bundle, "mandate_signing", "high")).rejects.toMatchObject({
      code: "jws_verification_failed",
    });
  });

  it("parsePayload returns the canonical JSON parsed", async () => {
    const { verifier, makeBundle } = await setup();
    const bundle = await makeBundle({ payload: { service: "resend", plan: "pro" } });
    expect(verifier.parsePayload<{ service: string }>(bundle)).toEqual({
      service: "resend",
      plan: "pro",
    });
  });
});

describe("confidenceMeets", () => {
  it.each([
    ["low", "low", true],
    ["low", "medium", false],
    ["low", "high", false],
    ["medium", "low", true],
    ["medium", "medium", true],
    ["medium", "high", false],
    ["high", "low", true],
    ["high", "medium", true],
    ["high", "high", true],
  ] as const)("actual=%s required=%s → %s", (actual, required, expected) => {
    expect(confidenceMeets(actual, required)).toBe(expected);
  });
});

describe("VouchflowVerificationError", () => {
  it("carries a stable error code", () => {
    const err = new VouchflowVerificationError("test_code", "msg");
    expect(err.code).toBe("test_code");
    expect(err.name).toBe("VouchflowVerificationError");
  });
});
