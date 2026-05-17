// Covers the pure environment helpers in google-login.ts (T2). The
// login orchestration itself spawns real processes (Xvfb, x11vnc,
// cloudflared) and is validated by running it, not unit-tested — these
// are the deterministic pieces that can be.

import { describe, expect, it } from "vitest";
import {
  binaryOnPath,
  classifyGoogleAuthState,
  findFreePort,
  hasDisplay,
} from "../google-login.js";

describe("google-login env helpers", () => {
  it("binaryOnPath finds a real binary and rejects a fake one", () => {
    expect(binaryOnPath("sh")).toBe(true);
    expect(binaryOnPath("definitely-not-a-real-binary-xyz123")).toBe(false);
  });

  it("findFreePort returns a usable TCP port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("hasDisplay honors the force-headless override", () => {
    const saved = process.env.TRUSTY_SQUIRE_FORCE_HEADLESS;
    process.env.TRUSTY_SQUIRE_FORCE_HEADLESS = "true";
    try {
      expect(hasDisplay()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TRUSTY_SQUIRE_FORCE_HEADLESS;
      else process.env.TRUSTY_SQUIRE_FORCE_HEADLESS = saved;
    }
  });
});

describe("classifyGoogleAuthState (T5)", () => {
  it("detects the OAuth consent screen", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/signin/oauth/consent?client_id=x",
        "Render wants access to your Google Account",
      ),
    ).toBe("consent");
  });

  it("classifies a Google login page as needs_login", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/v3/signin/identifier?continue=x",
        "Sign in — Use your Google Account. Email or phone",
      ),
    ).toBe("needs_login");
  });

  it("classifies the password step as needs_login, not challenge", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/v3/signin/challenge/pwd?x",
        "Welcome — Enter your password",
      ),
    ).toBe("needs_login");
  });

  it("detects a 2FA challenge", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/v3/signin/challenge/totp?x",
        "2-Step Verification — Enter the code",
      ),
    ).toBe("challenge");
  });

  it("returns not_google off a Google host or on a bad URL", () => {
    expect(classifyGoogleAuthState("https://dashboard.render.com/", "Welcome")).toBe("not_google");
    expect(classifyGoogleAuthState("not-a-url", "")).toBe("not_google");
  });

  it("defaults an unrecognized accounts.google.com page to needs_login", () => {
    expect(classifyGoogleAuthState("https://accounts.google.com/odd/page", "")).toBe(
      "needs_login",
    );
  });
});
