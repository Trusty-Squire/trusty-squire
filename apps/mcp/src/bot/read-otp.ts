// Bot-side client for POST /v1/inbox/poll-operator-otp.
//
// Fires from agent.ts's email_otp_required gate (rc.24) — instead
// of aborting, the bot asks the API to read the operator's gmail
// inbox via IMAP for the verification code, then submits it. Best-
// effort: failures degrade to the prior abort behavior. Polls a few
// times with backoff because services occasionally take 5-15s to
// actually dispatch the email after the OAuth callback completes.

export interface ReadOtpInput {
  // Machine token to authenticate against the API.
  machineToken: string;
  // Trusty Squire API base. Defaults to the production host when
  // unset.
  apiBase?: string;
  // Restrict by sender domain (e.g. "porter.run"). The bot derives
  // this from the current page's hostname.
  fromDomain?: string;
  // Max seconds to wait in total. Defaults to 90s — the upper end
  // of "the email should arrive within this window".
  maxWaitSeconds?: number;
  // Optional regex override. Default is a 6-8 digit numeric code.
  otpPattern?: string;
}

export interface ReadOtpResult {
  code: string | null;
  // Telemetry string for the step trail. Never includes the digits.
  reason: string;
}

const DEFAULT_API_BASE = "https://trusty-squire-api.fly.dev";
const POLL_INTERVAL_MS = 5_000;

// Poll the API for the latest OTP from the operator's gmail. Returns
// the matched code, or null when no message arrived in the window /
// the IMAP call failed. Never throws.
export async function readOperatorOtp(
  input: ReadOtpInput,
): Promise<ReadOtpResult> {
  if (input.machineToken === undefined || input.machineToken.length === 0) {
    return { code: null, reason: "no_machine_token" };
  }
  const base =
    input.apiBase !== undefined && input.apiBase.length > 0
      ? input.apiBase
      : DEFAULT_API_BASE;
  const maxWait =
    input.maxWaitSeconds !== undefined ? input.maxWaitSeconds : 90;
  const deadline = Date.now() + maxWait * 1000;
  let lastReason = "no_attempts";
  while (Date.now() < deadline) {
    const remaining = Math.max(
      10,
      Math.ceil((deadline - Date.now()) / 1000),
    );
    const body = {
      // Bound the inbox-search window to the time since this call
      // started (plus a small lead-in for the email to actually
      // land). Avoids picking up an unrelated stale OTP.
      since_seconds: Math.min(120, remaining + 30),
      ...(input.fromDomain !== undefined && input.fromDomain.length > 0
        ? { from_domain: input.fromDomain }
        : {}),
      ...(input.otpPattern !== undefined && input.otpPattern.length > 0
        ? { otp_pattern: input.otpPattern }
        : {}),
    };
    try {
      const res = await fetch(`${base}/v1/inbox/poll-operator-otp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.machineToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastReason = `http_${res.status}`;
        if (res.status === 401 || res.status === 503) {
          // 401: bad token (won't fix on retry). 503: gmail not
          // configured on the server (won't fix on retry).
          return { code: null, reason: lastReason };
        }
      } else {
        const payload = (await res.json()) as {
          code: string | null;
          reason?: string;
        };
        if (payload.code !== null && payload.code !== undefined) {
          return { code: payload.code, reason: "found" };
        }
        lastReason = payload.reason ?? "no_match";
      }
    } catch (err) {
      lastReason = `network_${err instanceof Error ? err.message : String(err)}`;
    }
    // Sleep before the next poll attempt unless we'd blow the budget.
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { code: null, reason: lastReason };
}

// Best-effort extraction of a from-domain from a URL. Returns the
// hostname's eTLD+1-ish chunk (last two labels). Used as the
// from_domain filter so a Porter signup doesn't pick up a Koyeb code.
export function fromDomainFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".").filter((p) => p.length > 0);
    if (parts.length < 2) return null;
    // Two-label suffix handles porter.run, koyeb.com, etc. Doesn't
    // try to handle .co.uk-style multi-part TLDs — Porter and Koyeb
    // are plain two-label domains and that's the dominant case for
    // the WorkOS OTP flow.
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}
