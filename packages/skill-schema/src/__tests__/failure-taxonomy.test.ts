import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  failureCountsTowardDemotion,
  isWallFailure,
} from "../failure-taxonomy.js";

describe("classifyFailure", () => {
  it("classifies anti-bot walls", () => {
    expect(classifyFailure("captcha_blocked")).toBe("wall");
    expect(classifyFailure("anti_bot_blocked")).toBe("wall");
    expect(classifyFailure("captcha")).toBe("wall");
  });

  it("classifies our-side inbox/delivery failures as infra", () => {
    expect(classifyFailure("verification_not_sent")).toBe("infra");
    expect(classifyFailure("inbox_empty")).toBe("infra");
  });

  it("classifies genuine skill staleness as rot", () => {
    for (const k of [
      "step_failed",
      "validator_failed",
      "extraction_failed",
      "submit_failed",
      "selector_not_found",
    ]) {
      expect(classifyFailure(k)).toBe("rot");
    }
  });

  it("classifies oauth/session/timeout/planner as transient (never demote)", () => {
    for (const k of [
      "needs_login",
      "oauth_required",
      "oauth_session_not_persisted",
      "oauth_onboarding_failed",
      "run_timeout",
      "planning_failed",
      "page",
      "email_otp_required",
    ]) {
      expect(classifyFailure(k)).toBe("transient");
    }
  });

  it("defaults UNKNOWN kinds to transient, not rot (anti-thrash)", () => {
    expect(classifyFailure("some_novel_failure_2027")).toBe("transient");
    expect(classifyFailure(null)).toBe("transient");
    expect(classifyFailure(undefined)).toBe("transient");
    expect(classifyFailure("")).toBe("transient");
    expect(classifyFailure("   ")).toBe("transient");
  });

  it("matches the leading token of '<kind>: <detail>' strings", () => {
    // the bot emits e.g. "verification_not_sent: form submitted but…"
    expect(classifyFailure("verification_not_sent: form submitted but the page never prompted")).toBe("infra");
    expect(classifyFailure("step_failed: selector #submit not found")).toBe("rot");
    expect(classifyFailure("CAPTCHA_BLOCKED")).toBe("wall"); // case-insensitive
  });

  it("only rot counts toward demotion", () => {
    expect(failureCountsTowardDemotion("step_failed")).toBe(true);
    expect(failureCountsTowardDemotion("verification_not_sent")).toBe(false);
    expect(failureCountsTowardDemotion("captcha_blocked")).toBe(false);
    expect(failureCountsTowardDemotion("needs_login")).toBe(false);
    expect(failureCountsTowardDemotion("unknown")).toBe(false);
  });

  it("isWallFailure flags only walls", () => {
    expect(isWallFailure("anti_bot_blocked")).toBe(true);
    expect(isWallFailure("step_failed")).toBe(false);
    expect(isWallFailure("verification_not_sent")).toBe(false);
  });
});
