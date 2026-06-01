// Workspace-restricted Google SSO for the operator dashboard.
// Unit coverage of the pure helpers + integration coverage of the
// gate / login / callback routes with an injected fetch.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { ManifestSigner } from "../signer.js";
import {
  type AdminAuthConfig,
  adminAuthFromEnv,
  isEmailAllowed,
  mintSession,
  mintState,
  verifySession,
  verifyState,
} from "../admin-auth.js";

const cfg: AdminAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  sessionSecret: "test-session-secret-0123456789ab",
  redirectUri: "https://admin.trustysquire.ai/admin/oauth/callback",
  allowedDomain: "trustysquire.ai",
  extraAllowedEmails: new Set(["lunchboxfortwo@gmail.com"]),
};

describe("isEmailAllowed", () => {
  it("allows the workspace domain (case-insensitive)", () => {
    expect(isEmailAllowed("dev@trustysquire.ai", cfg)).toBe(true);
    expect(isEmailAllowed("Dev@TrustySquire.ai", cfg)).toBe(true);
  });
  it("rejects a foreign domain", () => {
    expect(isEmailAllowed("someone@gmail.com", cfg)).toBe(false);
    expect(isEmailAllowed("evil@nottrustysquire.ai", cfg)).toBe(false);
  });
  it("allows an explicit break-glass address", () => {
    expect(isEmailAllowed("lunchboxfortwo@gmail.com", cfg)).toBe(true);
  });
});

describe("session token", () => {
  it("round-trips a valid, unexpired, allowed session", () => {
    const tok = mintSession("dev@trustysquire.ai", cfg);
    expect(verifySession(tok, cfg)?.email).toBe("dev@trustysquire.ai");
  });
  it("rejects an expired session", () => {
    const tok = mintSession("dev@trustysquire.ai", cfg, Date.now() - 13 * 60 * 60 * 1000);
    expect(verifySession(tok, cfg)).toBeNull();
  });
  it("rejects a tampered signature", () => {
    const tok = mintSession("dev@trustysquire.ai", cfg);
    expect(verifySession(tok.slice(0, -2) + "xx", cfg)).toBeNull();
  });
  it("rejects a session whose email is no longer allowed", () => {
    // Minted against a config that allowed the address; verified against
    // one that no longer does (allowlist entry removed).
    const permissive: AdminAuthConfig = { ...cfg, extraAllowedEmails: new Set(["x@gmail.com"]) };
    const tok = mintSession("x@gmail.com", permissive);
    const strict: AdminAuthConfig = { ...cfg, extraAllowedEmails: new Set() };
    expect(verifySession(tok, strict)).toBeNull();
  });
});

describe("state token (CSRF)", () => {
  it("accepts a fresh state and rejects an expired one", () => {
    expect(verifyState(mintState(cfg), cfg)).toBe(true);
    expect(verifyState(mintState(cfg, Date.now() - 11 * 60 * 1000), cfg)).toBe(false);
    expect(verifyState("garbage", cfg)).toBe(false);
  });
});

describe("adminAuthFromEnv", () => {
  it("returns null when unconfigured", () => {
    expect(adminAuthFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
  it("returns null when the session secret is too short", () => {
    expect(
      adminAuthFromEnv({
        ADMIN_GOOGLE_CLIENT_ID: "a",
        ADMIN_GOOGLE_CLIENT_SECRET: "b",
        ADMIN_SESSION_SECRET: "short",
        ADMIN_OAUTH_REDIRECT_URI: "https://x/cb",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
  it("builds config with a default domain + parsed allowlist", () => {
    const c = adminAuthFromEnv({
      ADMIN_GOOGLE_CLIENT_ID: "a",
      ADMIN_GOOGLE_CLIENT_SECRET: "b",
      ADMIN_SESSION_SECRET: "0123456789abcdef0123",
      ADMIN_OAUTH_REDIRECT_URI: "https://admin.trustysquire.ai/admin/oauth/callback",
      ADMIN_EXTRA_ALLOWED_EMAILS: "a@gmail.com, B@Example.com",
    } as NodeJS.ProcessEnv);
    expect(c?.allowedDomain).toBe("trustysquire.ai");
    expect(c?.extraAllowedEmails.has("b@example.com")).toBe(true);
  });
});

// ── Integration: gate + login + callback ─────────────────────────────

function fakeGoogleFetch(email: string, verified = true, hd: string | null = "trustysquire.ai"): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const u = url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });
    }
    if (u.includes("openidconnect.googleapis.com")) {
      return new Response(JSON.stringify({ email, email_verified: verified, hd }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function buildSso(opts: { email: string; verified?: boolean; bearer?: string }) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  return buildServer({
    skillStore: new InMemorySkillStore(),
    signer,
    adminAuth: cfg,
    fetchFn: fakeGoogleFetch(opts.email, opts.verified ?? true),
    ...(opts.bearer !== undefined ? { adminBearer: opts.bearer } : {}),
  });
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] ?? "" : setCookie ?? "";
  return raw.split(";")[0] ?? "";
}

describe("dashboard SSO gate", () => {
  it("redirects an unauthenticated browser to /admin/login", async () => {
    const server = await buildSso({ email: "dev@trustysquire.ai" });
    const res = await server.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("/admin/login redirects to Google with hd + client_id", async () => {
    const server = await buildSso({ email: "dev@trustysquire.ai" });
    const res = await server.inject({ method: "GET", url: "/admin/login" });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain("hd=trustysquire.ai");
    expect(loc).toContain("client_id=client-id");
  });

  it("still accepts the bearer (programmatic) alongside SSO", async () => {
    const server = await buildSso({ email: "dev@trustysquire.ai", bearer: "the-bearer" });
    const res = await server.inject({ method: "GET", url: "/admin?bearer=the-bearer" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Registry Admin");
  });

  it("callback with a workspace account sets a session that unlocks /admin", async () => {
    const server = await buildSso({ email: "dev@trustysquire.ai" });
    const state = mintState(cfg);
    const cb = await server.inject({ method: "GET", url: `/admin/oauth/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/admin");
    const cookie = cookieFrom(cb.headers["set-cookie"]);
    expect(cookie).toContain("ts_admin_session=");

    const dash = await server.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(dash.statusCode).toBe(200);
    expect(dash.body).toContain("Registry Admin");
  });

  it("callback denies a non-workspace account (403)", async () => {
    const server = await buildSso({ email: "outsider@gmail.com" });
    const state = mintState(cfg);
    const cb = await server.inject({ method: "GET", url: `/admin/oauth/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(403);
    expect(cb.body).toContain("not authorized");
  });

  it("callback rejects an invalid state (400)", async () => {
    const server = await buildSso({ email: "dev@trustysquire.ai" });
    const cb = await server.inject({ method: "GET", url: "/admin/oauth/callback?code=abc&state=forged" });
    expect(cb.statusCode).toBe(400);
  });

  it("callback denies an unverified email", async () => {
    const server = await buildSso({ email: "dev@trustysquire.ai", verified: false });
    const state = mintState(cfg);
    const cb = await server.inject({ method: "GET", url: `/admin/oauth/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(403);
  });
});
