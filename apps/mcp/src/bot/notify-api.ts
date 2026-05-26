// Bot-side client for POST /v1/notify/heightened-auth.
//
// Used when the bot detects a time-sensitive auth challenge (today:
// Google number-match) that the user has to react to manually. The
// API resolves the bot's machine token → paired account → email and
// fires a transactional notification. The bot just hands off the
// (service, digit) pair and forgets — failures are silent because
// the stderr banner already covers the local-operator case.
//
// Auth: caller passes the machine token + apiBase explicitly. The
// MCP install path mints the token to session.json (read once at
// server boot in tools/provision-any.ts) and does NOT export it as
// an env var. rc.12 and earlier read process.env directly here and
// silently no-op'd in every install — that's the bug rc.13 fixes.
// Env fallback retained for the dev/probe harnesses (oauth-thin-slice,
// CLI direct invocations) that do set the env var.

const DEFAULT_API_BASE = "https://trusty-squire-api.fly.dev";

export interface HeightenedAuthNotification {
  service: string;
  // Stringified digit ("0".."99"). Null when the bot detected the
  // challenge but couldn't read the number — the API sends a
  // distinct "check your phone" email body in that case.
  digit: string | null;
  windowSeconds: number;
  // Auth: prefer these over env. SignupTask carries them through
  // from the MCP tools layer (provision-any.ts), which reads them
  // out of session.json. Optional only so the dev harnesses that
  // do set the env var continue to work without plumbing changes.
  machineToken?: string | undefined;
  apiBase?: string | undefined;
}

// Fire-and-forget. Returns true if the POST returned 2xx, false
// otherwise (including no-token, no-network, route 4xx/5xx). Never
// throws — caller never has to wrap in try/catch.
export async function notifyHeightenedAuth(
  input: HeightenedAuthNotification,
): Promise<boolean> {
  const token =
    input.machineToken !== undefined && input.machineToken.length > 0
      ? input.machineToken
      : process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  if (token === undefined || token.length === 0) return false;
  const base =
    input.apiBase !== undefined && input.apiBase.length > 0
      ? input.apiBase
      : (process.env.TRUSTY_SQUIRE_API_BASE ?? DEFAULT_API_BASE);
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
