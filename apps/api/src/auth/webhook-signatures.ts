// Inbound-mail webhook signature verification.
//
// An attacker who can POST to /v1/webhooks/resend-inbound can forge an
// email; the bot then reads parsed_codes/parsed_links off the stored
// row to complete a signup, so a forged email can inject a verification
// code or link. Resend uses Svix-style HMAC-SHA256 signatures.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// ── Result type ──────────────────────────────────────────────

export type VerifyResult =
  | { ok: true }
  // `not_configured` → the required secret env var is missing; the
  // caller must fail-closed (503) and log. `invalid` → a real forgery
  // or replay; caller returns 401.
  | { ok: false; reason: "not_configured" | "invalid"; detail: string };

// ── Resend / Svix ────────────────────────────────────────────
//
// Resend's inbound + transactional webhooks are signed via Svix.
// Verification:
//   1. Required headers: svix-id, svix-timestamp, svix-signature.
//   2. Reject timestamps outside ±5 minutes (replay-window guard).
//   3. Canonical signed content = `<svix-id>.<svix-timestamp>.<raw body>`.
//   4. HMAC-SHA256 with the secret (whsec_<base64> — strip prefix,
//      then base64-decode for the key bytes).
//   5. svix-signature may carry multiple space-separated `vN,<base64>`
//      values; v1 is the SHA256 scheme. Compare against each in
//      constant time and accept on the first match.
//
// Replay window matches Svix's documented default. Tighter is fine
// for transactional surfaces but the default covers clock skew and
// reasonable retry intervals.

const SVIX_REPLAY_WINDOW_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface VerifySvixOptions {
  // Test seam — override the current time for deterministic replay-
  // window checks. Defaults to Date.now() / 1000.
  nowSeconds?: number;
}

export function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: string,
  secret: string,
  opts: VerifySvixOptions = {},
): VerifyResult {
  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, reason: "not_configured", detail: "missing_secret" };
  }
  if (
    typeof headers.id !== "string" ||
    typeof headers.timestamp !== "string" ||
    typeof headers.signature !== "string"
  ) {
    return { ok: false, reason: "invalid", detail: "missing_svix_headers" };
  }

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid", detail: "invalid_timestamp" };
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SVIX_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "invalid", detail: "timestamp_outside_replay_window" };
  }

  // Strip the `whsec_` prefix Svix prepends to a secret on copy.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(rawSecret, "base64");
    if (keyBytes.length === 0) throw new Error("empty");
  } catch {
    return { ok: false, reason: "not_configured", detail: "secret_not_base64" };
  }

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", keyBytes).update(signedContent).digest();

  // svix-signature can carry multiple signatures separated by spaces,
  // each `v1,<base64>`. Accept any v1 match in constant time.
  const sigs = headers.signature.split(/\s+/).filter((s) => s.length > 0);
  for (const sig of sigs) {
    const idx = sig.indexOf(",");
    if (idx < 0) continue;
    const scheme = sig.slice(0, idx);
    if (scheme !== "v1") continue;
    const presented = sig.slice(idx + 1);
    let presentedBytes: Buffer;
    try {
      presentedBytes = Buffer.from(presented, "base64");
    } catch {
      continue;
    }
    if (presentedBytes.length !== expected.length) continue;
    if (timingSafeEqual(presentedBytes, expected)) return { ok: true };
  }

  return { ok: false, reason: "invalid", detail: "signature_mismatch" };
}
