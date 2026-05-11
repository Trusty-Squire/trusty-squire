// Shared test fixtures: a local-JWKS VouchflowVerifier and a bundle
// builder that mints a JWS using a freshly-generated Ed25519 key.
// Lets every API test run offline without touching vouchflow.dev.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";
import { VouchflowVerifier } from "@trusty-squire/mandate-validator";

export interface VouchflowSigner {
  signBundle(input: {
    context: string;
    payload: unknown;
    confidence?: "low" | "medium" | "high";
    signingDeviceId?: string;
    deviceToken?: string;
    sessionId?: string;
    platform?: "ios" | "android" | "web";
  }): Promise<{
    payload: string;
    context: string;
    assertion: string;
    signingDeviceId: string;
    deviceToken: string;
    confidence: "low" | "medium" | "high";
    signedAt: string;
    platform: "ios" | "android" | "web";
  }>;
  verifier: VouchflowVerifier;
  customerId: string;
}

export async function makeVouchflowSigner(customerId = "ts-test"): Promise<VouchflowSigner> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey as KeyLike)),
    kid: "test-kid",
    alg: "EdDSA",
    use: "sig",
  };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  const verifier = new VouchflowVerifier({ customerId, jwks });

  return {
    customerId,
    verifier,
    async signBundle(input) {
      const payloadString = JSON.stringify(input.payload);
      const hash = createHash("sha256").update(payloadString, "utf8").digest("hex");
      const sessionId = input.sessionId ?? `ses_${Math.random().toString(36).slice(2, 12)}`;
      const signingDeviceId = input.signingDeviceId ?? "sdv_test_device";
      const deviceToken = input.deviceToken ?? "dvt_test";
      const platform = input.platform ?? "web";
      const confidence = input.confidence ?? "high";

      const assertion = await new SignJWT({
        v: 1,
        context: input.context,
        device_token: deviceToken,
        signing_device_id: signingDeviceId,
        confidence,
        platform,
        payload_sha256: hash,
        session_id: sessionId,
      })
        .setProtectedHeader({ alg: "EdDSA", kid: "test-kid" })
        .setIssuer("https://vouchflow.dev")
        .setAudience(customerId)
        .setIssuedAt()
        .setExpirationTime("60s")
        .sign(privateKey);

      return {
        payload: payloadString,
        context: input.context,
        assertion,
        signingDeviceId,
        deviceToken,
        confidence,
        signedAt: new Date().toISOString(),
        platform,
      };
    },
  };
}

// Tiny base64url helper for cookie roundtripping in tests.
export function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
