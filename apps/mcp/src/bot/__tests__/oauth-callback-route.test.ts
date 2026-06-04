// isOAuthCallbackRoute — adaptive hydration patience on OAuth/SSO callback
// routes. MEASURED 2026-06-04 (clerk): its `/sign-in/sso-callback` token
// exchange renders even slower than its dashboard, so the post-verify loop
// grants callback routes 12x3s = 36s of hydration patience instead of 6x3s.

import { describe, expect, it } from "vitest";
import { isOAuthCallbackRoute } from "../agent.js";

describe("isOAuthCallbackRoute", () => {
  it("matches clerk's SSO callback route", () => {
    expect(isOAuthCallbackRoute("https://dashboard.clerk.com/sign-in/sso-callback?x=1")).toBe(
      true,
    );
  });

  it("matches /oauth/callback", () => {
    expect(isOAuthCallbackRoute("https://x.io/oauth/callback")).toBe(true);
  });

  it("matches /auth/callback", () => {
    expect(isOAuthCallbackRoute("https://x.io/auth/callback")).toBe(true);
  });

  it("does NOT match a plain sign-in route", () => {
    expect(isOAuthCallbackRoute("https://x.io/sign-in")).toBe(false);
  });

  it("does NOT match a dashboard route", () => {
    expect(isOAuthCallbackRoute("https://x.io/dashboard")).toBe(false);
  });

  it("returns false for a malformed URL", () => {
    expect(isOAuthCallbackRoute("not a url")).toBe(false);
  });
});
