// B1 — every terminal error maps to exactly one failure_stage (table test),
// and the B2 aggregator turns a pile of outcome sidecars into the
// where-is-the-noise map.

import { describe, expect, it } from "vitest";
import {
  ALL_FAILURE_STAGES,
  classifyFailureStage,
  type FailureSignal,
  type FailureStage,
} from "../failure-stage.js";
import { aggregateOutcomes } from "../failure-stats.js";
import type { OnboardingOutcomeFile } from "../onboarding-capture.js";

describe("classifyFailureStage (B1 taxonomy)", () => {
  it("success → none regardless of reachedOnboarding", () => {
    expect(classifyFailureStage({ success: true }, true)).toBe("none");
    expect(classifyFailureStage({ success: true }, false)).toBe("none");
  });

  it("a blocked captcha wins over the error string", () => {
    const sig: FailureSignal = { success: false, error: "oauth_required", captcha: { blocked: true } };
    expect(classifyFailureStage(sig, false)).toBe("captcha");
  });

  // (error, reachedOnboarding) → expected stage. One row per real terminal code.
  const table: Array<[string, boolean, FailureStage]> = [
    ["anti_bot_blocked: Cloudflare on SSO callback", false, "anti_bot"],
    ["captcha_blocked", false, "captcha"],
    ["oauth_required", false, "oauth_handshake"],
    ["sso-callback hung", false, "oauth_handshake"],
    ["could not pick account in chooser", false, "account_chooser"],
    ["consent screen scope grant failed", false, "consent"],
    ["proxy connect timeout", false, "proxy_timeout"],
    ["Clerk never finished hydration", false, "hydration"],
    ["verification_not_sent", false, "verify_email"],
    ["email_otp_required", false, "verify_email"],
    ["phone verification gate", false, "phone"],
    ["payment_required", false, "payment"],
    ["quota exceeded", false, "payment"],
    ["could not extract key — masked", true, "extract"],
    // live (supabase): reached the dashboard, no key — extract, NOT oauth,
    // even though "post-OAuth" contains "oauth"
    ["no_credentials_after_already_signed_in: post-OAuth navigation did not surface an API key", true, "extract"],
    ["planning_failed", false, "planner_loop"],
    ["max_rounds reached", true, "planner_loop"],
    ["run_timeout", false, "run_timeout"],
    ["submit_failed", true, "planner_loop"], // submit no-op after onboarding began
    ["submit_failed", false, "form"], // submit failed on the signup form
    ["never reached a fillable form", false, "form"], // generic, pre-onboarding
    ["something weird", true, "planner_loop"], // generic, post-onboarding
  ];

  it.each(table)("maps %j (reachedOnboarding=%s) → %s", (error, reached, expected) => {
    expect(classifyFailureStage({ success: false, error }, reached)).toBe(expected);
  });

  it("every result resolves to a value in the enum (totality)", () => {
    const samples: FailureSignal[] = [
      { success: false, error: "" },
      { success: false },
      { success: false, error: "totally unknown thing" },
    ];
    for (const s of samples) {
      expect(ALL_FAILURE_STAGES).toContain(classifyFailureStage(s, false));
      expect(ALL_FAILURE_STAGES).toContain(classifyFailureStage(s, true));
    }
  });
});

describe("aggregateOutcomes (B2)", () => {
  function out(service: string, ok: boolean, stage: FailureStage): OnboardingOutcomeFile {
    return {
      capture_format_version: 1,
      service,
      run_id: `${service}-${stage}-${ok}`,
      outcome: {
        ok,
        credential_present: ok,
        credential_fields: ok ? ["api_key"] : [],
        failure_stage: stage,
        terminal_round: 0,
      },
    };
  }

  it("buckets failures by stage and computes per-service pass rates + variance", () => {
    const outcomes: OnboardingOutcomeFile[] = [
      out("alpha", true, "none"),
      out("alpha", true, "none"),
      out("alpha", false, "planner_loop"),
      out("beta", false, "hydration"),
      out("beta", false, "hydration"),
    ];
    const s = aggregateOutcomes(outcomes);
    expect(s.totalRuns).toBe(5);
    expect(s.totalPasses).toBe(2);
    expect(s.overallPassRate).toBeCloseTo(2 / 5);
    expect(s.stageHistogram.hydration).toBe(2);
    expect(s.stageHistogram.planner_loop).toBe(1);
    expect(s.stageHistogram.none).toBe(2);
    // worst-first: beta 0% before alpha 66.7%
    expect(s.perService.map((p) => p.service)).toEqual(["beta", "alpha"]);
    expect(s.perService[0]!.passRate).toBe(0);
    expect(s.perService[1]!.passRate).toBeCloseTo(2 / 3);
    // variance of {0, 0.667} around mean 0.333
    expect(s.passRateVariance).toBeGreaterThan(0);
  });

  it("handles an empty corpus without dividing by zero", () => {
    const s = aggregateOutcomes([]);
    expect(s.totalRuns).toBe(0);
    expect(s.overallPassRate).toBe(0);
    expect(s.passRateVariance).toBe(0);
  });
});
