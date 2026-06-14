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
import { isAtAccountReviewGate } from "../agent.js";

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
