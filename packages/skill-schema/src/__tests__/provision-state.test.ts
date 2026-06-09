// The provision state machine: classifier + policy. The autonomy guarantee is
// the headline assertion — only `unknown` ever surfaces, and only after 3
// same-signature attempts.

import { describe, expect, it } from "vitest";
import {
  classifyProvisionState,
  unknownStateSignature,
  type ProvisionState,
} from "../provision-state.js";
import {
  PROVISION_POLICY,
  policyFor,
  shouldEscalate,
  backoffForAttempt,
  UNKNOWN_ESCALATION_THRESHOLD,
} from "../provision-policy.js";

describe("classifyProvisionState", () => {
  it("success wins over everything", () => {
    expect(
      classifyProvisionState({ credential_present: true, failure_kind: "step_failed" }),
    ).toBe("success");
  });

  it("mid-flow: virgin vs authenticated from the page signal", () => {
    expect(classifyProvisionState({})).toBe("virgin");
    expect(classifyProvisionState({ already_signed_in: true })).toBe("authenticated");
  });

  it("email_pending from kind, from the mid-flow signal, but NOT when a terminal kind is set", () => {
    expect(classifyProvisionState({ failure_kind: "email_otp_required" })).toBe("email_pending");
    expect(classifyProvisionState({ awaiting_email: true })).toBe("email_pending");
    // verification_not_sent is OUR-side infra, not email_pending
    expect(classifyProvisionState({ failure_kind: "verification_not_sent" })).toBe("infra");
  });

  it("rate_limited from kind, HTTP 429, or page text", () => {
    expect(classifyProvisionState({ failure_kind: "rate_limited" })).toBe("rate_limited");
    expect(classifyProvisionState({ http_status: 429 })).toBe("rate_limited");
    expect(
      classifyProvisionState({ body_text: "Whoa, slow down — too many requests." }),
    ).toBe("rate_limited");
  });

  it("known walls → wall (auto-skip class)", () => {
    for (const k of [
      "captcha_blocked",
      "anti_bot_blocked",
      "sso_restricted",
      "needs_oauth_provider_session",
      "oauth_consent_needs_review",
      "onboarding_blocked",
      "manual_signup_required",
      "existing_account_no_extract",
    ]) {
      expect(classifyProvisionState({ failure_kind: k })).toBe("wall");
    }
  });

  it("known transients → transient (retry class), not unknown", () => {
    for (const k of [
      "needs_login",
      "oauth_loop_detected",
      "oauth_session_not_persisted",
      "run_timeout",
      "planning_failed",
      "nav_timeout",
      "oauth_required",
      "no_signup_link",
    ]) {
      expect(classifyProvisionState({ failure_kind: k })).toBe("transient");
    }
  });

  it("replay rot kinds → rot", () => {
    for (const k of ["step_failed", "validator_failed", "extraction_failed", "submit_failed"]) {
      expect(classifyProvisionState({ failure_kind: k })).toBe("rot");
    }
  });

  it("a NEVER-SEEN terminal kind → unknown (the only human-surfacing state)", () => {
    expect(classifyProvisionState({ failure_kind: "weird_new_modal_appeared" })).toBe("unknown");
    expect(classifyProvisionState({ failure_kind: "captcha_v9_quantum" })).toBe("unknown");
  });

  it("kinds with ': detail' suffixes classify on the head token", () => {
    expect(
      classifyProvisionState({ failure_kind: "anti_bot_blocked: cloudflare turnstile" }),
    ).toBe("wall");
    expect(
      classifyProvisionState({ failure_kind: "run_timeout: exceeded 600s" }),
    ).toBe("transient");
  });
});

describe("provision policy — autonomy guarantee", () => {
  it("EXACTLY ONE state surfaces to a human: unknown", () => {
    const surfacing = (Object.keys(PROVISION_POLICY) as ProvisionState[]).filter(
      (s) => PROVISION_POLICY[s].surfaces,
    );
    expect(surfacing).toEqual(["unknown"]);
  });

  it("shouldEscalate: only unknown, only at/after the 3rd attempt", () => {
    for (const s of Object.keys(PROVISION_POLICY) as ProvisionState[]) {
      if (s === "unknown") continue;
      // No non-unknown state EVER escalates, at any attempt count.
      for (const n of [1, 3, 10, 100]) expect(shouldEscalate(s, n)).toBe(false);
    }
    expect(shouldEscalate("unknown", 1)).toBe(false);
    expect(shouldEscalate("unknown", 2)).toBe(false);
    expect(shouldEscalate("unknown", UNKNOWN_ESCALATION_THRESHOLD)).toBe(true);
    expect(shouldEscalate("unknown", 4)).toBe(true);
  });

  it("walls auto-skip (skip_unservable), success promotes, rot demotes", () => {
    expect(policyFor("wall").action).toBe("skip_unservable");
    expect(policyFor("success").action).toBe("promote");
    expect(policyFor("rot").action).toBe("demote");
    expect(policyFor("rate_limited").action).toBe("backoff_requeue");
  });

  it("rate_limited backoff grows then caps at 30 min", () => {
    expect(backoffForAttempt("rate_limited", 1)).toBe(60_000);
    expect(backoffForAttempt("rate_limited", 2)).toBe(120_000);
    expect(backoffForAttempt("rate_limited", 10)).toBe(30 * 60_000); // capped
    expect(backoffForAttempt("transient", 1)).toBe(0); // no backoff configured
  });
});

describe("unknownStateSignature", () => {
  it("same page + elements → same signature; different page → different", () => {
    const a = unknownStateSignature({ url: "https://x.io/onboarding?t=1", element_fingerprints: ["button|Next", "radio|sdk"] });
    const b = unknownStateSignature({ url: "https://x.io/onboarding?t=999", element_fingerprints: ["radio|sdk", "button|Next"] });
    expect(a).toBe(b); // query string ignored, element order normalized
    const c = unknownStateSignature({ url: "https://x.io/billing", element_fingerprints: ["button|Pay"] });
    expect(c).not.toBe(a);
  });

  it("is deterministic and tolerates a malformed URL", () => {
    const s1 = unknownStateSignature({ url: "not-a-url", element_fingerprints: ["a"] });
    const s2 = unknownStateSignature({ url: "not-a-url", element_fingerprints: ["a"] });
    expect(s1).toBe(s2);
    expect(s1.length).toBeGreaterThan(0);
  });
});
