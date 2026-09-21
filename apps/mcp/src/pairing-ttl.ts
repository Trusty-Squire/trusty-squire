// Pairing-token lifetime is a contract with the API (`PAIR_TTL_MS` in
// apps/api/src/auth/pairing-token.ts). Connect counts the ceremony wait as
// this duration from the initiate response — never by differencing the
// server's expires_at against this machine's clock.
//
// The login-rig owned lifetime is the same window plus a short grace so the
// normal poll/teardown always finishes first. The grace is a backstop
// margin, not a second product timeout.

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
export const LOGIN_RIG_LIFETIME_GRACE_MS = 60 * 1000;
export const LOGIN_RIG_OWNED_LIFETIME_MS = PAIRING_TOKEN_TTL_MS + LOGIN_RIG_LIFETIME_GRACE_MS;

export function loginRigOwnedLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTY_SQUIRE_LOGIN_RIG_LIFETIME_MS?.trim();
  if (raw === undefined || raw === "") return LOGIN_RIG_OWNED_LIFETIME_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return LOGIN_RIG_OWNED_LIFETIME_MS;
  return parsed;
}
