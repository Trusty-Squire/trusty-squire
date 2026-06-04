import { describe, expect, it } from "vitest";

import { googleConsentIsBasicFromDom } from "../agent.js";

// Google's newer consent URL hides scope= behind an opaque part= token,
// so the only signal is the visible DOM. googleConsentIsBasicFromDom is
// the gate that recovers a provably basic-only consent (the same thing
// the URL-readable path auto-approves) while keeping the conservative
// abort for anything ambiguous or sensitive.
describe("googleConsentIsBasicFromDom", () => {
  it("returns true for an uploadcare-style basic consent (email + personal info only)", () => {
    const dom = [
      "Uploadcare wants to access your Google Account",
      "This will allow Uploadcare to:",
      "See your primary Google Account email address",
      "See your personal info, including any personal info you've made publicly available",
      "Associate you with your personal info on Google",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(true);
  });

  it("returns false when the consent also lists a contacts grant", () => {
    const dom = [
      "Some App wants to access your Google Account",
      "See your primary Google Account email address",
      "See your personal info",
      "Manage your contacts",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(false);
  });

  it("returns false when the consent lists a files/download grant", () => {
    const dom = [
      "Some App wants to access your Google Account",
      "See your primary Google Account email address",
      "See and download your files in Google Drive",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(false);
  });

  it("returns false for an empty/ambiguous DOM (no recognizable grant wording)", () => {
    expect(googleConsentIsBasicFromDom("")).toBe(false);
    expect(
      googleConsentIsBasicFromDom("Choose an account to continue to Some App"),
    ).toBe(false);
  });

  it("returns false for a danger-only DOM (sensitive scopes, no basic phrases)", () => {
    const dom = [
      "Some App wants to access your Google Account",
      "Send email on your behalf",
      "Manage your contacts",
    ].join("\n");
    expect(googleConsentIsBasicFromDom(dom)).toBe(false);
  });
});
