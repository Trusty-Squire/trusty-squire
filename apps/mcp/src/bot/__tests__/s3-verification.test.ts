// Covers S3: after a clean submit the bot reads the post-submit page to
// decide whether to poll for a verification email at all. The decision is
// expectsVerificationEmail(pageText) — if the page tells the user to check
// their inbox, poll the full timeout; if not, the service most likely
// sent nothing, so the bot runs a short probe and bails fast instead of
// 300s of dead air. This guards the keyword set behind that decision.

import { describe, expect, it } from "vitest";
import { expectsVerificationEmail, submitWasRejected } from "../agent.js";

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

// S3 probe-duration regression guard. The real bug: a CLEAN submit whose
// post-submit page never said "check your email" (the SPA hadn't rendered
// the confirmation screen yet, or it verifies silently) collapsed to a
// 45s probe and false-reported `verification_not_sent` even though mail
// from Postmark/SendGrid-class senders routinely lands after 45s. We only
// drop to the 45s probe when the submit was VISIBLY rejected; otherwise we
// poll the longer submitted-floor. submitWasRejected encodes that gate.
describe("S3 — submitWasRejected", () => {
  it("is true on an already-registered / account-exists page", () => {
    expect(submitWasRejected("That email is already registered.")).toBe(true);
    expect(submitWasRejected("An account with this email already exists")).toBe(true);
    expect(submitWasRejected("This email is already in use")).toBe(true);
    expect(submitWasRejected("You already have an account — log in instead")).toBe(true);
  });

  it("is true on a validation-error page (submit not accepted)", () => {
    // The exact ipdata re-render from the live trail.
    expect(
      submitWasRejected(
        "The email or password cannot be empty. Email Address This field is required.",
      ),
    ).toBe(true);
    expect(submitWasRejected("Please correct the errors and try again")).toBe(true);
    expect(submitWasRejected("Invalid email address")).toBe(true);
  });

  it("is false on a clean post-submit page (account created, mail may lag)", () => {
    // Postmark/ElevenLabs-class: submit accepted, confirmation screen not
    // yet rendered. Must NOT be treated as rejected — these poll the floor.
    expect(submitWasRejected("Setting up your account...")).toBe(false);
    expect(submitWasRejected("Welcome to your dashboard")).toBe(false);
    expect(submitWasRejected("")).toBe(false);
    // "required" appearing in benign marketing copy must not trip it.
    expect(submitWasRejected("No credit card required to get started")).toBe(false);
  });
});
