// Covers the two pure helpers that drive the new signup-URL
// discovery: `guessSignupUrl` (the canonical-URL guess used when the
// caller doesn't pass `signup_url`) and `isGoogleSearchUrl` (the
// fallback predicate). The full agent flow that uses them is exercised
// live; these are the deterministic pieces unit tests can pin.

import { describe, expect, it } from "vitest";
import { detectAntiBotBlock, guessSignupUrl, isGoogleSearchUrl } from "../agent.js";

describe("guessSignupUrl", () => {
  it("returns https://<name>.com/signup for the common dev-SaaS pattern", () => {
    expect(guessSignupUrl("Resend")).toBe("https://resend.com/signup");
    expect(guessSignupUrl("Postmark")).toBe("https://postmark.com/signup");
    expect(guessSignupUrl("IPInfo")).toBe("https://ipinfo.com/signup");
  });

  it("strips spaces, punctuation, and case", () => {
    expect(guessSignupUrl("Mail Gun")).toBe("https://mailgun.com/signup");
    expect(guessSignupUrl("Stack-Auth")).toBe("https://stackauth.com/signup");
    expect(guessSignupUrl("send.grid")).toBe("https://sendgrid.com/signup");
  });

  it("handles single-word lowercase already", () => {
    expect(guessSignupUrl("resend")).toBe("https://resend.com/signup");
  });

  // F9.1 — known-domains map. .com isn't universal; these services
  // live on .io / .ai / .dev / etc. The .com guess would either 404
  // or redirect to the right TLD weirdly (Sentry's sentry.com → sentry.io
  // redirect drops the /signup path), which broke the post-navigate
  // looksLikeSignupPage check and dumped the bot into Google search.
  it("looks up known services on their non-.com TLDs", () => {
    expect(guessSignupUrl("Sentry")).toBe("https://sentry.io/signup");
    expect(guessSignupUrl("OpenRouter")).toBe("https://openrouter.ai/signup");
    expect(guessSignupUrl("Mistral")).toBe("https://mistral.ai/signup");
    expect(guessSignupUrl("Mailtrap")).toBe("https://mailtrap.io/signup");
    expect(guessSignupUrl("E2B")).toBe("https://e2b.dev/signup");
    // (Railway moved to a full-URL override — see the next describe block.)
  });

  // Full-URL overrides for services whose signup lives on a subdomain
  // or uses a non-standard path. Cloudflare's marketing site has no
  // signup form — it CTAs into the dashboard.
  it("honors full-URL entries verbatim", () => {
    expect(guessSignupUrl("Cloudflare")).toBe("https://dash.cloudflare.com/sign-up");
    // Railway's /signup is a 404 on both .app and .com; the real
    // signup-or-login entry point is /login.
    expect(guessSignupUrl("Railway")).toBe("https://railway.com/login");
  });
});

describe("detectAntiBotBlock", () => {
  it("detects Cloudflare 'Just a moment...' interstitial", () => {
    expect(
      detectAntiBotBlock(
        '<title>Just a moment...</title><body class="cf-challenge">Performing security verification</body>',
      ),
    ).toBe("Cloudflare");
    expect(
      detectAntiBotBlock("<body>Just a moment... dash.cloudflare.com</body>"),
    ).toBe("Cloudflare");
  });

  it("detects Sucuri / DataDome / Imperva interstitials", () => {
    expect(detectAntiBotBlock("<body>Sucuri Website Firewall</body>")).toBe("Sucuri");
    expect(detectAntiBotBlock('<div class="dd-captcha">solve me</div>')).toBe("DataDome");
    expect(detectAntiBotBlock("<title>Powered by Imperva</title>")).toBe("Imperva");
  });

  it("returns null on a normal signup page", () => {
    expect(
      detectAntiBotBlock(
        '<form><input type="email" name="email" /><button>Sign up</button></form>',
      ),
    ).toBeNull();
    expect(detectAntiBotBlock("")).toBeNull();
  });
});

describe("isGoogleSearchUrl", () => {
  it("matches www.google.com/search and bare google.com/search", () => {
    expect(isGoogleSearchUrl("https://www.google.com/search?q=Resend")).toBe(true);
    expect(isGoogleSearchUrl("https://google.com/search?q=Postmark")).toBe(true);
  });

  it("rejects other Google paths and other domains", () => {
    expect(isGoogleSearchUrl("https://www.google.com/")).toBe(false);
    expect(isGoogleSearchUrl("https://accounts.google.com/signin")).toBe(false);
    expect(isGoogleSearchUrl("https://resend.com/signup")).toBe(false);
    expect(isGoogleSearchUrl("not-a-url")).toBe(false);
  });
});
