// Pure-helper tests for the verification cluster, moved alongside the code
// from bot/__tests__/provision-session.test.ts when awaitVerification moved
// to bot/capture/verification.ts. The session-flow integration coverage for
// awaitVerification stays in bot/__tests__/operate-session-flow.test.ts.
import { describe, it, expect } from "vitest";
import {
  parseVerification,
  extractSenderEmail,
  expectedVerificationDomains,
  buildVerificationResult,
  buildConsentRefusal,
  buildVerificationSearchQuery,
} from "../verification.js";

describe("parseVerification (email OTP + link extraction)", () => {
  it("prefers a code adjacent to an OTP keyword", () => {
    const text = "Your order 1842 shipped. Your verification code is 503914. Thanks.";
    expect(parseVerification(text, []).code).toBe("503914");
  });

  it("matches a code that precedes the keyword", () => {
    expect(parseVerification("Enter 284619 to verify your email", []).code).toBe("284619");
  });

  it("falls back to a standalone 4-8 digit run when no keyword is present", () => {
    expect(parseVerification("Your one time pin: 9087", []).code).toBe("9087");
  });

  it("returns null code when there is no plausible OTP", () => {
    expect(parseVerification("Welcome to the service! Get started now.", []).code).toBeNull();
  });

  it("picks a verification link from the mail's hrefs", () => {
    const links = [
      "https://mail.google.com/settings",
      "https://resend.com/verify-email?token=abc123def456",
    ];
    expect(parseVerification("Click to confirm your email", links).link).toContain("resend.com");
  });

  it("returns both code and link when present", () => {
    const r = parseVerification("Your code 778201. Or click https://x.com/confirm?t=zz", [
      "https://x.com/confirm?t=zz",
    ]);
    expect(r.code).toBe("778201");
    expect(r.link).toContain("confirm");
  });

  it("extracts a magic-link login CTA with no code (Resend 'Log in to Resend')", () => {
    const links = [
      "https://resend.com/unsubscribe?u=1",
      "https://resend.com/login?token=abc123def456",
    ];
    const r = parseVerification("Log in to Resend. Click the button below to log in.", links);
    expect(r.code).toBeNull();
    expect(r.link).toBe("https://resend.com/login?token=abc123def456");
  });

  it("extracts a Keycloak account-link CTA (Xata 'link your Google account')", () => {
    const links = [
      "https://auth.xata.io/realms/xata/login-actions/action-token?key=eyJhbGciOiJIUzI1NiJ9.abc",
      "https://xata.io/unsubscribe?u=2",
    ];
    const r = parseVerification(
      "Someone tried to link your account with a Google account. Click to confirm this action.",
      links,
    );
    expect(r.link).toBe(
      "https://auth.xata.io/realms/xata/login-actions/action-token?key=eyJhbGciOiJIUzI1NiJ9.abc",
    );
  });

  it("does not return an unsubscribe/footer link when a verify CTA is also present", () => {
    const links = [
      "https://example.com/unsubscribe?u=123",
      "https://example.com/email/preferences",
      "https://example.com/verify?token=abc123",
    ];
    const r = parseVerification("Please verify your email", links);
    expect(r.link).toBe("https://example.com/verify?token=abc123");
  });

  it("prefers a link on the expected (sender/source) domain when candidates tie otherwise", () => {
    const links = [
      "https://tracker.example.net/login?token=abc",
      "https://app.realservice.com/login?token=abc",
    ];
    const r = parseVerification("Log in to continue", links, ["realservice.com"]);
    expect(r.link).toBe("https://app.realservice.com/login?token=abc");
  });
});

describe("expectedVerificationDomains (host-preference hint for link picking)", () => {
  it("derives a domain from a bare-domain sender hint", () => {
    expect(expectedVerificationDomains("resend.com", null)).toEqual(["resend.com"]);
  });

  it("derives a domain from an email-address sender hint", () => {
    expect(expectedVerificationDomains("noreply@xata.io", null)).toEqual(["xata.io"]);
  });

  it("includes the opened message's sender domain", () => {
    expect(expectedVerificationDomains(undefined, "search-api@brave.com")).toEqual(["brave.com"]);
  });

  it("dedupes when both hints resolve to the same domain", () => {
    expect(expectedVerificationDomains("xata.io", "noreply@xata.io")).toEqual(["xata.io"]);
  });

  it("returns an empty array when neither hint is present", () => {
    expect(expectedVerificationDomains(undefined, null)).toEqual([]);
  });
});

describe("buildVerificationResult (Flow A — code-wall hand-back)", () => {
  it("returns the code with no needs_user when a code was found", () => {
    const r = buildVerificationResult("sk_1", "492013", null);
    expect(r).toMatchObject({ session_id: "sk_1", found: true, code: "492013" });
    expect(r.needs_user).toBeUndefined();
  });

  it("returns found=true with no needs_user when only a link was found", () => {
    const r = buildVerificationResult("sk_1", null, "https://x.example/confirm");
    expect(r.found).toBe(true);
    expect(r.needs_user).toBeUndefined();
  });

  it("hands back to the user (resumable) when neither code nor link was found", () => {
    const r = buildVerificationResult("sk_1", null, null);
    expect(r.found).toBe(false);
    expect(r.needs_user).toEqual({
      wall: "verification_code",
      // Steers to a retry first (emails lag the trigger), then the user-ask fallback.
      message: expect.stringContaining("operate_read_inbox AGAIN"),
      resume: "code",
    });
    expect(r.needs_user?.message.toLowerCase()).toContain("ask the user");
  });
});

describe("extractSenderEmail (source_from provenance — wrong-sender guard)", () => {
  it("pulls the sender from a Gmail 'Name <addr>' header", () => {
    const text = "Brave Search API <search-api@brave.com> 8:55 PM to me Please verify";
    expect(extractSenderEmail(text)).toBe("search-api@brave.com");
  });

  it("lowercases the address and returns null when no angled sender is present", () => {
    expect(extractSenderEmail("Support <No-Reply@Example.COM> hi")).toBe("no-reply@example.com");
    expect(extractSenderEmail("Your verification code is 123456")).toBeNull();
  });

  it("buildVerificationResult surfaces source_from when provided, omits it otherwise", () => {
    expect(
      buildVerificationResult("sk_1", "492013", null, "search-api@brave.com").source_from,
    ).toBe("search-api@brave.com");
    expect(buildVerificationResult("sk_1", "492013", null).source_from).toBeUndefined();
  });
});

describe("buildConsentRefusal (PR2 — inbox-read consent withheld)", () => {
  it("hands back resumably without a code and names the consent reason", () => {
    const r = buildConsentRefusal("sk_2");
    expect(r).toMatchObject({ session_id: "sk_2", found: false, code: null, link: null });
    expect(r.needs_user).toEqual({
      wall: "verification_code",
      message: expect.stringContaining("Inbox reading is disabled"),
      resume: "code",
    });
  });
});

describe("buildVerificationSearchQuery (finds passwordless mail)", () => {
  it("covers passwordless sign-in / login vocabulary, not just OTP words", () => {
    // Regression: a Loops "Login link" email ("Please login… Login") has none of
    // verify/confirm/code/otp, so the old query missed it → found:false.
    const q = buildVerificationSearchQuery();
    expect(q).toContain("login");
    expect(q).toContain('"sign in"');
    expect(q).toContain("verify");
    expect(q).toContain("newer_than:1d");
    expect(q).not.toContain("from:");
  });
  it("prepends the sender filter when given", () => {
    expect(buildVerificationSearchQuery("mail.loops.so")).toContain("from:mail.loops.so");
  });
  it("end-to-end: the real Loops login email now yields its magic link", () => {
    // The actual email body + the actual /api/auth/callback link (token redacted).
    const body =
      "Please login to Loops by clicking the button below. Login Alternatively, you can click here. If you didn't request this, please reply.";
    const links = [
      "https://loops.so",
      "https://app.loops.so/api/auth/callback/email?callbackUrl=https%3A%2F%2Fapp.loops.so%2Fadd-domain&token=REDACTED&email=x%40y.com",
      "https://loops.so?utm_source=footer",
    ];
    const { link } = parseVerification(body, links);
    expect(link).toBe(
      "https://app.loops.so/api/auth/callback/email?callbackUrl=https%3A%2F%2Fapp.loops.so%2Fadd-domain&token=REDACTED&email=x%40y.com",
    );
  });
});
