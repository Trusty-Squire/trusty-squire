// Inbound-mail webhook signature verification.
//
// None of the inbound-mail webhooks used to verify the sender. An
// attacker who can POST to /v1/webhooks/* can forge an email; the bot
// then reads parsed_codes/parsed_links off the stored row to complete a
// signup, so a forged email can inject a verification code or link.
//
// Each provider signs differently:
//   - SES   — SNS message signature against the AWS SNS signing cert
//   - Mailgun — HMAC-SHA256 of (timestamp + token)
//   - Resend  — Svix HMAC-SHA256 over `${id}.${timestamp}.${body}`
//
// Fail-closed: when a required secret is missing the caller rejects the
// request (503/500) and logs loudly — never silently accept.

import { Buffer } from "node:buffer";
import { createHmac, createVerify, timingSafeEqual } from "node:crypto";

// ── Result type ──────────────────────────────────────────────

export type VerifyResult =
  | { ok: true }
  // `not_configured` → the required secret env var is missing; the
  // caller must fail-closed (503) and log. `invalid` → a real forgery
  // or replay; caller returns 401.
  | { ok: false; reason: "not_configured" | "invalid"; detail: string };

// Constant-time compare for two equal-length byte strings.
function timingSafeStrEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

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

// ── Mailgun ──────────────────────────────────────────────────

// Mailgun signs inbound webhooks: HMAC-SHA256 of `timestamp + token`
// with the webhook signing key, hex-encoded.
export function verifyMailgunSignature(input: {
  timestamp: string;
  token: string;
  signature: string;
  signingKey: string | undefined;
}): VerifyResult {
  if (input.signingKey === undefined || input.signingKey.length === 0) {
    return {
      ok: false,
      reason: "not_configured",
      detail: "MAILGUN_WEBHOOK_SIGNING_KEY not set",
    };
  }
  if (
    input.timestamp.length === 0 ||
    input.token.length === 0 ||
    input.signature.length === 0
  ) {
    return { ok: false, reason: "invalid", detail: "missing_signature_fields" };
  }
  const expected = createHmac("sha256", input.signingKey)
    .update(input.timestamp + input.token)
    .digest("hex");
  return timingSafeStrEquals(expected, input.signature.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: "invalid", detail: "signature_mismatch" };
}

// ── Resend (Svix) ────────────────────────────────────────────

// Resend delivers webhooks via Svix. Svix signs `${id}.${timestamp}.${body}`
// with HMAC-SHA256; the secret is base64 after the `whsec_` prefix. The
// `svix-signature` header may carry multiple space-separated `v1,<sig>`
// entries — any match is accepted.
export function verifySvixSignature(input: {
  svixId: string | undefined;
  svixTimestamp: string | undefined;
  svixSignature: string | undefined;
  rawBody: string;
  secret: string | undefined;
}): VerifyResult {
  if (input.secret === undefined || input.secret.length === 0) {
    return {
      ok: false,
      reason: "not_configured",
      detail: "RESEND_WEBHOOK_SECRET not set",
    };
  }
  if (
    input.svixId === undefined ||
    input.svixTimestamp === undefined ||
    input.svixSignature === undefined
  ) {
    return { ok: false, reason: "invalid", detail: "missing_svix_headers" };
  }

  // The secret is `whsec_<base64>`; the HMAC key is the decoded base64.
  const secretBody = input.secret.startsWith("whsec_")
    ? input.secret.slice("whsec_".length)
    : input.secret;
  const key = Buffer.from(secretBody, "base64");

  const signedContent = `${input.svixId}.${input.svixTimestamp}.${input.rawBody}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");

  // `svix-signature` is space-separated `v1,<base64sig>` entries.
  for (const entry of input.svixSignature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1) continue;
    const presented = entry.slice(comma + 1);
    if (timingSafeStrEquals(expected, presented)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "invalid", detail: "signature_mismatch" };
}
