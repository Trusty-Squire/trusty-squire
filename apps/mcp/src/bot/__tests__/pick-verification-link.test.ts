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

  it("picks a NextAuth-style magic link with no verify/confirm keyword (the Loops bug)", () => {
    // Loops (a Next.js app) emails a bare /api/auth/callback link with a token —
    // no "verify"/"confirm"/"activate" anywhere, so it used to score 0 → null.
    const links = [
      "https://app.loops.so/unsubscribe?u=9",
      "https://app.loops.so/api/auth/callback/email?callbackUrl=https%3A%2F%2Fapp.loops.so%2F&token=1a2b3c4d5e&email=x%40y.com",
    ];
    expect(pickVerificationLink(links)).toBe(
      "https://app.loops.so/api/auth/callback/email?callbackUrl=https%3A%2F%2Fapp.loops.so%2F&token=1a2b3c4d5e&email=x%40y.com",
    );
  });

  it("picks a bare token magic link with no auth path keyword", () => {
    expect(pickVerificationLink(["https://app.example.com/login?token=xyz789"])).toBe(
      "https://app.example.com/login?token=xyz789",
    );
  });

  it("matches a token behind an HTML-escaped separator", () => {
    expect(
      pickVerificationLink(["https://app.example.com/api/auth/callback/email?x=1&amp;token=abc"]),
    ).toBe("https://app.example.com/api/auth/callback/email?x=1&token=abc");
  });

  it("does NOT false-positive on a plain dashboard link (no token/auth/magic signal)", () => {
    const links = ["https://app.example.com/dashboard", "https://example.com/unsubscribe?u=1"];
    expect(pickVerificationLink(links)).toBeNull();
  });

  it("picks a bare 'login' magic-link CTA (Resend 'Log in to Resend')", () => {
    const links = ["https://resend.com/unsubscribe?u=1", "https://resend.com/login?token=abc"];
    expect(pickVerificationLink(links)).toBe("https://resend.com/login?token=abc");
  });

  it("picks a Keycloak account-link action-token URL (Xata 'link your Google account')", () => {
    const links = [
      "https://xata.io/unsubscribe?u=2",
      "https://auth.xata.io/realms/xata/login-actions/action-token?key=eyJ.abc",
    ];
    expect(pickVerificationLink(links)).toBe(
      "https://auth.xata.io/realms/xata/login-actions/action-token?key=eyJ.abc",
    );
  });

  it("picks an identity-broker /link path even without an explicit keyword match", () => {
    const links = ["https://accounts.example.com/unsubscribe", "https://auth.example.com/realms/x/broker/google/link?nonce=1"];
    expect(pickVerificationLink(links)).toBe(
      "https://auth.example.com/realms/x/broker/google/link?nonce=1",
    );
  });

  it("prefers a link on an expected domain over an equally-scored one on another host", () => {
    const links = [
      "https://tracker.example.net/login?token=abc",
      "https://app.realservice.com/login?token=abc",
    ];
    expect(pickVerificationLink(links, ["realservice.com"])).toBe(
      "https://app.realservice.com/login?token=abc",
    );
  });

  it("accepts a subdomain of the expected domain (auth host under the service's registrable domain)", () => {
    const links = [
      "https://tracker.example.net/login?token=abc",
      "https://auth.xata.io/login?token=abc",
    ];
    expect(pickVerificationLink(links, ["xata.io"])).toBe("https://auth.xata.io/login?token=abc");
  });

  it("does not let an expected-domain bonus alone turn a zero/negative score positive", () => {
    const links = ["https://realservice.com/unsubscribe?u=1"];
    expect(pickVerificationLink(links, ["realservice.com"])).toBeNull();
  });

  it("picks the NEWEST link when a thread has several (avoids an expired token)", () => {
    // Gmail renders a thread oldest→newest; the last matching link is the fresh
    // re-send. Both score equally, so the tie must break to the later one.
    const links = [
      "https://app.loops.so/api/auth/callback/email?token=OLD_EXPIRED&email=x%40y.com",
      "https://app.loops.so/api/auth/callback/email?token=NEW_FRESH&email=x%40y.com",
    ];
    expect(pickVerificationLink(links)).toBe(
      "https://app.loops.so/api/auth/callback/email?token=NEW_FRESH&email=x%40y.com",
    );
  });
});
