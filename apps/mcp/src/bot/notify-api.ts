// Bot-side client for POST /v1/notify/heightened-auth.
//
// Used when the bot detects a time-sensitive auth challenge (today:
// Google number-match) that the user has to react to manually. The
// API resolves the bot's machine token → paired account → email and
// fires a transactional notification. The bot just hands off the
// (service, digit) pair and forgets — failures are silent because
// the stderr banner already covers the local-operator case.
//
// Configuration:
//   TRUSTY_SQUIRE_MACHINE_TOKEN — required; no-op without it.
//   TRUSTY_SQUIRE_API_BASE      — defaults to the production API.

const DEFAULT_API_BASE = "https://trusty-squire-api.fly.dev";

export interface HeightenedAuthNotification {
  service: string;
  // Stringified digit ("0".."99"). Null when the bot detected the
  // challenge but couldn't read the number — the API sends a
  // distinct "check your phone" email body in that case.
  digit: string | null;
  windowSeconds: number;
}

// Fire-and-forget. Returns true if the POST returned 2xx, false
// otherwise (including no-token, no-network, route 4xx/5xx). Never
// throws — caller never has to wrap in try/catch.
export async function notifyHeightenedAuth(
  input: HeightenedAuthNotification,
): Promise<boolean> {
  const token = process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  if (token === undefined || token.length === 0) return false;
  const base = process.env.TRUSTY_SQUIRE_API_BASE ?? DEFAULT_API_BASE;
  try {
    const res = await fetch(`${base}/v1/notify/heightened-auth`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        service: input.service,
        digit: input.digit,
        window_seconds: input.windowSeconds,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
