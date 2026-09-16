import { describe, expect, it } from "vitest";
import { threeDsChallengeUrlPattern, threeDsSdkErrorEvidence } from "../browser.js";

// The 3-D Secure challenge detector must recognize BOTH Cardinal ACS
// generations. The modern Braintree/Cardinal 3DS2 flow serves the challenge
// from `.../ThreeDSecure/V2_x/CReq` on a *.cardinalcommerce.com host — a real
// session (Oura, 2026-09) rendered exactly that URL, and the detector missed
// it because it only pinned the legacy `cruise/stepup` path.
describe("threeDsChallengeUrlPattern", () => {
  it("matches the legacy Cardinal cruise/stepup ACS path", () => {
    expect(
      threeDsChallengeUrlPattern.test("https://centinelapi.cardinalcommerce.com/v2/cruise/stepup?jwt=x"),
    ).toBe(true);
  });

  it("matches the modern Cardinal ThreeDSecure CReq ACS path", () => {
    expect(
      threeDsChallengeUrlPattern.test(
        "https://authentication.cardinalcommerce.com/ThreeDSecure/V2_1_0/CReq?jwt=eyJraWQi",
      ),
    ).toBe(true);
  });

  it("matches a generic ACS /CReq endpoint on any host", () => {
    expect(threeDsChallengeUrlPattern.test("https://acs.otherbank.example/CReq?threeDSSessionData=1")).toBe(
      true,
    );
  });

  it("still matches the other cross-processor markers", () => {
    expect(threeDsChallengeUrlPattern.test("https://hooks.stripe.com/3d_secure/acc_1/host")).toBe(true);
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
// rendered page shows just a generic checkout error.
describe("threeDsSdkErrorEvidence", () => {
  it("detects the marker in a request body", () => {
    expect(
      threeDsSdkErrorEvidence({
        network: [
          {
            request_body: '{"event":"3ds_verification.error","code":"THREEDS_CARDINAL_SDK_ERROR"}',
            response_body: null,
          },
        ],
        console: [],
      }),
    ).toBe(true);
  });

  it("detects the marker in a response body", () => {
    expect(
      threeDsSdkErrorEvidence({
        network: [{ request_body: null, response_body: "THREEDS_CARDINAL_SDK_ERROR" }],
        console: [],
      }),
    ).toBe(true);
  });

  it("detects the marker in console output", () => {
    expect(
      threeDsSdkErrorEvidence({
        network: [{ request_body: null, response_body: null }],
        console: [{ text: "BraintreeError THREEDS_CARDINAL_SDK_ERROR: render failed" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors and empty evidence", () => {
    expect(
      threeDsSdkErrorEvidence({
        network: [{ request_body: '{"code":"VALIDATION_ERROR"}', response_body: null }],
        console: [{ text: "Blocked script execution in about:blank" }],
      }),
    ).toBe(false);
    expect(threeDsSdkErrorEvidence({ network: [], console: [] })).toBe(false);
  });
});
