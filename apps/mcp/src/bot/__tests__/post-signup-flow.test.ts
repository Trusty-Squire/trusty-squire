import { describe, expect, it } from "vitest";
import {
  PostSignupCredentialTracker,
  classifyNoCredentialPostSignup,
} from "../post-signup-flow.js";

describe("PostSignupFlow terminal failure policy", () => {
  it("returns no failure when no terminal human gate is present", () => {
    const result = classifyNoCredentialPostSignup({
      service: "Example",
      frame: null,
      fallbackText: "Dashboard Create API Key",
      lastDoneReason: null,
    });

    expect(result.gate.kind).toBe("none");
    expect(result.failure).toBeNull();
  });

  it("maps signups-closed pages to a dequeueable terminal failure", () => {
    const result = classifyNoCredentialPostSignup({
      service: "Turbopuffer",
      frame: null,
      fallbackText: "Sign-ups are closed.",
      lastDoneReason: null,
    });

    expect(result.failure?.kind).toBe("signups_closed");
    expect(result.failure?.error).toContain("signups_closed: Turbopuffer");
  });

  it("maps phone gates to onboarding_blocked", () => {
    const result = classifyNoCredentialPostSignup({
      service: "Example",
      frame: null,
      fallbackText: "Verify your phone before creating an API key.",
      lastDoneReason: null,
    });

    expect(result.failure?.kind).toBe("phone");
    expect(result.failure?.error).toContain("phone/SMS verification wall");
  });

  it("folds planner done reason into payment-wall classification", () => {
    const result = classifyNoCredentialPostSignup({
      service: "Koyeb",
      frame: null,
      fallbackText: "Dashboard",
      lastDoneReason: "A credit card required message blocks key creation.",
    });

    expect(result.failure?.kind).toBe("payment");
    expect(result.failure?.error).toContain("payment-method wall");
  });

  it("maps manual review gates to onboarding_blocked", () => {
    const result = classifyNoCredentialPostSignup({
      service: "Example",
      frame: null,
      fallbackText: "Your account is pending approval.",
      lastDoneReason: null,
    });

    expect(result.failure?.kind).toBe("account_review");
    expect(result.failure?.error).toContain("manual review");
  });
});

describe("PostSignupCredentialTracker", () => {
  it("returns a single credential after it appears post-entry", () => {
    const tracker = new PostSignupCredentialTracker({});
    const credentials = { api_key: "sk-live" };
    const progress = tracker.observe(credentials);

    expect(
      tracker.decideEarlyCredentialExit(credentials, progress, 2),
    ).toEqual({
      kind: "single_credential",
      message: "Post-verify: credentials found on round 2.",
    });
  });

  it("does not return seed-only credentials before the planner emits extract", () => {
    const tracker = new PostSignupCredentialTracker({ api_key: "seed" });
    const credentials = { api_key: "seed" };
    const progress = tracker.observe(credentials);

    expect(
      tracker.decideEarlyCredentialExit(credentials, progress, 0),
    ).toBeNull();
  });

  it("allows seed credentials after the planner emits extract", () => {
    const tracker = new PostSignupCredentialTracker({ api_key: "seed" });
    tracker.recordPlannerExtract();
    const credentials = { api_key: "seed" };
    const progress = tracker.observe(credentials);

    expect(
      tracker.decideEarlyCredentialExit(credentials, progress, 1)?.kind,
    ).toBe("single_credential");
  });

  it("holds multi-credential pages open until progress has been stable", () => {
    const tracker = new PostSignupCredentialTracker({});
    expect(tracker.recordPageOffersMultiCred()).toBe(true);
    expect(tracker.recordPageOffersMultiCred()).toBe(false);

    const credentials = {
      application_id: "app-123",
      app_secret: "secret-456",
    };
    expect(
      tracker.decideEarlyCredentialExit(
        credentials,
        tracker.observe(credentials),
        1,
      ),
    ).toBeNull();
    tracker.observe(credentials);
    tracker.observe(credentials);
    const exit = tracker.decideEarlyCredentialExit(
      credentials,
      tracker.observe(credentials),
      4,
    );

    expect(exit).toEqual({
      kind: "stable_multi_credential",
      message:
        "Post-verify: multi-cred bundle stable for 3 rounds — returning what we have (application_id, app_secret).",
    });
  });
});
