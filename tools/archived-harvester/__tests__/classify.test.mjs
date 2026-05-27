import { describe, it, expect } from "vitest";
import { classifyFailure, FAILURE_CATEGORIES } from "../classify.mjs";

describe("classifyFailure — environment bucket", () => {
  it("captcha_blocked → environment", () => {
    expect(classifyFailure({ status: "captcha_blocked" })).toBe("environment");
  });

  it("anti_bot_blocked → environment", () => {
    expect(classifyFailure({ status: "anti_bot_blocked", error: "Cloudflare interstitial" }))
      .toBe("environment");
  });

  it("verification_not_sent → environment", () => {
    expect(classifyFailure({ status: "verification_not_sent" })).toBe("environment");
  });

  it("HTTP 5xx in error string → environment", () => {
    expect(classifyFailure({ status: "failed", error: "HTTP 503 service unavailable" }))
      .toBe("environment");
    expect(classifyFailure({ status: "failed", error: "got http 500 from upstream" }))
      .toBe("environment");
  });

  it("HTTP 4xx in error string → NOT environment (caller's problem, not upstream)", () => {
    expect(classifyFailure({ status: "failed", error: "HTTP 404 not found" }))
      .toBeNull();
  });
});

describe("classifyFailure — external_block bucket", () => {
  it.each([
    "payment_required",
    "oauth_required",
    "needs_login",
    "oauth_consent_needs_review",
    "onboarding_blocked",
  ])("%s → external_block", (status) => {
    expect(classifyFailure({ status })).toBe("external_block");
  });

  it("phone/SMS verification error text → external_block", () => {
    expect(classifyFailure({ status: "failed", error: "Phone verification required" }))
      .toBe("external_block");
    expect(classifyFailure({ status: "failed", error: "SMS-required gate" }))
      .toBe("external_block");
    expect(classifyFailure({ status: "failed", error: "Please verify your phone number" }))
      .toBe("external_block");
  });
});

describe("classifyFailure — upstream_change bucket", () => {
  it("skill-promoter dry replay failed → upstream_change", () => {
    const steps = [
      "  step: [skill-promoter] fetched skill ABC123 vv1 for railway",
      "  step: [skill-promoter] dry replay failed: step_failed",
    ];
    expect(classifyFailure({ status: "failed" }, steps)).toBe("upstream_change");
  });

  it("skill-promoter full replay failed → upstream_change", () => {
    const steps = ["  step: [skill-promoter] full replay failed: extraction"];
    expect(classifyFailure({ status: "failed" }, steps)).toBe("upstream_change");
  });
});

describe("classifyFailure — code_bug bucket", () => {
  it.each([
    "planning_failed",
    "submit_failed",
    "extraction_failed",
  ])("%s → code_bug", (status) => {
    expect(classifyFailure({ status })).toBe("code_bug");
  });

  it("selector not found error → code_bug", () => {
    expect(classifyFailure({ status: "failed", error: "selector 'input[type=email]' not found" }))
      .toBe("code_bug");
    expect(classifyFailure({ status: "failed", error: "no element matched the inventory query" }))
      .toBe("code_bug");
  });

  it("planner error text → code_bug", () => {
    expect(classifyFailure({ status: "failed", error: "planner returned empty plan" }))
      .toBe("code_bug");
    expect(classifyFailure({ status: "failed", error: "planner crashed mid-form" }))
      .toBe("code_bug");
  });
});

describe("classifyFailure — abstention (null)", () => {
  it("generic timeout abstains", () => {
    expect(classifyFailure({ status: "timeout", error: "exceeded 600s" })).toBeNull();
  });

  it("generic 'failed' with no specific signal abstains", () => {
    expect(classifyFailure({ status: "failed", error: "something went wrong" })).toBeNull();
  });

  it("'error' status with no signal abstains", () => {
    expect(classifyFailure({ status: "error", error: "uncaught throw" })).toBeNull();
  });

  it("unknown status abstains", () => {
    expect(classifyFailure({ status: "mystery_new_status" })).toBeNull();
  });

  it("null/undefined final abstains gracefully", () => {
    expect(classifyFailure(null)).toBeNull();
    expect(classifyFailure(undefined)).toBeNull();
    expect(classifyFailure({})).toBeNull();
  });

  it("missing/empty steps array doesn't crash upstream_change check", () => {
    expect(classifyFailure({ status: "failed" }, undefined)).toBeNull();
    expect(classifyFailure({ status: "failed" }, [])).toBeNull();
  });
});

describe("FAILURE_CATEGORIES enum", () => {
  it("includes all 4 design-doc categories", () => {
    expect(FAILURE_CATEGORIES).toContain("code_bug");
    expect(FAILURE_CATEGORIES).toContain("environment");
    expect(FAILURE_CATEGORIES).toContain("external_block");
    expect(FAILURE_CATEGORIES).toContain("upstream_change");
  });

  it("every classifier output is in the enum (when not null)", () => {
    const samples = [
      { status: "captcha_blocked" },
      { status: "payment_required" },
      { status: "planning_failed" },
      { status: "failed", error: "selector not found" },
    ];
    for (const s of samples) {
      const cat = classifyFailure(s);
      expect(FAILURE_CATEGORIES).toContain(cat);
    }
  });
});
