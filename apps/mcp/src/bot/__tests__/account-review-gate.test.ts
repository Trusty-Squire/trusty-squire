// Covers isAtAccountReviewGate — the post-signup heuristic that detects a
// service-side manual-approval gate (waiting room / waitlist / account pending
// review) so the run lands as onboarding_blocked instead of a mislabeled
// generic failure. Baseten is the motivating field example: signup succeeds,
// then a "waiting room" / account-review screen with no obtainable key.
//
// Tuned for PRECISION: the detector must fire on the gate's own phrasing but
// NOT on a normal dashboard, a normal signup form, a captcha page, or a
// marketing tile that merely mentions "early access" as a feature.

import { describe, expect, it } from "vitest";
import { isAtAccountReviewGate, isOnboardingReviewGate, isSignupsClosed } from "../agent.js";

describe("isAtAccountReviewGate — positive (real manual-approval gates)", () => {
  it("matches a 'waiting room' screen (baseten)", () => {
    expect(
      isAtAccountReviewGate(
        "You're in the waiting room. We'll let you in shortly.",
      ),
    ).toBe(true);
  });

  it("matches waitlist phrasing", () => {
    expect(isAtAccountReviewGate("You've been added to the waitlist.")).toBe(
      true,
    );
    expect(isAtAccountReviewGate("Join the waitlist to get early access.")).toBe(
      true,
    );
    expect(isAtAccountReviewGate("You're on the waitlist!")).toBe(true);
    expect(isAtAccountReviewGate("You're on the list — sit tight.")).toBe(true);
  });

  it("matches 'request access' / 'request early access'", () => {
    expect(isAtAccountReviewGate("Request access to continue.")).toBe(true);
    expect(isAtAccountReviewGate("Request early access below.")).toBe(true);
  });

  it("matches access/account pending phrasing", () => {
    expect(isAtAccountReviewGate("Your access is pending.")).toBe(true);
    expect(isAtAccountReviewGate("Access pending — hang tight.")).toBe(true);
    expect(isAtAccountReviewGate("Your account is pending approval.")).toBe(
      true,
    );
    expect(isAtAccountReviewGate("This is pending approval by our team.")).toBe(
      true,
    );
  });

  it("matches 'under review' phrasing", () => {
    expect(isAtAccountReviewGate("Your account is under review.")).toBe(true);
    expect(
      isAtAccountReviewGate("Your account is currently under review."),
    ).toBe(true);
    expect(isAtAccountReviewGate("Your account is being reviewed.")).toBe(true);
  });

  it("matches 'we'll email you when' deferred-grant phrasing", () => {
    expect(
      isAtAccountReviewGate("We'll email you when your account is ready."),
    ).toBe(true);
    expect(
      isAtAccountReviewGate("Well email you when access is granted."),
    ).toBe(true);
  });

  it("matches 'awaiting approval / access'", () => {
    expect(isAtAccountReviewGate("Awaiting approval from an administrator.")).toBe(
      true,
    );
    expect(isAtAccountReviewGate("Your account is awaiting access.")).toBe(true);
  });

  it("matches Baseten's pre-submit approval-information form", () => {
    expect(
      isAtAccountReviewGate(
        "We need more information to approve your account. To speed up your approval, " +
          "please share a little more about yourself and how you want to use Baseten. " +
          "You'll receive an email when your account is approved.",
      ),
    ).toBe(true);
  });
});

describe("isAtAccountReviewGate — negative (no false positives)", () => {
  it("does not match a normal dashboard", () => {
    expect(
      isAtAccountReviewGate(
        "Welcome to your dashboard. Create a new API key to get started.",
      ),
    ).toBe(false);
  });

  it("does not match a normal signup form", () => {
    expect(
      isAtAccountReviewGate(
        "Create your account. Email address. Password. Sign up.",
      ),
    ).toBe(false);
  });

  it("does not match a captcha / anti-bot page", () => {
    expect(
      isAtAccountReviewGate(
        "Verifying you are human. This may take a few seconds. Just a moment...",
      ),
    ).toBe(false);
  });

  it("does not match a billing/paywall page", () => {
    expect(
      isAtAccountReviewGate("Add a payment method to activate your API key."),
    ).toBe(false);
  });

  it("does not match marketing copy mentioning 'early access' as a feature", () => {
    expect(
      isAtAccountReviewGate(
        "Pro members get early access to new features and priority support.",
      ),
    ).toBe(false);
  });

  it("returns false on empty / unrelated text", () => {
    expect(isAtAccountReviewGate("")).toBe(false);
    expect(isAtAccountReviewGate("Your API key: sk-abc123. Copy it now.")).toBe(
      false,
    );
  });
});

describe("isOnboardingReviewGate — a verification timeout must NOT be a review gate", () => {
  const GATE_TEXT = "Your account is pending approval. We'll email you when access is granted.";

  it("returns false when verification failed, even if the page reads as a gate", () => {
    // The anthropic regression: a 'check your email' page timed out, then the
    // gate heuristic matched and mislabeled verification_not_sent as
    // onboarding_blocked. The verification failure is authoritative.
    expect(
      isOnboardingReviewGate(
        "verification_not_sent: form submitted and the page asked to check email, but none arrived in 180s",
        GATE_TEXT,
      ),
    ).toBe(false);
  });

  it("returns true for a genuine review gate when verification did not fail", () => {
    expect(isOnboardingReviewGate(undefined, GATE_TEXT)).toBe(true);
  });

  it("returns false when verification did not fail but the page is a normal dashboard", () => {
    expect(isOnboardingReviewGate(undefined, "Welcome to your dashboard. Create a project.")).toBe(
      false,
    );
  });
});

describe("isSignupsClosed — closed / invite-only registration", () => {
  it("matches turbopuffer's 'Sign-ups are closed'", () => {
    expect(isSignupsClosed("Sign-ups are closed. Follow us for updates.")).toBe(true);
  });

  it("matches common closed/invite-only phrasings", () => {
    expect(isSignupsClosed("Signup is currently disabled")).toBe(true);
    expect(isSignupsClosed("We are not accepting new signups at this time")).toBe(true);
    expect(isSignupsClosed("We're not currently accepting new registrations")).toBe(true);
    expect(isSignupsClosed("Registration is closed")).toBe(true);
    expect(isSignupsClosed("Access is invite-only")).toBe(true);
    expect(isSignupsClosed("Invite-only beta — request an invite")).toBe(true);
  });

  it("does NOT match a normal signup page or 'invite your team' feature", () => {
    expect(isSignupsClosed("Sign up for free. Create your account.")).toBe(false);
    expect(isSignupsClosed("Invite your team members to collaborate")).toBe(false);
    expect(isSignupsClosed("Welcome! Your API key: sk-abc123")).toBe(false);
    expect(isSignupsClosed("Create a new project to get started")).toBe(false);
  });
});
