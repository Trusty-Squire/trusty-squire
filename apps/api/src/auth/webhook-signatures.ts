// Inbound-mail webhook signature verification.
//
// An attacker who can POST to /v1/webhooks/ses can forge an email; the
// bot then reads parsed_codes/parsed_links off the stored row to
// complete a signup, so a forged email can inject a verification code
// or link. SES is verified by its SNS message signature against the AWS
// SNS signing cert — no pre-shared secret, the cert is the trust anchor.

import { createHmac, createVerify, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// ── Result type ──────────────────────────────────────────────

export type VerifyResult =
  | { ok: true }
  // `not_configured` → the required secret env var is missing; the
  // caller must fail-closed (503) and log. `invalid` → a real forgery
  // or replay; caller returns 401.
  | { ok: false; reason: "not_configured" | "invalid"; detail: string };

// ── SES / SNS ────────────────────────────────────────────────

// SNS signs every message with an RSA key whose public cert is hosted
// at SigningCertURL. We verify the signature over a canonical
// string-to-sign built from a fixed, ordered subset of fields.

// Only fetch a SigningCertURL / SubscribeURL whose host is a genuine
// AWS SNS endpoint. Without this check an attacker could host their own
// cert and "verify" their own forged message.
export function isAwsSnsHost(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Genuine SNS hosts look like `sns.<region>.amazonaws.com` (and the
  // China partition `sns.<region>.amazonaws.com.cn`).
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname);
}

// Field ordering for the SNS canonical string-to-sign. SNS documents a
// fixed key order per message type; signing over the wrong order or set
// fails verification.
const SNS_NOTIFICATION_KEYS = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
] as const;
const SNS_SUBSCRIPTION_KEYS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

// Build the newline-delimited `key\nvalue\n` string SNS signs. `Subject`
// is included only when present (it's optional on Notification).
export function buildSnsStringToSign(sns: Record<string, unknown>): string {
  const type = sns["Type"];
  const keys =
    type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation"
      ? SNS_SUBSCRIPTION_KEYS
      : SNS_NOTIFICATION_KEYS;
  let out = "";
  for (const key of keys) {
    const value = sns[key];
    if (value === undefined) continue; // Subject is optional.
    if (typeof value !== "string") continue;
    out += `${key}\n${value}\n`;
  }
  return out;
}

// Cert fetcher seam — tests inject a stub so they don't hit the network
// or need a live AWS cert.
export type CertFetcher = (url: string) => Promise<string>;

const defaultCertFetcher: CertFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sns_cert_fetch_failed_${res.status}`);
  return res.text();
};

export interface VerifySnsOptions {
  certFetcher?: CertFetcher;
}

// Verify an SNS message (Notification or SubscriptionConfirmation).
// SES verification needs no pre-shared secret — the AWS public cert is
// the trust anchor — so this is always-on.
export async function verifySnsSignature(
  sns: Record<string, unknown>,
  opts: VerifySnsOptions = {},
): Promise<VerifyResult> {
  const certUrl = sns["SigningCertURL"];
  if (typeof certUrl !== "string" || !isAwsSnsHost(certUrl)) {
    return {
      ok: false,
      reason: "invalid",
      detail: "signing_cert_url_not_aws_sns",
    };
  }
  const signatureB64 = sns["Signature"];
  if (typeof signatureB64 !== "string" || signatureB64.length === 0) {
    return { ok: false, reason: "invalid", detail: "missing_signature" };
  }
  // SignatureVersion 1 → SHA1, 2 → SHA256. AWS now sends 2; we accept
  // both since 1 is still valid for older topics.
  const sigVersion = sns["SignatureVersion"];
  const algorithm = sigVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";

  let cert: string;
  try {
    cert = await (opts.certFetcher ?? defaultCertFetcher)(certUrl);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid",
      detail: `cert_fetch_failed:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const stringToSign = buildSnsStringToSign(sns);
  try {
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, "utf8");
    verifier.end();
    const valid = verifier.verify(cert, signatureB64, "base64");
    return valid
      ? { ok: true }
      : { ok: false, reason: "invalid", detail: "signature_mismatch" };
  } catch (err) {
    return {
      ok: false,
      reason: "invalid",
      detail: `verify_error:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

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
