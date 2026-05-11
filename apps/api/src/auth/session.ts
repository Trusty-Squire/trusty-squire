// Web session management.
//
// Session model (per chunk-10 answers):
//   - JWT in HTTP-only cookie, HS256 signed
//   - Idle expiry: 15min from last activity, refreshed each authed request
//   - Absolute expiry: 8h hard cap from issuance
//   - jti looked up in Session table on every authed request to support
//     revocation without invalidating the cookie format
//
// Agent sessions are a separate concern — see agent.ts.

import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { ulid } from "ulid";

const HEADER = { alg: "HS256", typ: "JWT" };

export interface SessionStore {
  insert(record: SessionRecord): Promise<void>;
  findActive(jwtId: string, now: Date): Promise<SessionRecord | null>;
  touch(jwtId: string, lastActiveAt: Date): Promise<void>;
  revoke(jwtId: string, reason: string): Promise<void>;
}

export interface SessionRecord {
  id: string;
  account_id: string;
  jwt_id: string;
  issued_at: Date;
  last_active_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

export const SESSION_COOKIE_NAME = "ts_session";
export const SESSION_IDLE_MS = 15 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

export interface SessionJwtPayload {
  jti: string;
  sub: string; // account_id
  iat: number;
  exp: number; // absolute expiry; idle check is server-side
}

// Sign a session JWT. Used at login time + after refresh.
export function signSessionJwt(payload: SessionJwtPayload, secret: string): string {
  const header = base64url(JSON.stringify(HEADER));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64url(sig)}`;
}

export function verifySessionJwt(token: string, secret: string): SessionJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (header === undefined || body === undefined || sig === undefined) return null;
  const expected = base64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const decoded = JSON.parse(base64urlDecode(body).toString("utf8")) as SessionJwtPayload;
    if (typeof decoded.jti !== "string" || typeof decoded.sub !== "string") return null;
    return decoded;
  } catch {
    return null;
  }
}

export function issueSession(input: {
  account_id: string;
  ip: string | null;
  user_agent: string | null;
  now: Date;
}): { record: SessionRecord; jwt: SessionJwtPayload } {
  const jti = ulid();
  const id = ulid();
  const absoluteExpiresAt = new Date(input.now.getTime() + SESSION_ABSOLUTE_MS);
  const record: SessionRecord = {
    id,
    account_id: input.account_id,
    jwt_id: jti,
    issued_at: input.now,
    last_active_at: input.now,
    absolute_expires_at: absoluteExpiresAt,
    revoked_at: null,
    revocation_reason: null,
    ip: input.ip,
    user_agent: input.user_agent,
  };
  const jwt: SessionJwtPayload = {
    jti,
    sub: input.account_id,
    iat: Math.floor(input.now.getTime() / 1000),
    exp: Math.floor(absoluteExpiresAt.getTime() / 1000),
  };
  return { record, jwt };
}

// Determines whether a Session row is still valid given the current
// time. Returns null when the session is healthy, or a reason string
// when it's not. Callers MUST reject the session when this returns
// non-null.
export function sessionRejectionReason(
  record: SessionRecord,
  now: Date,
): null | "revoked" | "absolute_expired" | "idle_expired" {
  if (record.revoked_at !== null) return "revoked";
  if (now > record.absolute_expires_at) return "absolute_expired";
  if (now.getTime() - record.last_active_at.getTime() > SESSION_IDLE_MS) return "idle_expired";
  return null;
}

// ── In-memory store for tests ────────────────────────────────

export class InMemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRecord>();

  async insert(record: SessionRecord): Promise<void> {
    this.rows.set(record.jwt_id, { ...record });
  }

  async findActive(jwtId: string, now: Date): Promise<SessionRecord | null> {
    const r = this.rows.get(jwtId);
    if (r === undefined) return null;
    return sessionRejectionReason(r, now) === null ? { ...r } : null;
  }

  async touch(jwtId: string, lastActiveAt: Date): Promise<void> {
    const r = this.rows.get(jwtId);
    if (r === undefined) return;
    r.last_active_at = lastActiveAt;
  }

  async revoke(jwtId: string, reason: string): Promise<void> {
    const r = this.rows.get(jwtId);
    if (r === undefined) return;
    r.revoked_at = new Date();
    r.revocation_reason = reason;
  }
}

// ── base64url helpers ───────────────────────────────────────

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
