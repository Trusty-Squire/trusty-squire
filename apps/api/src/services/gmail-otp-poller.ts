// Gmail OTP poller — reads OTP codes from the operator's gmail
// inbox for the bot's email_otp_required gate (rc.24).
//
// Background: services like Porter, Koyeb (both WorkOS-backed) send
// a 6-8 digit verification code to the OAuth-bound email — which on
// the harvester's setup is lunchboxfortwo@gmail.com (the operator
// gmail). The bot previously aborted at this gate because it had no
// way to read user-bound mail. This poller closes the loop: an
// authenticated IMAP session over the existing GMAIL_USER /
// GMAIL_APP_PASSWORD secret extracts the code, the bot fills it,
// the signup proceeds.
//
// Auth: Gmail still supports IMAP via app passwords when 2FA is on
// (Aug 2025 — they deprecated basic-auth for less-secure-apps but
// kept it for app-password flows). Same credential the nodemailer
// SMTP path used; no extra setup needed.
//
// Scope: bot-internal. Endpoint authenticates with a machine token;
// the operator never invokes it directly. Best-effort — failures
// degrade to the prior abort behavior.

import { ImapFlow } from "imapflow";

export interface OtpPollerConfig {
  gmailUser: string;
  gmailAppPassword: string;
}

export interface OtpPollInput {
  // Restrict by sender domain (e.g. "porter.run") so a Porter signup
  // doesn't pick up an unrelated 6-digit code from elsewhere. When
  // unset, matches any sender — risky, only useful in tests.
  from_domain?: string;
  // Only consider messages received within the last N seconds.
  // Bounded server-side to [10, 600] so a stale OTP from yesterday
  // never gets used and so a misconfigured caller can't sweep the
  // entire inbox.
  since_seconds: number;
  // Regex the OTP should match. Defaults to a 6-digit numeric code,
  // the dominant shape. Use a custom pattern for services that send
  // 8-digit / alphanumeric codes.
  otp_pattern?: string;
  // 0.8.3-rc.1 — "url" returns the matched text verbatim (no digit-
  // stripping); the GitHub challenge-clearing flow needs the full
  // verification URL.
  return_kind?: "code" | "url";
}

export interface OtpPollResult {
  code: string | null;
  // When code is null, a brief reason for telemetry.
  reason: string;
  // The number of candidate messages the poller examined. Helps
  // debug "no_match" — if scanned=0 the inbox is empty or the
  // since-window is too tight.
  scanned: number;
}

// rc.30 — keyword-anchored OTP search. The naive /\b(\d{6,8})\b/ in
// rc.27 picked up the first run of 6-8 digits in the email body —
// which on Porter's email was a date timestamp (e.g. "Sent
// 2026-06-05") concatenated to "20260605", not the actual code.
// Real OTP emails always introduce the code with text like "Your
// verification code is:" or "Enter this code:". Anchor the search
// there, falling back to the naive pattern only as a last resort.
//
// Two passes:
//   1. Strict — explicit OTP keyword + colon/dash/whitespace + 6-8
//      digit-or-space token (some services render "1 2 3 4 5 6"
//      with single-character spacing for readability).
//   2. Fallback — any \b\d{6,8}\b that doesn't look like a year
//      (1900-2100) or a year-date prefix (2020xxxx, 2026xxxx).
const STRICT_OTP_RE =
  /\b(?:code|otp|one[\s-]?time|verification|verify|pin)\b[^A-Za-z0-9]{0,50}?(\d(?:[ \-]?\d){5,7})/i;
const FALLBACK_OTP_RE = /\b(\d{6,8})\b/g;
function isDateLikeNumeric(s: string): boolean {
  // 19xx-20xx years (4 chars) or YYYYMMDD-shaped 8-digit values
  // beginning with a plausible year prefix.
  if (s.length === 4 && /^(19|20)\d{2}$/.test(s)) return true;
  if (s.length === 8 && /^(19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(s)) return true;
  return false;
}
// Exported for unit testing — the extractor is the load-bearing
// regression-risk piece of the poller. Tests pin the strict +
// fallback + date-rejection paths.
export function extractOtp(
  body: string,
  customRe: RegExp | null = null,
  returnKind: "code" | "url" = "code",
): string | null {
  if (customRe !== null) {
    const m = customRe.exec(body);
    if (m === null) return null;
    const matched = m[1] ?? m[0];
    // 0.8.3-rc.1 — when the caller wants a URL (GitHub "verify it's
    // you" device-confirmation links), return the match verbatim.
    // The default `code` mode digit-strips for OTP polling.
    if (returnKind === "url") return matched;
    return matched.replace(/[^0-9]/g, "");
  }
  // Strict pass.
  const strict = STRICT_OTP_RE.exec(body);
  if (strict !== null && strict[1] !== undefined) {
    const cleaned = strict[1].replace(/[^0-9]/g, "");
    if (cleaned.length >= 4 && cleaned.length <= 10) return cleaned;
  }
  // Fallback — first non-date-looking 6-8 digit run.
  for (const m of body.matchAll(FALLBACK_OTP_RE)) {
    const candidate = m[1] ?? m[0];
    if (!isDateLikeNumeric(candidate)) return candidate;
  }
  return null;
}
const MIN_SINCE = 10;
const MAX_SINCE = 600;

export class GmailOtpPoller {
  constructor(private readonly cfg: OtpPollerConfig) {}

  async poll(input: OtpPollInput): Promise<OtpPollResult> {
    const sinceSeconds = clamp(input.since_seconds, MIN_SINCE, MAX_SINCE);
    const sinceDate = new Date(Date.now() - sinceSeconds * 1000);
    let customRe: RegExp | null = null;
    if (input.otp_pattern !== undefined && input.otp_pattern.length > 0) {
      customRe = compileSafeRegex(input.otp_pattern);
      if (customRe === null) {
        return { code: null, reason: "invalid_otp_pattern", scanned: 0 };
      }
    }

    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: this.cfg.gmailUser,
        pass: this.cfg.gmailAppPassword,
      },
      // Keep noisy info-level logs off — failures still go through.
      logger: false,
    });

    let scanned = 0;
    try {
      // Connect/auth is wrapped separately so an expired or revoked Gmail app
      // password surfaces as a CLEAR `imap_auth_failed` reason instead of an
      // opaque `imap_error:Command failed` (MEASURED 2026-06-09: a cold poll
      // returned "Command failed" with scanned:0 — the IMAP login was failing
      // before any search, i.e. the GMAIL_APP_PASSWORD secret was stale, which
      // silently blocked every Google-OAuth email-OTP signup, e.g. anthropic).
      try {
        await client.connect();
      } catch (connErr) {
        return {
          code: null,
          reason: `imap_auth_failed:${connErr instanceof Error ? connErr.message : String(connErr)} — rotate GMAIL_APP_PASSWORD`,
          scanned: 0,
        };
      }
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Server-side filter: SINCE <date>. Gmail's IMAP search
        // sometimes returns dates at day granularity, so we
        // intersect with a client-side timestamp check below.
        const searchResult = await client.search(
          { since: sinceDate },
          { uid: true },
        );
        const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
        if (uids.length === 0) {
          return { code: null, reason: "no_recent_messages", scanned: 0 };
        }
        // Walk newest first so we return the latest matching code.
        uids.sort((a, b) => b - a);
        for (const uid of uids.slice(0, 50)) {
          scanned += 1;
          const msg = await client.fetchOne(
            String(uid),
            {
              envelope: true,
              source: true,
              internalDate: true,
            },
            { uid: true },
          );
          if (msg === false || msg === null) continue;
          if (msg.internalDate !== undefined) {
            const ts =
              msg.internalDate instanceof Date
                ? msg.internalDate.getTime()
                : new Date(msg.internalDate).getTime();
            if (Number.isFinite(ts) && ts < sinceDate.getTime()) continue;
          }
          if (input.from_domain !== undefined && input.from_domain.length > 0) {
            const fromAddrs = msg.envelope?.from ?? [];
            const matched = fromAddrs.some((f) => {
              const addr = (f.address ?? "").toLowerCase();
              return addr.endsWith(`@${input.from_domain!.toLowerCase()}`);
            });
            if (!matched) continue;
          }
          const raw =
            msg.source !== undefined ? msg.source.toString("utf8") : "";
          // Strip the MIME envelope's header block — every digit-shaped
          // value in there (Date, Message-ID, Received timestamps,
          // boundary nonces) outranks the actual OTP under a naive
          // first-match scan. Headers end at the first blank line per
          // RFC 5322; if there's no blank line (malformed message),
          // fall back to the full source.
          const headerEnd = raw.search(/\r?\n\r?\n/);
          const bodyOnly = headerEnd >= 0 ? raw.slice(headerEnd + 2) : raw;
          const code = extractOtp(
            decodeMimeBody(bodyOnly),
            customRe,
            input.return_kind ?? "code",
          );
          if (code === null) continue;
          return { code, reason: "found", scanned };
        }
        return { code: null, reason: "no_match", scanned };
      } finally {
        lock.release();
      }
    } catch (err) {
      return {
        code: null,
        reason: `imap_error:${err instanceof Error ? err.message : String(err)}`,
        scanned,
      };
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Best-effort MIME body decoding. Real-world OTP emails arrive as
// quoted-printable or base64 inside multipart envelopes; the actual
// readable text (with the code keyword + digits) is unreachable
// without decoding. We don't pull in a full MIME parser — that's
// overkill for the 90% case of WorkOS-style transactional emails.
// Instead:
//   1. Decode quoted-printable (=XX hex escapes) inline. WorkOS,
//      Porter, Koyeb all send their text/plain part QP-encoded.
//   2. Decode any base64-encoded blocks that LOOK isolated and
//      decodable to plausible ASCII (skip binary attachments).
//   3. Strip HTML tags so an HTML-only multipart yields searchable
//      text.
// Exported for unit testing.
export function decodeMimeBody(body: string): string {
  // Quoted-printable: =XX → byte, =<eol> → soft line break (drop).
  let out = body.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  out = out.replace(/=\r?\n/g, "");
  // Base64 chunks: bodies of multipart parts often arrive as one or
  // more long base64-only runs (no spaces) optionally separated by
  // CRLFs. Decode each substantial run (>=60 chars) and append its
  // decoded text. Best-effort: if decoding yields mostly non-
  // printable bytes (a binary attachment), skip the result.
  for (const m of out.matchAll(/[A-Za-z0-9+/]{40,}={0,2}(?:\r?\n[A-Za-z0-9+/]{40,}={0,2})*/g)) {
    const chunk = m[0].replace(/\s+/g, "");
    if (chunk.length < 60) continue;
    try {
      const decoded = Buffer.from(chunk, "base64").toString("utf8");
      const nonPrintable = decoded.replace(/[\x09\x0A\x0D\x20-\x7E]/g, "");
      if (nonPrintable.length < decoded.length * 0.1) {
        out += "\n" + decoded;
      }
    } catch {
      // Not real base64 — ignore.
    }
  }
  // 0.8.3-rc.1 — extract href URLs BEFORE stripping HTML tags. A
  // `<a href="https://github.com/...">` element has its URL inside
  // the attribute; the tag-strip pass below replaces the whole tag
  // (attributes and all) with a space, so the URL is lost. The
  // GitHub-challenge auto-clear path needs to find the URL — append
  // each extracted href to the body so it survives the strip.
  const hrefMatches = Array.from(
    out.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi),
  );
  for (const m of hrefMatches) {
    out += "\n" + m[1];
  }
  // Strip HTML tags so HTML-only multipart parts contribute their
  // text to the scan. Replace with spaces so digits across tag
  // boundaries don't fuse.
  out = out.replace(/<[^>]+>/g, " ");
  return out;
}

// Compile a user-supplied regex, refusing patterns that look like
// catastrophic backtracking risks. Returns null on failure.
function compileSafeRegex(pattern: string): RegExp | null {
  if (pattern.length > 200) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
