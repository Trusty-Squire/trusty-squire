// Covers pickVerificationLink — the scorer that decides which link in
// a verification email the bot clicks. The bug this guards: an email
// whose only links score <= 0 (unsubscribe / preferences) used to
// fall back to links[0], navigating the bot to an unsubscribe URL.

import { describe, expect, it } from "vitest";
import { pickVerificationLink, pickVerificationLinkFromHtml } from "../agent.js";

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
});

describe("pickVerificationLinkFromHtml (anchor-text fallback for tracker-wrapped links)", () => {
  it("picks amplitude's SendGrid-wrapped 'Activate account' link by anchor text", () => {
    const html =
      `<a href="https://fonts.googleapis.com/css2?family=Poppins">font</a>` +
      `<a href="https://u1071853.ct.sendgrid.net/ls/click?upn=u001.ACTIVATE">Activate account</a>` +
      `<a href="https://u1071853.ct.sendgrid.net/ls/click?upn=u001.UNSUB">Unsubscribe</a>`;
    expect(pickVerificationLinkFromHtml(html)).toBe(
      "https://u1071853.ct.sendgrid.net/ls/click?upn=u001.ACTIVATE",
    );
  });
  it("matches Verify/Confirm anchor text too", () => {
    expect(pickVerificationLinkFromHtml(`<a href="https://t.co/x">Verify your email</a>`)).toBe("https://t.co/x");
    expect(pickVerificationLinkFromHtml(`<a href="https://t.co/y">Confirm email address</a>`)).toBe("https://t.co/y");
  });
  it("decodes &amp; in the href", () => {
    expect(pickVerificationLinkFromHtml(`<a href="https://x.io/v?a=1&amp;b=2">Activate</a>`)).toBe("https://x.io/v?a=1&b=2");
  });
  it("returns null when no anchor text is verification-shaped", () => {
    expect(pickVerificationLinkFromHtml(`<a href="https://x.io/home">Go to dashboard</a><a href="https://x.io/u">Unsubscribe</a>`)).toBeNull();
    expect(pickVerificationLinkFromHtml("")).toBeNull();
  });
});
