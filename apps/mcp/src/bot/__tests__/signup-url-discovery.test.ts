// Covers the two pure helpers that drive the new signup-URL
// discovery: `guessSignupUrl` (the canonical-URL guess used when the
// caller doesn't pass `signup_url`) and `isGoogleSearchUrl` (the
// fallback predicate). The full agent flow that uses them is exercised
// live; these are the deterministic pieces unit tests can pin.

import { describe, expect, it } from "vitest";
import { guessSignupUrl, isGoogleSearchUrl } from "../agent.js";

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
