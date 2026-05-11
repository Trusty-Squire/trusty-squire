// Vouchflow Web SDK wrapper.
//
// All Vouchflow ceremonies (login, register, mandate-signing, pairing)
// go through this module so the singleton config + bundle-shape
// normalization live in one place.
//
// In `stub` mode (NEXT_PUBLIC_VOUCHFLOW_MODE=stub) we short-circuit to a
// deterministic fake bundle. The API's verifier is happy to accept a
// locally-signed bundle when wired against a test JWKS — Playwright
// tests intercept network calls at the `/api/test-mock` mock layer
// instead of round-tripping through a real Vouchflow API.
//
// Bundle-split note: this module is statically imported only by pages
// that actually perform ceremonies (signup/sign, login, pair, policy).
// /dashboard, /ledger, /subscriptions and /settings never import it
// (api-client.ts uses `import type` for the Bundle shape only). Next's
// per-route code splitting therefore keeps @vouchflow/web OFF the
// dashboard's First Load JS — confirmed at ~6 kB gzip delta between
// signing routes (114 kB) and non-signing routes (108 kB).

"use client";

import { Vouchflow, VouchflowError } from "@vouchflow/web";
import type { Confidence, SignResult, VerifyResult } from "@vouchflow/web";
import { resolveVouchflowConfig } from "./vouchflow-config";

export type Bundle = {
  payload: string;
  context: string;
  assertion: string;
  signingDeviceId: string;
  deviceToken: string;
  confidence: Confidence;
  signedAt: string;
  platform: "web";
};

const MODE = process.env.NEXT_PUBLIC_VOUCHFLOW_MODE ?? "live";

let configured = false;

function configure(): void {
  if (configured || MODE === "stub") return;
  Vouchflow.configure(resolveVouchflowConfig());
  configured = true;
}

function bundleFromSignResult(result: SignResult, context: string): Bundle {
  return {
    payload: result.payload,
    context,
    assertion: result.assertion,
    signingDeviceId: result.signingDeviceId,
    deviceToken: result.deviceToken,
    confidence: result.confidence,
    signedAt: result.signedAt,
    platform: "web",
  };
}

export async function signPayload(opts: {
  context: string;
  payload: unknown;
  userHandle?: string;
  minConfidence?: Confidence;
}): Promise<Bundle> {
  configure();
  if (MODE === "stub") return stubBundle(opts.context, opts.payload);
  const result = await Vouchflow.shared.signPayload({
    context: opts.context,
    payload: opts.payload,
    ...(opts.userHandle !== undefined ? { userHandle: opts.userHandle } : {}),
    ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
  });
  return bundleFromSignResult(result, opts.context);
}

export async function verify(opts: {
  context: string;
  userHandle?: string;
  minConfidence?: Confidence;
}): Promise<VerifyResult> {
  configure();
  if (MODE === "stub") {
    return {
      verified: true,
      confidence: opts.minConfidence ?? "medium",
      deviceToken: "stub-device-token",
      sessionId: "stub-session-id",
      biometricUsed: true,
      signals: {
        keychainPersistent: true,
        anomalyFlags: [],
        deviceAgeDays: 30,
        crossAppHistory: false,
        attestationVerified: true,
      },
    };
  }
  return Vouchflow.shared.verify({
    context: opts.context,
    ...(opts.userHandle !== undefined ? { userHandle: opts.userHandle } : {}),
    ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
  });
}

export async function enroll(userHandle: string): Promise<void> {
  configure();
  if (MODE === "stub") return;
  await Vouchflow.shared.enroll({ userHandle });
}

export function isVouchflowError(err: unknown): err is VouchflowError {
  return err instanceof VouchflowError;
}

function stubBundle(context: string, payload: unknown): Bundle {
  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    payload: payloadString,
    context,
    assertion: "stub.assertion.jws",
    signingDeviceId: "sdv_stub",
    deviceToken: "stub-device-token",
    confidence: "high",
    signedAt: new Date().toISOString(),
    platform: "web",
  };
}
