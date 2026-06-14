import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  failureCountsTowardDemotion,
  isWallFailure,
  isNavNetworkFailure,
  NAV_TIMEOUT_KIND,
  isReturningUserDivergence,
  ACCOUNT_EXISTS_KIND,
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

  it("nav_timeout is transient and never counts toward demotion", () => {
    // The verifier downgrades a page-never-loaded step_failed to this kind so
    // a transient proxy/tunnel blip can't retire a skill (render, 2026-06-06).
    expect(classifyFailure(NAV_TIMEOUT_KIND)).toBe("transient");
    expect(failureCountsTowardDemotion(NAV_TIMEOUT_KIND)).toBe(false);
  });
});

describe("isNavNetworkFailure", () => {
  it("flags page-never-loaded / network / proxy reasons", () => {
    for (const reason of [
      "step_failed step=0 page.goto: Timeout 60000ms exceeded",
      "page.goto: net::ERR_TIMED_OUT at https://dashboard.render.com/",
      "net::ERR_PROXY_CONNECTION_FAILED",
      "net::ERR_CONNECTION_RESET",
      "Navigation timeout of 30000 ms exceeded",
      "socket hang up",
      "connect ECONNREFUSED 127.0.0.1:1080",
    ]) {
      expect(isNavNetworkFailure(reason)).toBe(true);
    }
  });

  it("does NOT flag genuine selector/validator rot (must still demote)", () => {
    for (const reason of [
      "No element matches text_match={\"contains\":\"Sign up\"}.",
      "No input matches label_hint={\"contains\":\"Email\"}.",
      "validator_failed step=3 got=\"masked-key\" credential failed shape check",
      "Walked entire skill graph without producing a credential.",
    ]) {
      expect(isNavNetworkFailure(reason)).toBe(false);
    }
  });

  it("is null/undefined safe", () => {
    expect(isNavNetworkFailure(null)).toBe(false);
    expect(isNavNetworkFailure(undefined)).toBe(false);
    expect(isNavNetworkFailure("")).toBe(false);
  });
});

describe("isReturningUserDivergence", () => {
  it("flags a step_failed tagged with the returning-user marker", () => {
    const reason =
      "target is disabled (aria-disabled=true) after 6s " +
      "[returning-user: onboarding fill was absent; credential step diverged from fresh-signup capture]";
    expect(isReturningUserDivergence(reason)).toBe(true);
  });

  it("flags the broadened authenticated-session marker (brevo nav-click class)", () => {
    const reason =
      'No element matches text_match="SMTP & API". ' +
      "[returning-user: authenticated session diverged from fresh-signup capture (onboarding/nav element absent — not rot)]";
    expect(isReturningUserDivergence(reason)).toBe(true);
  });

  it("does NOT flag a plain step_failed (genuine rot must still demote)", () => {
    for (const reason of [
      "step_failed step=5 target is disabled (aria-disabled=true) after 6s",
      'No element matches text_match="Create service token".',
      "validator_failed got=\"masked\" shape check",
    ]) {
      expect(isReturningUserDivergence(reason)).toBe(false);
    }
  });

  it("is null/undefined safe", () => {
    expect(isReturningUserDivergence(null)).toBe(false);
    expect(isReturningUserDivergence(undefined)).toBe(false);
    expect(isReturningUserDivergence("")).toBe(false);
  });

  it("the downgraded kind is transient and never counts toward demotion", () => {
    expect(classifyFailure(ACCOUNT_EXISTS_KIND)).toBe("transient");
    expect(failureCountsTowardDemotion(ACCOUNT_EXISTS_KIND)).toBe(false);
  });
});
