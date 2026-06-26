import { describe, it, expect } from "vitest";
import { normalizeFailureKind, isTransient, failureCountsTowardDemotion } from "../classify.js";
import type { FailureKind } from "../types.js";

describe("normalizeFailureKind", () => {
  it("passes through known kinds", () => {
    for (const k of ["nav_timeout", "login_wall", "no_credentials", "other"] as FailureKind[]) {
      expect(normalizeFailureKind(k)).toBe(k);
    }
  });

  it("maps login/session/anti-bot synonyms to login_wall", () => {
    expect(normalizeFailureKind("needs_login")).toBe("login_wall");
    expect(normalizeFailureKind("Google session dead")).toBe("login_wall");
    expect(normalizeFailureKind("anti-bot interstitial")).toBe("login_wall");
  });

  it("maps captcha synonyms", () => {
    expect(normalizeFailureKind("Turnstile challenge")).toBe("captcha_blocked");
    expect(normalizeFailureKind("recaptcha")).toBe("captcha_blocked");
  });

  it("maps nav/network synonyms", () => {
    expect(normalizeFailureKind("navigation timed out")).toBe("nav_timeout");
    expect(normalizeFailureKind("ECONNRESET")).toBe("nav_timeout");
  });

  it("maps account-exists + no-credential synonyms", () => {
    expect(normalizeFailureKind("account already registered")).toBe("account_exists");
    expect(normalizeFailureKind("no api key found")).toBe("no_credentials");
  });

  it("defaults empty/undefined/unknown to other", () => {
    expect(normalizeFailureKind(undefined)).toBe("other");
    expect(normalizeFailureKind("")).toBe("other");
    expect(normalizeFailureKind("???")).toBe("other");
  });
});

describe("transient vs real (the demote-counter rule)", () => {
  it("treats transient kinds as not counting toward demotion", () => {
    for (const k of [
      "nav_timeout",
      "account_exists",
      "brittle_probe",
      "login_wall",
      "captcha_blocked",
    ] as FailureKind[]) {
      expect(isTransient(k)).toBe(true);
      expect(failureCountsTowardDemotion(k)).toBe(false);
    }
  });

  it("counts real kinds toward demotion", () => {
    for (const k of ["no_credentials", "step_failed", "other"] as FailureKind[]) {
      expect(isTransient(k)).toBe(false);
      expect(failureCountsTowardDemotion(k)).toBe(true);
    }
  });
});
