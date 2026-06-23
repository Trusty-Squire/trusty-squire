// Covers pickVerificationLink — the scorer that decides which link in
// a verification email the bot clicks. The bug this guards: an email
// whose only links score <= 0 (unsubscribe / preferences) used to
// fall back to links[0], navigating the bot to an unsubscribe URL.

import { describe, expect, it } from "vitest";
import { pickServiceDomainLink, pickVerificationLink, pickVerificationLinkFromHtml } from "../agent.js";

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
  it("picks confirmation-instructions action text over a root marketing link", () => {
    expect(
      pickVerificationLinkFromHtml(
        `<a href="https://stackblitz.com/">StackBlitz</a>` +
          `<a href="https://stackblitz.com/users/confirmation?confirmation_token=abc">Confirmation instructions</a>`,
      ),
    ).toBe("https://stackblitz.com/users/confirmation?confirmation_token=abc");
  });
  it("accepts single-quoted hrefs in confirmation emails", () => {
    expect(
      pickVerificationLinkFromHtml(
        `<a href='https://stackblitz.com/'>StackBlitz</a>` +
          `<a class='button' href='https://stackblitz.com/users/confirmation?confirmation_token=abc'>Confirm my account</a>`,
      ),
    ).toBe("https://stackblitz.com/users/confirmation?confirmation_token=abc");
  });
  it("decodes &amp; in the href", () => {
    expect(pickVerificationLinkFromHtml(`<a href="https://x.io/v?a=1&amp;b=2">Activate</a>`)).toBe("https://x.io/v?a=1&b=2");
  });
  it("returns null when no anchor text is verification-shaped", () => {
    expect(pickVerificationLinkFromHtml(`<a href="https://x.io/home">Read our blog</a><a href="https://x.io/u">Unsubscribe</a>`)).toBeNull();
    expect(pickVerificationLinkFromHtml("")).toBeNull();
  });
});

describe("pickServiceDomainLink", () => {
  it("skips same-domain static image assets before falling back to a service-domain link", () => {
    expect(
      pickServiceDomainLink(
        [
          "https://static.langfuse.com/langfuse_logo_transactional_email.png",
          "https://cloud.langfuse.com/auth/callback?token=abc",
        ],
        "cloud.langfuse.com",
      ),
    ).toBe("https://cloud.langfuse.com/auth/callback?token=abc");
  });

  it("returns null when the only same-domain link is a static asset", () => {
    expect(
      pickServiceDomainLink(
        ["https://static.langfuse.com/langfuse_logo_transactional_email.png"],
        "cloud.langfuse.com",
      ),
    ).toBeNull();
  });

  it("skips a same-domain root link before using a deeper service-domain action", () => {
    expect(
      pickServiceDomainLink(
        [
          "https://stackblitz.com/",
          "https://stackblitz.com/users/confirmation?confirmation_token=abc",
        ],
        "stackblitz.com",
      ),
    ).toBe("https://stackblitz.com/users/confirmation?confirmation_token=abc");
  });
});

import { verificationLinkFailed } from "../agent.js";

describe("verificationLinkFailed — expired/used single-use link → go log in", () => {
  it("detects the portkey Firebase expired-link page", () => {
    expect(
      verificationLinkFailed(
        "Back to login Email Verification Failed This link has expired. Please try again. Return to login",
      ),
    ).toBe(true);
  });
  it("detects 'already been used' and 'invalid or expired'", () => {
    expect(verificationLinkFailed("This link has already been used.")).toBe(true);
    expect(verificationLinkFailed("The link is invalid or expired.")).toBe(true);
    expect(verificationLinkFailed("Your email is already verified.")).toBe(true);
  });
  it("does NOT fire on a normal post-verify dashboard", () => {
    expect(
      verificationLinkFailed("Welcome! Your API key: sk-abc123. Create new key."),
    ).toBe(false);
    expect(verificationLinkFailed("Check your email to verify your account.")).toBe(false);
  });
});

import { parseFirebaseEmailAction } from "../agent.js";

describe("parseFirebaseEmailAction — Firebase verifyEmail link → {apiKey, oobCode}", () => {
  it("parses a portkey-style custom-domain Firebase action link (with &amp;)", () => {
    const url =
      "https://app.portkey.ai/auth?mode=verifyEmail&amp;oobCode=GYIRIG8NBin9i3XZz8q4&amp;apiKey=AIzaSyCFDZUr22oV3OhhCqUm_3bXtA9h4l5MDP8&amp;lang=en";
    expect(parseFirebaseEmailAction(url)).toEqual({
      apiKey: "AIzaSyCFDZUr22oV3OhhCqUm_3bXtA9h4l5MDP8",
      oobCode: "GYIRIG8NBin9i3XZz8q4",
    });
  });
  it("returns null for non-verifyEmail modes and non-Firebase links", () => {
    expect(
      parseFirebaseEmailAction("https://app.x.com/auth?mode=resetPassword&oobCode=z&apiKey=AIzaSyAAAAAAAAAAAAAAAAAAAAAA"),
    ).toBeNull();
    expect(parseFirebaseEmailAction("https://arize.com/confirm?token=abc")).toBeNull();
    expect(parseFirebaseEmailAction("not a url")).toBeNull();
  });
  it("rejects a malformed apiKey", () => {
    expect(
      parseFirebaseEmailAction("https://x/auth?mode=verifyEmail&oobCode=z&apiKey=nope"),
    ).toBeNull();
  });
});

import { extractQuotedTokenFromReason } from "../agent.js";

describe("extractQuotedTokenFromReason — base64-style keys (with /)", () => {
  it("captures a base64 key containing '/' (portkey) — present on page", () => {
    const key = "tdCwXd/8kp4EqdACsvfojKF5bkTx";
    expect(
      extractQuotedTokenFromReason(`api_key='${key}'`, `Your API key: ${key}`),
    ).toBe(key);
  });
  it("still rejects a quoted token NOT present on the page", () => {
    expect(
      extractQuotedTokenFromReason("api_key='abc/def/ghi/jkl'", "no key here"),
    ).toBeNull();
  });
});

describe("pickServiceDomainLink — same-domain confirm link fallback (arize)", () => {
  it("picks the link on the service's registrable domain (app.arize.com ~ arize.com)", () => {
    const links = [
      "https://click.arize.com/track?u=unsubscribe",
      "https://app.arize.com/confirm?token=abc123xyz",
      "https://twitter.com/arizeai",
    ];
    expect(pickServiceDomainLink(links, "app.arize.com")).toBe(
      "https://app.arize.com/confirm?token=abc123xyz",
    );
  });
  it("skips unsubscribe/social/manage links even on-domain", () => {
    expect(
      pickServiceDomainLink(
        ["https://arize.com/unsubscribe?u=1", "https://arize.com/email-settings"],
        "arize.com",
      ),
    ).toBeNull();
  });
  it("returns null when no link matches the service domain", () => {
    expect(
      pickServiceDomainLink(["https://sendgrid.net/x", "https://other.com/y"], "arize.com"),
    ).toBeNull();
    expect(pickServiceDomainLink(["https://x.com"], null)).toBeNull();
  });
});
