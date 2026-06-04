import { describe, expect, it } from "vitest";

import { isAgreementCheckboxText } from "../browser.js";

// The deterministic pre-submit guard ticks a checkbox only when its
// associated text reads as a REQUIRED agreement AND not as a marketing
// opt-in. This locks that boundary: terms/privacy/consent in, newsletter
// /offers out. The same two regexes are inlined in the page-eval inside
// `checkRequiredAgreementBoxes` — keep them in sync with this helper.
describe("isAgreementCheckboxText", () => {
  it("matches required terms/privacy/consent agreement copy", () => {
    expect(
      isAgreementCheckboxText(
        "Agree to the terms of use and privacy statements",
      ),
    ).toBe(true);
    // The data-testid alone is enough — amplitude's required box.
    expect(isAgreementCheckboxText("signup-terms-checkbox")).toBe(true);
    expect(isAgreementCheckboxText("I acknowledge the privacy policy")).toBe(
      true,
    );
  });

  it("rejects marketing/newsletter opt-ins even near agreement words", () => {
    expect(
      isAgreementCheckboxText(
        "I'd like to receive emails with product tips, updates, and offers",
      ),
    ).toBe(false);
    expect(isAgreementCheckboxText("newsletter signup")).toBe(false);
  });

  it("rejects empty / non-agreement text", () => {
    expect(isAgreementCheckboxText("")).toBe(false);
    expect(isAgreementCheckboxText("Remember me")).toBe(false);
  });
});
