// Covers S3: after a clean submit the bot reads the post-submit page to
// decide whether to poll for a verification email at all. The decision is
// expectsVerificationEmail(pageText) — if the page tells the user to check
// their inbox, poll the full timeout; if not, the service most likely
// sent nothing, so the bot runs a short probe and bails fast instead of
// 300s of dead air. This guards the keyword set behind that decision.

import { describe, expect, it } from "vitest";
import { expectsVerificationEmail } from "../agent.js";

describe("S3 — expectsVerificationEmail", () => {
  it("is true when the page tells the user to check their email", () => {
    expect(expectsVerificationEmail("Almost there! Check your email to verify.")).toBe(true);
    expect(expectsVerificationEmail("We sent a confirmation email to your address")).toBe(true);
    expect(expectsVerificationEmail("Click the verification link we emailed you")).toBe(true);
    expect(expectsVerificationEmail("Please verify your inbox to continue")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(expectsVerificationEmail("CHECK YOUR EMAIL")).toBe(true);
    expect(expectsVerificationEmail("Verify Your Email Address")).toBe(true);
  });

  it("is false when the page shows an error or no email prompt", () => {
    expect(expectsVerificationEmail("Something went wrong, please try again")).toBe(false);
    expect(expectsVerificationEmail("Welcome to your dashboard")).toBe(false);
    expect(expectsVerificationEmail("That email is already registered")).toBe(false);
    expect(expectsVerificationEmail("")).toBe(false);
  });
});
