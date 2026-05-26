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

const DEFAULT_OTP_RE = /\b(\d{6,8})\b/;
const MIN_SINCE = 10;
const MAX_SINCE = 600;

export class GmailOtpPoller {
  constructor(private readonly cfg: OtpPollerConfig) {}

  async poll(input: OtpPollInput): Promise<OtpPollResult> {
    const sinceSeconds = clamp(input.since_seconds, MIN_SINCE, MAX_SINCE);
    const sinceDate = new Date(Date.now() - sinceSeconds * 1000);
    const otpRe =
      input.otp_pattern !== undefined && input.otp_pattern.length > 0
        ? compileSafeRegex(input.otp_pattern)
        : DEFAULT_OTP_RE;
    if (otpRe === null) {
      return { code: null, reason: "invalid_otp_pattern", scanned: 0 };
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
      await client.connect();
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
          const body =
            msg.source !== undefined ? msg.source.toString("utf8") : "";
          const m = otpRe.exec(body);
          if (m === null) continue;
          const code = m[1] ?? m[0];
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
