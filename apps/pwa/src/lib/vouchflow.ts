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
//
// Diagnostics: signPayload / verify wrap their inner SDK call in a
// fetch interceptor that records every request to api.vouchflow.dev,
// attaching the capture to the thrown error. Callers can render the
// log inline via <VouchflowDiagnostics err={...} /> — useful on mobile
// where DevTools isn't available.

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

export interface VouchflowCallLog {
  method: string;
  url: string;
  status: number;
  request_body: string | null;
  response_body: string;
  duration_ms: number;
}

const DIAGNOSTICS_SYMBOL: unique symbol = Symbol.for("trusty-squire.vouchflow.diagnostics");

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

// Empty-string userHandle is a real "we don't know" signal from pages
// like /pair that aren't sure of the logged-in email yet. Treat it the
// same as not provided — Vouchflow will pick the only credential on the
// device, which is the right thing in v0's single-user-per-device world.
function cleanHandle(h: string | undefined): string | undefined {
  return h !== undefined && h.length > 0 ? h : undefined;
}

// ── Fetch interceptor for diagnostics ───────────────────────
//
// Replaces window.fetch with a wrapper that records every call to
// api.vouchflow.dev. Returns a `stop()` that restores the original.
// Module-level `activeLog` is fine because the SDK's withCeremonyLock
// guarantees only one signPayload/verify is in flight at a time.

let activeLog: VouchflowCallLog[] | null = null;

function startCapture(): () => void {
  if (typeof window === "undefined") return () => {};
  const original = window.fetch.bind(window);
  activeLog = [];
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isVouchflow = url.includes("vouchflow.dev");
    if (!isVouchflow || activeLog === null) {
      return original(input, init);
    }
    const method = init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
    const requestBody = typeof init?.body === "string" ? init.body : null;
    const startedAt = Date.now();
    try {
      const res = await original(input, init);
      const clone = res.clone();
      let body = "";
      try {
        body = await clone.text();
      } catch {
        body = "<unreadable>";
      }
      activeLog.push({
        method,
        url,
        status: res.status,
        request_body: requestBody,
        response_body: truncate(body, 4000),
        duration_ms: Date.now() - startedAt,
      });
      return res;
    } catch (err) {
      activeLog.push({
        method,
        url,
        status: 0,
        request_body: requestBody,
        response_body: `<network error> ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - startedAt,
      });
      throw err;
    }
  };
  return () => {
    window.fetch = original;
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…<truncated ${s.length - n} chars>` : s;
}

function attachDiagnostics(err: unknown, log: VouchflowCallLog[]): void {
  if (err === null || typeof err !== "object") return;
  try {
    (err as Record<symbol, VouchflowCallLog[]>)[DIAGNOSTICS_SYMBOL] = log;
  } catch {
    // Frozen / sealed error objects: silently skip — DevTools console
    // path still shows the raw error.
  }
}

export function getVouchflowDiagnostics(err: unknown): VouchflowCallLog[] | null {
  if (err === null || typeof err !== "object") return null;
  const log = (err as Record<symbol, unknown>)[DIAGNOSTICS_SYMBOL];
  return Array.isArray(log) ? (log as VouchflowCallLog[]) : null;
}

// ─────────────────────────────────────────────────────────────

export async function signPayload(opts: {
  context: string;
  payload: unknown;
  userHandle?: string;
  minConfidence?: Confidence;
}): Promise<Bundle> {
  configure();
  if (MODE === "stub") return stubBundle(opts.context, opts.payload);
  const handle = cleanHandle(opts.userHandle);
  const stop = startCapture();
  try {
    const result = await Vouchflow.shared.signPayload({
      context: opts.context,
      payload: opts.payload,
      ...(handle !== undefined ? { userHandle: handle } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
    });
    return bundleFromSignResult(result, opts.context);
  } catch (err) {
    if (activeLog !== null) attachDiagnostics(err, activeLog);
    throw err;
  } finally {
    stop();
    activeLog = null;
  }
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
  const handle = cleanHandle(opts.userHandle);
  const stop = startCapture();
  try {
    return await Vouchflow.shared.verify({
      context: opts.context,
      ...(handle !== undefined ? { userHandle: handle } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
    });
  } catch (err) {
    if (activeLog !== null) attachDiagnostics(err, activeLog);
    throw err;
  } finally {
    stop();
    activeLog = null;
  }
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
