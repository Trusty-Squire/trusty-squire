// Covers isAtPaywall — the post-OAuth heuristic that distinguishes
// "this dashboard is gating the API key behind a card" from "this
// dashboard happens to mention pricing/cards in a marketing tile".
//
// Motivated by the rc.26 ipinfo regression: the bot bailed
// `onboarding_blocked` even though the API token was visible on the
// dashboard, because the page included "No credit card required, no
// hidden fees" — and the old substring `.includes("credit card
// required")` matched that. rc.27 switches to regexes + a
// negation-prefix check; this test pins the contract.

import { describe, expect, it } from "vitest";
import { isAtPaywall } from "../agent.js";

describe("isAtPaywall — positive (real paywalls)", () => {
  it("matches an explicit demand for a payment method", () => {
    expect(
      isAtPaywall("Please add a payment method to activate your API key."),
    ).toBe(true);
  });

  it("matches 'add a credit card' phrasing", () => {
    expect(isAtPaywall("Add a credit card to continue.")).toBe(true);
    expect(isAtPaywall("Add credit card before proceeding.")).toBe(true);
  });

  it("matches 'enter your card' / 'enter payment details'", () => {
    expect(isAtPaywall("Enter your card to unlock the dashboard.")).toBe(true);
    expect(isAtPaywall("Enter payment details below.")).toBe(true);
  });

  it("matches an 'upgrade your plan to' nudge", () => {
    expect(isAtPaywall("Upgrade your plan to access this feature.")).toBe(
      true,
    );
  });

  // 0.8.2-rc.5 — Together.ai's post-OAuth landing. The post-verify
  // planner's `done` reason described the gate, but neither phrase was
  // in the rc.39 pattern set.
  it("matches Together.ai's 'payment form' done-reason", () => {
    expect(
      isAtPaywall(
        "This page shows a payment form, and it's not possible to proceed " +
          "further without inputting payment information.",
      ),
    ).toBe(true);
  });

  it("matches 'enter payment information' phrasing", () => {
    expect(isAtPaywall("Please enter payment information to continue.")).toBe(
      true,
    );
  });
});

describe("isAtPaywall — negative (free-plan marketing text)", () => {
  it("does not match 'No credit card required' — the ipinfo false positive", () => {
    expect(
      isAtPaywall(
        "Free and unlimited access to our most accurate country-level IP " +
          "geolocation and ASN data. No credit card required, no hidden " +
          "fees — just production-ready data for your applications.",
      ),
    ).toBe(false);
  });

  it("does not match 'without credit card required'", () => {
    expect(
      isAtPaywall("Sign up without credit card required."),
    ).toBe(false);
  });

  it("does not match 'doesn't require a payment method'", () => {
    expect(
      isAtPaywall("This plan doesn't require a payment method."),
    ).toBe(false);
    expect(
      isAtPaywall("This plan doesnt require a payment method."),
    ).toBe(false);
  });

  it("ignores 'paid plans' / 'view plans & pricing' marketing copy", () => {
    expect(
      isAtPaywall("PAID PLANS\nUpgrade for More\nView Plans & Pricing"),
    ).toBe(false);
  });

  it("returns false on empty / unrelated text", () => {
    expect(isAtPaywall("")).toBe(false);
    expect(isAtPaywall("Welcome to the dashboard.")).toBe(false);
  });
});
