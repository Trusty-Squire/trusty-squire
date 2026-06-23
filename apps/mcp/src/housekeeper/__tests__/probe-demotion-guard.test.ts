import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  failureCountsTowardDemotion,
} from "@trusty-squire/skill-schema";
import {
  probeShowsServable,
  BRITTLE_PROBE_KIND,
} from "../probe-demotion-guard.js";

describe("probeShowsServable", () => {
  const base = {
    providers: [] as string[],
    has_email_signup: false,
    card_gate: false,
    interstitial: false,
  };

  it("is true when an OAuth provider is present and no wall", () => {
    expect(probeShowsServable({ ...base, providers: ["google"] })).toBe(true);
  });

  it("is true when an email-signup form is present", () => {
    expect(probeShowsServable({ ...base, has_email_signup: true })).toBe(true);
  });

  it("is false on an anti-bot interstitial even with an affordance", () => {
    expect(
      probeShowsServable({ ...base, providers: ["google"], interstitial: true }),
    ).toBe(false);
  });

  it("is false when no entry affordance is present", () => {
    expect(probeShowsServable({ ...base, card_gate: true })).toBe(false);
    expect(probeShowsServable(base)).toBe(false);
  });

  it("accepts a card-gate upsell ALONGSIDE a real entry affordance", () => {
    expect(
      probeShowsServable({ ...base, providers: ["github"], card_gate: true }),
    ).toBe(true);
  });

  it("is null/undefined safe", () => {
    expect(probeShowsServable(null)).toBe(false);
    expect(probeShowsServable(undefined)).toBe(false);
  });

  it("the brittle kind classifies transient and never counts toward demotion", () => {
    // The kind now lives mcp-side, but skill-schema's classifyFailure must
    // still treat it as a non-demoting unknown (the default) — that's what
    // makes the downgrade safe regardless of the registry's deployed version.
    expect(classifyFailure(BRITTLE_PROBE_KIND)).toBe("transient");
    expect(failureCountsTowardDemotion(BRITTLE_PROBE_KIND)).toBe(false);
  });
});
