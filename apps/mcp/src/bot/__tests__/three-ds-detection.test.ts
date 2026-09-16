import { describe, expect, it } from "vitest";
import {
  THREE_DS_SDK_ERROR_EVIDENCE_WINDOW_MS,
  threeDsChallengeUrlPattern,
  threeDsSdkErrorEvidenceIsFresh,
} from "../browser.js";
import { isThreeDsSdkErrorText } from "../operator-evidence.js";

// The 3-D Secure challenge detector must keep recognizing BOTH Cardinal ACS
// generations. The modern Braintree/Cardinal 3DS2 flow serves the challenge
// from `.../ThreeDSecure/V2_x/CReq` on a *.cardinalcommerce.com host (a real
// session — Oura, 2026-09 — rendered exactly that URL), which the pattern
// already covers through its `threeDSecure` word alternative rather than any
// Cardinal-specific branch. These cases pin that, so tightening the pattern
// back to `cruise/stepup` only would be caught.
describe("threeDsChallengeUrlPattern", () => {
  it("matches the legacy Cardinal cruise/stepup ACS path", () => {
    expect(
      threeDsChallengeUrlPattern.test(
        "https://centinelapi.cardinalcommerce.com/v2/cruise/stepup?jwt=x",
      ),
    ).toBe(true);
  });

  it("matches the modern Cardinal ThreeDSecure/V2_x/CReq ACS path via its threeDSecure alternative", () => {
    expect(
      threeDsChallengeUrlPattern.test(
        "https://authentication.cardinalcommerce.com/ThreeDSecure/V2_1_0/CReq?jwt=eyJraWQi",
      ),
    ).toBe(true);
    expect(
      threeDsChallengeUrlPattern.test(
        "https://authentication.cardinalcommerce.com/ThreeDSecure/CReq",
      ),
    ).toBe(true);
  });

  it("still matches the other cross-processor markers", () => {
    expect(threeDsChallengeUrlPattern.test("https://hooks.stripe.com/3d_secure/acc_1/host")).toBe(
      true,
    );
    expect(threeDsChallengeUrlPattern.test("https://3ds.example.com/acs/step1")).toBe(true);
  });

  it("does not match ordinary checkout or songbird asset URLs", () => {
    expect(threeDsChallengeUrlPattern.test("https://ouraring.com/checkout")).toBe(false);
    expect(
      threeDsChallengeUrlPattern.test(
        "https://static.client.cardinaltrusted.com/songbird/v2.1.0/23b3df1457c086be34d2/701.23b3df1457c086be34d2.songbird.js",
      ),
    ).toBe(false);
    expect(threeDsChallengeUrlPattern.test("https://pay.example.com/credit")).toBe(false);
  });
});

// When Cardinal's ACS render races its own UI-framework chunk load and loses,
// braintree-web reports THREEDS_CARDINAL_SDK_ERROR through the page's own
// telemetry — the only durable evidence the operator can read, since the
// rendered page shows just a generic checkout error. The collector classifies
// each captured record once, at capture time.
describe("isThreeDsSdkErrorText", () => {
  it("detects the marker in a captured body", () => {
    expect(
      isThreeDsSdkErrorText(
        '{"event":"3ds_verification.error","code":"THREEDS_CARDINAL_SDK_ERROR"}',
      ),
    ).toBe(true);
  });

  it("detects the marker in captured console output", () => {
    expect(isThreeDsSdkErrorText("BraintreeError THREEDS_CARDINAL_SDK_ERROR: render failed")).toBe(
      true,
    );
  });

  it("returns false for unrelated errors and absent text", () => {
    expect(isThreeDsSdkErrorText('{"code":"VALIDATION_ERROR"}')).toBe(false);
    expect(isThreeDsSdkErrorText("Blocked script execution in about:blank")).toBe(false);
    expect(isThreeDsSdkErrorText(null)).toBe(false);
  });
});

// The SDK-error state tells the agent to resubmit the payment, so it must stop
// being reported well before a later order confirmation could be read that way
// — a double-purchase hazard. The capture-time latch is never cleared; the
// freshness window alone bounds it.
describe("threeDsSdkErrorEvidenceIsFresh", () => {
  const now = 1_700_000_000_000;

  it("is false when the marker was never captured", () => {
    expect(threeDsSdkErrorEvidenceIsFresh(null, now)).toBe(false);
  });

  it("is true for a marker captured inside the window", () => {
    expect(threeDsSdkErrorEvidenceIsFresh(now, now)).toBe(true);
    expect(threeDsSdkErrorEvidenceIsFresh(now - THREE_DS_SDK_ERROR_EVIDENCE_WINDOW_MS, now)).toBe(
      true,
    );
  });

  it("is false once the marker ages past the window", () => {
    expect(
      threeDsSdkErrorEvidenceIsFresh(now - THREE_DS_SDK_ERROR_EVIDENCE_WINDOW_MS - 1, now),
    ).toBe(false);
  });
});
