// Regression tests for the three bugs surfaced by the Railway signup
// trace where the bot:
//   1. Followed an off-domain "signup" link from a Google search and
//      filled the form on someone's hobby Django app hosted on
//      Railway (storysite-production.up.railway.app/signup/).
//   2. Gave up on the explicit KNOWN_DOMAINS mapping
//      (railway.com/login) when looksLikeSignupPage returned false,
//      kicking off the search that triggered bug #1.
//   3. Logged "⚠ anti-bot interstitial detected" three times on a
//      page that wasn't actually an interstitial, because the regex
//      matched <script src="…/cf-turnstile.js"> in raw HTML.

import { describe, expect, it } from "vitest";
import {
  hostMatchesServiceDomain,
  isAntiBotInterstitialText,
  isKnownDomainFullUrlMatch,
} from "../agent.js";

describe("hostMatchesServiceDomain — BUG 1 (off-domain searcher)", () => {
  it("REJECTS the Railway customer-site that broke the original run", () => {
    // The exact host the bot wrongly filled a form on.
    expect(
      hostMatchesServiceDomain(
        "storysite-production.up.railway.app",
        "railway",
      ),
    ).toBe(false);
  });

  it("accepts the legitimate Railway domain", () => {
    expect(hostMatchesServiceDomain("railway.com", "railway")).toBe(true);
  });

  it("accepts a docs subdomain of the service", () => {
    expect(hostMatchesServiceDomain("docs.railway.com", "railway")).toBe(true);
  });

  it("accepts intentional TLD variants (sentry.io for slug 'sentry')", () => {
    // We can't disambiguate typosquats from legitimate TLD variants
    // without a curated allowlist. Documented behaviour.
    expect(hostMatchesServiceDomain("sentry.io", "sentry")).toBe(true);
    expect(hostMatchesServiceDomain("sentry.com", "sentry")).toBe(true);
  });

  it("rejects a different .app customer subdomain (vercel platform)", () => {
    expect(
      hostMatchesServiceDomain("randomapp.vercel.app", "vercel"),
    ).toBe(false);
  });

  it("accepts the platform's own domain (vercel.com for slug 'vercel')", () => {
    expect(hostMatchesServiceDomain("vercel.com", "vercel")).toBe(true);
  });

  it("normalizes hyphens in registered names (trusty-squire.com ↔ trustysquire)", () => {
    expect(
      hostMatchesServiceDomain("trusty-squire.com", "trustysquire"),
    ).toBe(true);
  });

  it("is permissive when no service slug is provided", () => {
    expect(hostMatchesServiceDomain("anything.com", "")).toBe(true);
  });

  it("rejects malformed hostnames", () => {
    expect(hostMatchesServiceDomain("not a host", "railway")).toBe(false);
  });
});

describe("isKnownDomainFullUrlMatch — BUG 2 (KNOWN_DOMAINS hardcoded URL)", () => {
  it("recognizes Railway's hardcoded /login as a KNOWN_DOMAINS full URL", () => {
    expect(
      isKnownDomainFullUrlMatch("Railway", "https://railway.com/login"),
    ).toBe(true);
  });

  it("recognizes Cloudflare's hardcoded /sign-up", () => {
    expect(
      isKnownDomainFullUrlMatch(
        "Cloudflare",
        "https://dash.cloudflare.com/sign-up",
      ),
    ).toBe(true);
  });

  it("does NOT match a service whose KNOWN_DOMAINS entry is a bare host", () => {
    // sentry maps to "sentry.io" (bare host) — guessSignupUrl will
    // synthesize https://sentry.io/signup, which is the *result* of
    // guessing, not a hardcoded full URL. Falling back to Google
    // search remains correct for Sentry-class entries.
    expect(
      isKnownDomainFullUrlMatch("Sentry", "https://sentry.io/signup"),
    ).toBe(false);
  });

  it("does NOT match an unknown service", () => {
    expect(
      isKnownDomainFullUrlMatch("PostmarkApp", "https://postmarkapp.com/signup"),
    ).toBe(false);
  });
});

describe("isAntiBotInterstitialText — BUG 3 (false-positive diagnostic)", () => {
  it("REJECTS the exact text from the Railway-trace signup page", () => {
    // Verbatim from steps 10/14/18 of the trace. This is a normal
    // Django signup form's visible text — no interstitial.
    const text =
      "Sign Up Sign up form Your password can't be too similar to your other personal information. Your password must contain at least 8 characters. Your password can't be a commonly used password. Your password can't be entirely numeric. Already ";
    expect(isAntiBotInterstitialText(text)).toBe(false);
  });

  it("REJECTS a signup form that just embeds a Turnstile widget", () => {
    // The previous regex would match `cf-turnstile` in raw HTML; the
    // diagnostic is now scoped to visible text, so a Turnstile widget
    // script reference no longer trips it.
    const visibleText = "Sign up Email address Password Create account";
    expect(isAntiBotInterstitialText(visibleText)).toBe(false);
  });

  it("flags a real Cloudflare 'Just a moment' interstitial", () => {
    expect(
      isAntiBotInterstitialText("Just a moment... Checking your browser"),
    ).toBe(true);
  });

  it("flags a real 'verify you are human' challenge", () => {
    expect(isAntiBotInterstitialText("Please verify you are human")).toBe(true);
  });

  it("flags an Imperva-style 'Attention Required' page", () => {
    expect(isAntiBotInterstitialText("Attention required!")).toBe(true);
  });
});
