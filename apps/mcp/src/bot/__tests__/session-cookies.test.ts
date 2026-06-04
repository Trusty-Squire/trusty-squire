// sessionProvidersFromCookies — cookie-jar-backed session detection, the
// ground truth that keeps a warm provider session from going invisible when
// the logged-in-providers.json marker drifts out of sync.

import { describe, expect, it } from "vitest";
import { sessionProvidersFromCookies } from "../browser.js";

const c = (name: string, domain: string, value = "x".repeat(40)) => ({
  name,
  value,
  domain,
});

describe("sessionProvidersFromCookies", () => {
  it("detects a live GitHub session from user_session", () => {
    expect(
      sessionProvidersFromCookies([c("user_session", ".github.com"), c("logged_in", "github.com", "yes")]),
    ).toEqual(["github"]);
  });

  it("detects a live Google session from a *SID cookie", () => {
    expect(sessionProvidersFromCookies([c("__Secure-1PSID", ".google.com")])).toEqual(["google"]);
    expect(sessionProvidersFromCookies([c("SID", "accounts.google.com")])).toEqual(["google"]);
  });

  it("reports BOTH when both sessions are live", () => {
    expect(
      sessionProvidersFromCookies([c("user_session", ".github.com"), c("SID", ".google.com")]).sort(),
    ).toEqual(["github", "google"]);
  });

  it("does NOT count logged-out Google cookies (NID / CONSENT / 1P_JAR)", () => {
    expect(
      sessionProvidersFromCookies([c("NID", ".google.com"), c("CONSENT", ".google.com"), c("1P_JAR", ".google.com")]),
    ).toEqual([]);
  });

  it("ignores an empty/trivial session-cookie value", () => {
    expect(sessionProvidersFromCookies([c("user_session", ".github.com", "")])).toEqual([]);
    expect(sessionProvidersFromCookies([c("user_session", ".github.com", "short")])).toEqual([]);
  });

  it("is host-scoped — a google.com cookie can't pass as github", () => {
    expect(sessionProvidersFromCookies([c("user_session", ".evil-github.com.attacker.net")])).toEqual([]);
    expect(sessionProvidersFromCookies([c("SID", ".notgoogle.com")])).toEqual([]);
  });

  it("returns [] for an empty jar", () => {
    expect(sessionProvidersFromCookies([])).toEqual([]);
  });
});
