import { describe, it, expect } from "vitest";
import { policyToMandate, type MandatePolicy } from "../policy-to-mandate.js";
import type { SigningDevice } from "@trusty-squire/mandate-validator";

function samplePolicy(overrides: Partial<MandatePolicy> = {}): MandatePolicy {
  return {
    spend_limit_cents_per_month: 50_000,
    allowed_categories: ["hosting", "email-api"],
    silent_signup: { max_monthly_cost_cents: 1000, allow_free: true },
    approval_required_categories: [],
    confidence_requirements: {
      login: "low",
      mandate_signing: "high",
      delta_mandate_signing: "high",
      provision_silent: "low",
      provision_approved: "medium",
      amend_mandate: "high",
      cancel: "low",
      rotate: "medium",
      release_identity: "high",
    },
    ...overrides,
  };
}

function sampleDevice(): SigningDevice {
  return {
    id: "sdv_test",
    alg: "Ed25519",
    public_key: "AAAA",
    platform: "web",
    registered_at: "2026-05-11T00:00:00.000Z",
    revoked_at: null,
  };
}

describe("policyToMandate", () => {
  it("copies the spend limit and derives a daily cap of 1/10", () => {
    const m = policyToMandate({
      policy: samplePolicy({ spend_limit_cents_per_month: 100_000 }),
      accountId: "acc_x",
      signedAt: "2026-05-11T00:00:00.000Z",
      expiresAt: "2027-05-11T00:00:00.000Z",
      signingDevice: sampleDevice(),
    });
    expect(m.monthly_budget_cents).toBe(100_000);
    expect(m.daily_silent_max_cents).toBe(10_000);
  });

  it("passes through allowed_categories and accountId", () => {
    const m = policyToMandate({
      policy: samplePolicy({ allowed_categories: ["a", "b", "c"] }),
      accountId: "acc_y",
      signedAt: "2026-05-11T00:00:00.000Z",
      expiresAt: "2027-05-11T00:00:00.000Z",
      signingDevice: sampleDevice(),
    });
    expect(m.allowed_categories).toEqual(["a", "b", "c"]);
    expect(m.account_id).toBe("acc_y");
  });

  it("projects PWA ceremony-context map onto canonical ActionType keys", () => {
    const m = policyToMandate({
      policy: samplePolicy({
        confidence_requirements: {
          login: "low",
          mandate_signing: "high",
          delta_mandate_signing: "high",
          provision_silent: "medium",
          provision_approved: "high",
          amend_mandate: "high",
          cancel: "medium",
          rotate: "high",
          release_identity: "high",
        },
      }),
      accountId: "acc_z",
      signedAt: "2026-05-11T00:00:00.000Z",
      expiresAt: "2027-05-11T00:00:00.000Z",
      signingDevice: sampleDevice(),
    });
    expect(m.confidence_requirements).toEqual({
      provision: "medium",
      rotate: "high",
      cancel: "medium",
      amend_mandate: "high",
      release_identity: "high",
    });
  });

  it("uses the signing device passed in", () => {
    const device = sampleDevice();
    const m = policyToMandate({
      policy: samplePolicy(),
      accountId: "acc_q",
      signedAt: "2026-05-11T00:00:00.000Z",
      expiresAt: "2027-05-11T00:00:00.000Z",
      signingDevice: device,
    });
    expect(m.signing_devices).toEqual([device]);
  });

  it("uses signedAt/expiresAt for not_before/not_after", () => {
    const m = policyToMandate({
      policy: samplePolicy(),
      accountId: "acc_q",
      signedAt: "2026-05-11T10:00:00.000Z",
      expiresAt: "2027-05-11T10:00:00.000Z",
      signingDevice: sampleDevice(),
    });
    expect(m.not_before).toBe("2026-05-11T10:00:00.000Z");
    expect(m.not_after).toBe("2027-05-11T10:00:00.000Z");
  });
});
