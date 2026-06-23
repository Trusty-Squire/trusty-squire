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
  // Recipient mailbox to search when the code is sent to a Workspace
  // catch-all robot identity (e.g. verify-11@trustysquire.ai) instead
  // of the operator inbox itself.
  toAddress?: string;
  // Max seconds to wait in total. Defaults to 90s — the upper end
  // of "the email should arrive within this window".
  maxWaitSeconds?: number;
  // Optional regex override. Default is a 6-8 digit numeric code.
  otpPattern?: string;
  // 0.8.3-rc.1 — "url" returns the matched text verbatim (no digit-
  // stripping). Used by the GitHub challenge-clearing flow to fetch
  // the full verification URL from the operator's gmail.
  returnKind?: "code" | "url";
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
  const startTime = Date.now();
  const deadline = startTime + maxWait * 1000;
  let lastReason = "no_attempts";
  while (Date.now() < deadline) {
    // rc.32 — since_seconds is the elapsed time SINCE THIS POLL
    // STARTED, plus a small lead-in. Tight by design — picks up
    // only emails delivered AFTER the bot triggered the signup
    // flow. The naive 120s window in rc.27 surfaced stale codes
    // from prior attempts that were still in the inbox.
    const elapsedSeconds = Math.ceil((Date.now() - startTime) / 1000);
    const sinceSeconds = Math.max(10, elapsedSeconds + 15);
    const body = {
      since_seconds: sinceSeconds,
      ...(input.fromDomain !== undefined && input.fromDomain.length > 0
        ? { from_domain: input.fromDomain }
        : {}),
      ...(input.toAddress !== undefined && input.toAddress.length > 0
        ? { to_address: input.toAddress }
        : {}),
      ...(input.otpPattern !== undefined && input.otpPattern.length > 0
        ? { otp_pattern: input.otpPattern }
        : {}),
      ...(input.returnKind === "url" ? { return_kind: "url" } : {}),
    };
    try {
      if (input.toAddress !== undefined && input.toAddress.length > 0) {
        const workspaceRes = await fetch(`${base}/v1/inbox/poll-workspace-mail`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.machineToken}`,
          },
          body: JSON.stringify({
            to_address: input.toAddress,
            since_seconds: sinceSeconds,
          }),
        });
        if (!workspaceRes.ok) {
          lastReason = `workspace_http_${workspaceRes.status}`;
          if (workspaceRes.status === 401 || workspaceRes.status === 503) {
            return { code: null, reason: lastReason };
          }
        } else {
          const payload = (await workspaceRes.json()) as {
            email: {
              subject: string;
              body_text: string;
              body_html: string;
              parsed_codes: string[];
            } | null;
            reason?: string;
          };
          const code =
            payload.email === null
              ? null
              : pickOtpFromWorkspaceEmail(payload.email, input.toAddress);
          if (code !== null) return { code, reason: "found" };
          lastReason = payload.reason ?? "workspace_no_match";
        }
      } else {
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

function pickOtpFromWorkspaceEmail(
  email: {
    subject: string;
    body_text: string;
    body_html: string;
    parsed_codes: string[];
  },
  recipient: string,
): string | null {
  const recipientLocal = recipient.split("@")[0] ?? "";
  const recipientDigits = new Set(recipientLocal.match(/\d{4,10}/g) ?? []);
  const parsed = email.parsed_codes.find(
    (c) => /^\d{4,8}$/.test(c) && !recipientDigits.has(c),
  );
  if (parsed !== undefined) return parsed;
  const body = `${email.subject}\n${email.body_text}\n${email.body_html}`
    .split(recipient)
    .join(" ")
    .split(recipientLocal)
    .join(" ");
  const strict =
    /\b(?:code|otp|one[\s-]?time|verification|verify|pin)\b[^A-Za-z0-9]{0,50}?(\d(?:[ \-]?\d){3,7})/i.exec(
      body,
    );
  if (strict?.[1] !== undefined) {
    const cleaned = strict[1].replace(/[^0-9]/g, "");
    if (cleaned.length >= 4 && cleaned.length <= 8) return cleaned;
  }
  return null;
}

// 0.8.3-rc.1 — convenience wrapper: poll for a GitHub
// "verify it's you" / device-confirmation email and return the
// embedded verification URL. The bot navigates to that URL inside
// its current Chrome context to clear the challenge, then continues
// the OAuth flow. Pattern matches GitHub's typical
// `https://github.com/sessions/...` device-trust links.
export async function readGitHubChallengeLink(args: {
  machineToken: string;
  apiBase?: string;
  maxWaitSeconds?: number;
}): Promise<ReadOtpResult> {
  return readOperatorOtp({
    machineToken: args.machineToken,
    ...(args.apiBase !== undefined ? { apiBase: args.apiBase } : {}),
    maxWaitSeconds: args.maxWaitSeconds ?? 90,
    fromDomain: "github.com",
    // Match GitHub's verification-link patterns. The two production
    // shapes we know about:
    //   https://github.com/sessions/two-factor/.../verify?...
    //   https://github.com/users/confirm_device?...
    // Captures the full URL so the bot can navigate to it verbatim.
    otpPattern:
      "https?://github\\.com/(?:sessions|users)/[A-Za-z0-9_\\-/]*(?:confirm[_\\-]?device|verify[_\\-]?device|verify|authorize)[^\\s\"<>]*",
    returnKind: "url",
  });
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
