// Mandate bundle tests — wire a real VouchflowVerifier (with a local
// JWKS) into MandateValidator + verify the mandate-specific layer:
// payload parsing, nonce burn, lower-bound invariant.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import { canonicalString } from "../canonicalize.js";
import {
  MandateValidator,
  VouchflowVerifier,
  type Mandate,
  type VouchflowSignedBundle,
} from "../index.js";
import { makeMandatePayload, generateEd25519, makeDeps, NOW } from "./_fixtures.js";

const CUSTOMER_ID = "ts-test";

async function harness() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: "test-kid",
    alg: "EdDSA",
    use: "sig",
  };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  const verifier = new VouchflowVerifier({ customerId: CUSTOMER_ID, jwks });
  return { privateKey, verifier };
}

async function makeMandateBundle(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  mandate: Mandate,
  opts: { confidence?: "low" | "medium" | "high"; sessionId?: string } = {},
): Promise<VouchflowSignedBundle> {
  const payloadString = canonicalString(mandate);
  const hash = createHash("sha256").update(payloadString, "utf8").digest("hex");
  const sessionId = opts.sessionId ?? "ses_" + Math.random().toString(36).slice(2, 14);

  const assertion = await new SignJWT({
    v: 1,
    context: "mandate_signing",
    device_token: "dvt_test",
    signing_device_id: "sdv_test",
    confidence: opts.confidence ?? "high",
    platform: "web",
    payload_sha256: hash,
    session_id: sessionId,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-kid" })
    .setIssuer("https://vouchflow.dev")
    .setAudience(CUSTOMER_ID)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);

  return {
    payload: payloadString,
    context: "mandate_signing",
    assertion,
    signingDeviceId: "sdv_test",
    deviceToken: "dvt_test",
    confidence: opts.confidence ?? "high",
    signedAt: NOW,
    platform: "web",
  };
}

describe("verifyMandateBundle (Vouchflow path)", () => {
  it("verifies a valid mandate bundle and returns the parsed mandate", async () => {
    const { privateKey, verifier } = await harness();
    const pair = generateEd25519();
    const mandate = makeMandatePayload(pair);
    const bundle = await makeMandateBundle(privateKey, mandate);

    const deps = makeDeps();
    const v = new MandateValidator(deps, verifier);
    const r = await v.verifyMandateBundle(bundle);
    expect(r.result.valid).toBe(true);
    expect(r.mandate?.id).toBe(mandate.id);
    expect(r.claims?.confidence).toBe("high");
  });

  it("burns session_id as nonce on success", async () => {
    const { privateKey, verifier } = await harness();
    const pair = generateEd25519();
    const mandate = makeMandatePayload(pair);
    const sessionId = "ses_burn_test";
    const bundle = await makeMandateBundle(privateKey, mandate, { sessionId });

    const deps = makeDeps();
    expect(deps.usedNonces.has(sessionId)).toBe(false);
    const v = new MandateValidator(deps, verifier);
    await v.verifyMandateBundle(bundle);
    expect(deps.usedNonces.has(sessionId)).toBe(true);
  });

  it("rejects a bundle whose session_id is already burned (replay)", async () => {
    const { privateKey, verifier } = await harness();
    const pair = generateEd25519();
    const mandate = makeMandatePayload(pair);
    const sessionId = "ses_pre_burned";
    const bundle = await makeMandateBundle(privateKey, mandate, { sessionId });

    const deps = makeDeps();
    deps.usedNonces.add(sessionId);
    const v = new MandateValidator(deps, verifier);
    const r = await v.verifyMandateBundle(bundle);
    expect(r.result.valid).toBe(false);
    expect(r.result.reason).toBe("nonce_replay");
  });

  it("rejects a bundle below 'high' confidence", async () => {
    const { privateKey, verifier } = await harness();
    const pair = generateEd25519();
    const mandate = makeMandatePayload(pair);
    const bundle = await makeMandateBundle(privateKey, mandate, { confidence: "medium" });

    const v = new MandateValidator(makeDeps(), verifier);
    const r = await v.verifyMandateBundle(bundle);
    expect(r.result.valid).toBe(false);
    expect(r.result.reason).toBe("confidence_too_low");
  });

  it("rejects a mandate that downgrades a confidence requirement below the floor", async () => {
    const { privateKey, verifier } = await harness();
    const pair = generateEd25519();
    // mandate_signing's floor is `high`; downgrade to `low`.
    const mandate = makeMandatePayload(pair, {
      confidence_requirements: {
        provision: "medium",
        rotate: "medium",
        cancel: "medium",
        amend_mandate: "low", // ⬅ violates floor (default 'high')
        release_identity: "high",
      },
    });
    const bundle = await makeMandateBundle(privateKey, mandate);

    const v = new MandateValidator(makeDeps(), verifier);
    const r = await v.verifyMandateBundle(bundle);
    expect(r.result.valid).toBe(false);
    expect(r.result.reason).toMatch(/mandate_downgrades_confidence:amend_mandate/);
  });

  it("does not burn the nonce on verification failure", async () => {
    const { privateKey, verifier } = await harness();
    const pair = generateEd25519();
    const mandate = makeMandatePayload(pair);
    const sessionId = "ses_no_burn_on_fail";
    const bundle = await makeMandateBundle(privateKey, mandate, {
      confidence: "low",
      sessionId,
    });

    const deps = makeDeps();
    const v = new MandateValidator(deps, verifier);
    const r = await v.verifyMandateBundle(bundle);
    expect(r.result.valid).toBe(false);
    expect(deps.usedNonces.has(sessionId)).toBe(false);
  });

  // Keep Buffer reference live so lint's no-unused-import doesn't fire
  // when the test fixture stops using it later.
  it("Buffer import is referenced", () => {
    expect(Buffer.from("x", "utf8").toString("utf8")).toBe("x");
  });
});
