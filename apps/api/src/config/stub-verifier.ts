// Stub Vouchflow verifier for demo/test mode.
// Accepts any bundle without real verification - DO NOT USE IN PRODUCTION.

import type { VouchflowVerifiedClaims } from "@trusty-squire/mandate-validator";

export interface StubVouchflowVerifier {
  verify(
    bundle: {
      payload: string;
      context: string;
      assertion: string;
      signingDeviceId: string;
      deviceToken: string;
      confidence: string;
      signedAt: string;
      platform: string;
    },
    expectedContext: string,
    requiredConfidence: string,
  ): Promise<VouchflowVerifiedClaims>;
  
  parsePayload<T>(bundle: { payload: string }): T;
}

export function makeStubVouchflowVerifier(customerId: string): StubVouchflowVerifier {
  return {
    async verify(bundle, expectedContext, requiredConfidence) {
      // In stub mode, accept any bundle and return mock claims
      console.log(`[STUB] Accepting bundle for context: ${expectedContext}`);
      
      // Parse the payload to extract any embedded data
      let payloadData: any = {};
      try {
        payloadData = JSON.parse(bundle.payload);
      } catch {
        // Ignore parse errors in stub mode
      }

      return {
        v: 1,
        context: bundle.context,
        payload_sha256: "stub-sha256",
        signing_device_id: bundle.signingDeviceId,
        device_token: bundle.deviceToken,
        confidence: bundle.confidence as any,
        platform: bundle.platform as any,
        session_id: "stub-session-id",
        iss: "https://vouchflow.dev",
        aud: customerId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    },
    
    parsePayload<T>(bundle: { payload: string }): T {
      try {
        return JSON.parse(bundle.payload) as T;
      } catch (err) {
        throw new Error(
          `[STUB] bundle.payload is not parseable JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
