import { describe, expect, it } from "vitest";

import {
  googleConsentIsBasicFromDom,
  googleGisConsentIsBasic,
  pickChooserAccount,
} from "../agent.js";

// The MODERN "Sign in with Google" (GIS) consent screen — "Allow <App> to
// access this info about you: Name and profile picture / Email address" with a
// Continue button. The old wording-based check missed it (MEASURED 2026-06-13:
// langfuse), so the bot bailed oauth_stuck_on_chooser on a benign basic consent.
describe("googleGisConsentIsBasic", () => {
  const gisBasic = [
    "Sign in to Langfuse",
    "Allow Langfuse to access this info about you",
    "Verify Bot02",
    "Name and profile picture",
    "verify-02@trustysquire.ai",
    "Email address",
    "Cancel",
    "Continue",
  ].join("\n");

  it("approves the basic GIS consent (name + email only)", () => {
    expect(googleGisConsentIsBasic(gisBasic)).toBe(true);
  });

  it("rejects a GIS consent that reaches into Drive/Gmail", () => {
    const sensitive = gisBasic.replace("Email address", "See and download all your Google Drive files");
    expect(googleGisConsentIsBasic(sensitive)).toBe(false);
  });

  it("rejects a non-consent page (no access wording / items)", () => {
    expect(googleGisConsentIsBasic("Welcome to your dashboard. Create an API key.")).toBe(false);
  });

  it("still accepts the classic basic consent wording", () => {
    expect(
      googleGisConsentIsBasic("Foo wants to access your Google Account\nSee your primary Google Account email address"),
    ).toBe(true);
  });
});

// Google's newer consent URL hides scope= behind an opaque part= token,
// so the only signal is the visible DOM. googleConsentIsBasicFromDom is
// the gate that recovers a provably basic-only consent (the same thing
// the URL-readable path auto-approves) while keeping the conservative
// abort for anything ambiguous or sensitive.
describe("googleConsentIsBasicFromDom", () => {
  it("returns true for an uploadcare-style basic consent (email + personal info only)", () => {
    const dom = [
      "Uploadcare wants to access your Google Account",
      "This will allow Uploadcare to:",
      "See your primary Google Account email address",
      "See your personal info, including any personal info you've made publicly available",
      "Associate you with your personal info on Google",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(true);
  });

  it("returns false when the consent also lists a contacts grant", () => {
    const dom = [
      "Some App wants to access your Google Account",
      "See your primary Google Account email address",
      "See your personal info",
      "Manage your contacts",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(false);
  });

  it("returns false when the consent lists a files/download grant", () => {
    const dom = [
      "Some App wants to access your Google Account",
      "See your primary Google Account email address",
      "See and download your files in Google Drive",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(false);
  });

  it("returns false for an empty/ambiguous DOM (no recognizable grant wording)", () => {
    expect(googleConsentIsBasicFromDom("")).toBe(false);
    expect(
      googleConsentIsBasicFromDom("Choose an account to continue to Some App"),
    ).toBe(false);
  });

  it("returns false for a danger-only DOM (sensitive scopes, no basic phrases)", () => {
    const dom = [
      "Some App wants to access your Google Account",
      "Send email on your behalf",
      "Manage your contacts",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(false);
  });
});

// On a multi-account profile Google's chooser shows N cards; the bot must sign
// up AS the intended account, not whichever renders first. This is what lets a
// one-account capture generalize to an N-account user.
describe("pickChooserAccount", () => {
  const cards = ["a@trustysquire.ai", "verify-03@trustysquire.ai", "z@gmail.com"];

  it("returns the card matching the intended email", () => {
    expect(pickChooserAccount("verify-03@trustysquire.ai", cards)).toBe(
      "verify-03@trustysquire.ai",
    );
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(pickChooserAccount("  Verify-03@TrustySquire.ai ", cards)).toBe(
      "verify-03@trustysquire.ai",
    );
  });

  it("returns null with no hint — caller falls back to the first card (single-account case)", () => {
    expect(pickChooserAccount(undefined, cards)).toBeNull();
    expect(pickChooserAccount("", cards)).toBeNull();
    expect(pickChooserAccount("   ", cards)).toBeNull();
  });

  it("returns null when the intended account isn't on the chooser", () => {
    expect(pickChooserAccount("nobody@trustysquire.ai", cards)).toBeNull();
  });

  it("returns null against an empty chooser", () => {
    expect(pickChooserAccount("verify-03@trustysquire.ai", [])).toBeNull();
  });
});
