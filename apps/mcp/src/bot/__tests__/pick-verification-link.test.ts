// Covers pickVerificationLink — the scorer that decides which link in
// a verification email the bot clicks. The bug this guards: an email
// whose only links score <= 0 (unsubscribe / preferences) used to
// fall back to links[0], navigating the bot to an unsubscribe URL.

import { describe, expect, it } from "vitest";
import { pickVerificationLink } from "../email-verification.js";

describe("pickVerificationLink", () => {
  it("picks the verify link over a marketing link", () => {
    const links = [
      "https://example.com/welcome",
      "https://example.com/verify?token=abc",
    ];
    expect(pickVerificationLink(links)).toBe(
      "https://example.com/verify?token=abc",
    );
  });

  it("picks confirm over activate when confirm scores higher", () => {
    const links = [
      "https://example.com/activate/xyz",
      "https://example.com/confirm/xyz",
    ];
    expect(pickVerificationLink(links)).toBe("https://example.com/confirm/xyz");
  });

  it("returns null when the only links are unsubscribe / preferences", () => {
    const links = [
      "https://example.com/unsubscribe?u=123",
      "https://example.com/email/preferences",
    ];
    expect(pickVerificationLink(links)).toBeNull();
  });

  it("returns null when no link scores positive", () => {
    const links = [
      "https://example.com/home",
      "https://example.com/about",
    ];
    expect(pickVerificationLink(links)).toBeNull();
  });

  it("returns null for an empty link list", () => {
    expect(pickVerificationLink([])).toBeNull();
  });

  it("does not pick a verify link whose unsubscribe penalty cancels it out", () => {
    // verify (+10) and unsubscribe (-10) net to 0 — not positive, so
    // we decline rather than risk an unsubscribe action.
    const links = ["https://example.com/verify/unsubscribe"];
    expect(pickVerificationLink(links)).toBeNull();
  });

  it("decodes HTML-escaped query separators before navigation", () => {
    const links = [
      "https://clerk.example.com/v1/verify?_clerk_js_version=1&amp;token=abc",
    ];
    expect(pickVerificationLink(links)).toBe(
      "https://clerk.example.com/v1/verify?_clerk_js_version=1&token=abc",
    );
  });

  it("does not treat static email image assets as verification links", () => {
    const links = [
      "https://static.langfuse.com/langfuse_logo_transactional_email.png",
      "https://cloud.langfuse.com/auth/verify?token=abc",
    ];
    expect(pickVerificationLink(links)).toBe("https://cloud.langfuse.com/auth/verify?token=abc");
    expect(pickVerificationLink(["https://static.langfuse.com/langfuse_logo_transactional_email.png"])).toBeNull();
  });
});
