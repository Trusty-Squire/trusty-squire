// Short-lived, signed "upgrade token" for the pre-authenticated checkout link.
//
// At the paywall (402) the caller is an account-bound machine token, so the API
// already knows who they are. We mint a 15-minute HS256 token scoped to
// billing-checkout and put it in the cta_billing_url (`/upgrade?t=…`). The
// /upgrade page exchanges it for a Stripe Checkout session WITHOUT a separate
// browser OAuth login — collapsing "open browser → log in → pay" to one click.
//
// Same HMAC scheme as the session JWT (auth/session.ts), but a distinct scope
// claim so an upgrade token can never be used as a session cookie or vice
// versa. Short TTL is the security boundary; single-use is a later hardening.

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = { alg: "HS256", typ: "JWT" };
const TTL_SECONDS = 15 * 60;
const SCOPE = "billing-checkout";

interface UpgradeTokenPayload {
  sub: string; // account_id
  scope: string;
  iat: number;
  exp: number;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function mintUpgradeToken(accountId: string, secret: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: UpgradeTokenPayload = { sub: accountId, scope: SCOPE, iat, exp: iat + TTL_SECONDS };
  const data = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

// Returns the account_id for a valid, unexpired billing-checkout token; null on
// any failure (bad shape, bad signature, wrong scope, expired).
export function verifyUpgradeToken(token: string, secret: string, nowMs: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (header === undefined || body === undefined || sig === undefined) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  const presented = Buffer.from(sig, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UpgradeTokenPayload;
    if (decoded.scope !== SCOPE || typeof decoded.sub !== "string") return null;
    if (typeof decoded.exp !== "number" || decoded.exp * 1000 < nowMs) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}
