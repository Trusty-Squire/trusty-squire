// Workspace-restricted Google SSO for the operator dashboard.
//
// Self-contained: the registry deploys independently from apps/api, so
// the small Google OAuth bits are replicated here rather than shared
// across a package boundary. Sessions + CSRF state are HMAC-signed with
// ADMIN_SESSION_SECRET — no cookie/jwt dependency.
//
// The actual org restriction is enforced two ways: (1) the Google OAuth
// client should be configured "Internal" to the Workspace (Google gates
// at the IdP), and (2) server-side we require email_verified AND that
// the email is on the allowed domain (or an explicit break-glass
// allowlist). Belt and braces.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export const ADMIN_COOKIE = "ts_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const STATE_TTL_MS = 10 * 60 * 1000; // 10m

export interface AdminAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  redirectUri: string;
  allowedDomain: string; // e.g. "trustysquire.ai"
  extraAllowedEmails: Set<string>; // break-glass, lowercased
}

// Build config from env; null when SSO isn't configured (the dashboard
// then falls back to bearer-only, preserving the pre-SSO behavior).
export function adminAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig | null {
  const clientId = env.ADMIN_GOOGLE_CLIENT_ID;
  const clientSecret = env.ADMIN_GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.ADMIN_SESSION_SECRET;
  const redirectUri = env.ADMIN_OAUTH_REDIRECT_URI;
  if (
    clientId === undefined || clientId.length === 0 ||
    clientSecret === undefined || clientSecret.length === 0 ||
    sessionSecret === undefined || sessionSecret.length < 16 ||
    redirectUri === undefined || redirectUri.length === 0
  ) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    sessionSecret,
    redirectUri,
    allowedDomain: (env.ADMIN_ALLOWED_DOMAIN ?? "trustysquire.ai").toLowerCase(),
    extraAllowedEmails: new Set(
      (env.ADMIN_EXTRA_ALLOWED_EMAILS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  };
}

export function isEmailAllowed(email: string, cfg: AdminAuthConfig): boolean {
  const e = email.toLowerCase();
  if (cfg.extraAllowedEmails.has(e)) return true;
  return e.endsWith(`@${cfg.allowedDomain}`);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// <b64url(json)>.<sig> token helpers, shared by session + state.
function mintToken(obj: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}
function openToken(token: string | undefined, secret: string): Record<string, unknown> | null {
  if (token === undefined) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEq(sig, sign(body, secret))) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function mintSession(email: string, cfg: AdminAuthConfig, now: number = Date.now()): string {
  return mintToken({ email: email.toLowerCase(), exp: now + SESSION_TTL_MS }, cfg.sessionSecret);
}

// Returns the session email when the cookie is valid, unexpired, AND the
// email is still allowed (so removing a domain/allowlist entry kills live
// sessions on the next request).
export function verifySession(
  token: string | undefined,
  cfg: AdminAuthConfig,
  now: number = Date.now(),
): { email: string } | null {
  const claims = openToken(token, cfg.sessionSecret);
  if (claims === null) return null;
  const { email, exp } = claims;
  if (typeof email !== "string" || typeof exp !== "number" || exp < now) return null;
  if (!isEmailAllowed(email, cfg)) return null;
  return { email };
}

export function mintState(cfg: AdminAuthConfig, now: number = Date.now()): string {
  return mintToken({ n: randomBytes(12).toString("base64url"), exp: now + STATE_TTL_MS }, cfg.sessionSecret);
}

export function verifyState(state: string | undefined, cfg: AdminAuthConfig, now: number = Date.now()): boolean {
  const claims = openToken(state, cfg.sessionSecret);
  if (claims === null) return false;
  return typeof claims.exp === "number" && claims.exp >= now;
}

export function buildGoogleAuthorizeUrl(cfg: AdminAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    // Workspace hint — also enforced server-side + by an Internal client.
    hd: cfg.allowedDomain,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTHORIZE}?${params.toString()}`;
}

// Exchange the code and fetch the verified identity. fetchFn is
// injectable for tests.
export async function exchangeAndIdentify(
  cfg: AdminAuthConfig,
  code: string,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<{ email: string; emailVerified: boolean; hd: string | null }> {
  const tokenRes = await fetchFn(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token_exchange_failed_${tokenRes.status}`);
  const tj = (await tokenRes.json()) as { access_token?: string };
  if (typeof tj.access_token !== "string" || tj.access_token.length === 0) {
    throw new Error("token_exchange_no_token");
  }
  const uiRes = await fetchFn(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${tj.access_token}` },
  });
  if (!uiRes.ok) throw new Error(`userinfo_failed_${uiRes.status}`);
  const u = (await uiRes.json()) as { email?: string; email_verified?: boolean; hd?: string };
  if (typeof u.email !== "string") throw new Error("userinfo_no_email");
  return { email: u.email.toLowerCase(), emailVerified: u.email_verified === true, hd: u.hd ?? null };
}

// ── Cookie wire helpers (no @fastify/cookie dependency) ──────────────

export function buildSetCookie(value: string, maxAgeMs: number): string {
  return [
    `${ADMIN_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax", // Lax so the OAuth redirect GET still carries it
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ].join("; ");
}

export function clearCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === ADMIN_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export const ADMIN_SESSION_TTL_MS = SESSION_TTL_MS;
