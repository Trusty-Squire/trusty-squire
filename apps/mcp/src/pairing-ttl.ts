// Pairing-token lifetime is a contract with the API (`PAIR_TTL_MS` in
// apps/api/src/auth/pairing-token.ts). Connect counts the ceremony wait as
// this duration from the initiate response — never by differencing the
// server's expires_at against this machine's clock.
//
// The login-rig owned lifetime is the same window plus a short grace so the
// normal poll/teardown always finishes first. The grace is a backstop
// margin, not a second product timeout, and neither value is configurable:
// a rig bound that could be widened or collapsed from the environment is not
// a bound.

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
export const LOGIN_RIG_LIFETIME_GRACE_MS = 60 * 1000;
export const LOGIN_RIG_OWNED_LIFETIME_MS = PAIRING_TOKEN_TTL_MS + LOGIN_RIG_LIFETIME_GRACE_MS;
