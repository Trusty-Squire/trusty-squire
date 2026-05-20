// Covers the pure environment helpers in google-login.ts (T2). The
// login orchestration itself spawns real processes (Xvfb, x11vnc,
// cloudflared) and is validated by running it, not unit-tested — these
// are the deterministic pieces that can be.

import { describe, expect, it } from "vitest";
import {
  binaryOnPath,
  classifyGoogleAuthState,
  extractGoogleNumberMatch,
  extractOAuthScopes,
  findFreePort,
  hasDisplay,
  scopesAreBasic,
  scrapeGoogleScopePhrases,
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

  it("hasDisplay returns true on macOS and Windows without DISPLAY", () => {
    // The pre-0.5.3 regression: DISPLAY is a Unix concept that Mac
    // (Aqua) and Windows (Win32) don't set, so a DISPLAY-only check
    // would have routed both platforms into the headless noVNC rig
    // and failed at the missing Xvfb binary check.
    const savedDisplay = process.env.DISPLAY;
    const savedPlatform = process.platform;
    delete process.env.DISPLAY;
    try {
      for (const platform of ["darwin", "win32"]) {
        Object.defineProperty(process, "platform", { value: platform });
        expect(hasDisplay(), `${platform} should report a display`).toBe(true);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: savedPlatform });
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
    }
  });

  it("hasDisplay returns true on Linux only when DISPLAY is set", () => {
    const savedDisplay = process.env.DISPLAY;
    const savedPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      delete process.env.DISPLAY;
      expect(hasDisplay()).toBe(false);
      process.env.DISPLAY = ":0";
      expect(hasDisplay()).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: savedPlatform });
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
      else delete process.env.DISPLAY;
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

describe("extractGoogleNumberMatch", () => {
  it("reads the number from the 'tap N on your phone' phrasing", () => {
    expect(
      extractGoogleNumberMatch(
        "Verify it's you — Tap 28 on your phone to sign in",
      ),
    ).toBe("28");
  });

  it("reads the number from the '<N> on your other device' phrasing", () => {
    expect(
      extractGoogleNumberMatch(
        "Match the number — 47 on your other device. Google wants to make sure it's really you",
      ),
    ).toBe("47");
  });

  it("falls back to a 2-digit number on a recognized challenge page", () => {
    expect(
      extractGoogleNumberMatch(
        "Match the number  Google wants to make sure it's really you  89",
      ),
    ).toBe("89");
  });

  it("returns null on unrelated pages", () => {
    expect(extractGoogleNumberMatch("Sign in with your password")).toBeNull();
    expect(extractGoogleNumberMatch("")).toBeNull();
  });
});

describe("scrapeGoogleScopePhrases", () => {
  it("flags a Drive read scope", () => {
    const phrases = scrapeGoogleScopePhrases(
      "Vercel will get to: See and download all your Google Drive files. Continue",
    );
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]).toMatch(/see and download/i);
  });

  it("flags a contacts manage scope", () => {
    const phrases = scrapeGoogleScopePhrases(
      "App will be able to: Manage your contacts. Allow",
    );
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]).toMatch(/manage your contacts/i);
  });

  it("flags a send-mail-as-you scope", () => {
    const phrases = scrapeGoogleScopePhrases(
      "Send email on your behalf to anyone you choose",
    );
    expect(phrases.length).toBeGreaterThan(0);
  });

  it("returns empty on a basic-only consent / chooser / confirmation page", () => {
    expect(
      scrapeGoogleScopePhrases(
        "Continue to Vercel. Vercel wants access to your Google Account. Allow",
      ),
    ).toEqual([]);
    expect(scrapeGoogleScopePhrases("Choose an account to continue to Vercel")).toEqual([]);
    expect(scrapeGoogleScopePhrases("")).toEqual([]);
  });
});

describe("extractOAuthScopes (T7)", () => {
  it("reads space-separated scopes off the consent URL", () => {
    expect(
      extractOAuthScopes(
        "https://accounts.google.com/signin/oauth/consent?scope=openid%20email%20profile",
      ),
    ).toEqual(["openid", "email", "profile"]);
  });

  it("tolerates '+' as the scope separator", () => {
    expect(
      extractOAuthScopes("https://accounts.google.com/o/oauth2/v2/auth?scope=openid+email"),
    ).toEqual(["openid", "email"]);
  });

  it("finds scopes nested inside a `continue` param", () => {
    const inner = encodeURIComponent(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=openid%20email",
    );
    expect(
      extractOAuthScopes(`https://accounts.google.com/signin/oauth/consent?continue=${inner}`),
    ).toEqual(["openid", "email"]);
  });

  it("returns null when no scope param is present anywhere", () => {
    expect(extractOAuthScopes("https://accounts.google.com/signin/oauth/consent?client_id=x")).toBeNull();
    expect(extractOAuthScopes("not-a-url")).toBeNull();
  });
});

describe("scopesAreBasic (T7)", () => {
  it("accepts only the basic-identity allowlist", () => {
    expect(scopesAreBasic(["openid", "email", "profile"])).toBe(true);
    expect(
      scopesAreBasic([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
    ).toBe(true);
  });

  it("rejects any broader scope", () => {
    expect(
      scopesAreBasic(["openid", "https://www.googleapis.com/auth/gmail.readonly"]),
    ).toBe(false);
    expect(scopesAreBasic(["https://www.googleapis.com/auth/drive"])).toBe(false);
  });

  it("rejects an empty scope list — absence is not confirmation", () => {
    expect(scopesAreBasic([])).toBe(false);
  });
});
