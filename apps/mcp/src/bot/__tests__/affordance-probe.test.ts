// Unit tests for the PURE affordance classifier. No browser: feed it a
// synthetic inventory + visible text and assert the affordances it
// derives. The async probeAffordances wrapper (which does the DOM read)
// is exercised by the verify-loop integration test and the CLI probe.

import { describe, expect, it } from "vitest";
import { classifyAffordances } from "../affordance-probe.js";
import type { InteractiveElement } from "../browser.js";

function mk(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "input",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

const GOOGLE_BTN = mk({
  tag: "button",
  visibleText: "Continue with Google",
  selector: "#google-oauth",
});
const GITHUB_BTN = mk({
  tag: "button",
  visibleText: "Continue with GitHub",
  selector: "#github-oauth",
});
const EMAIL_INPUT = mk({ tag: "input", type: "email", selector: "#email" });
const PASSWORD_INPUT = mk({ tag: "input", type: "password", selector: "#pw" });

describe("classifyAffordances", () => {
  it("detects both OAuth providers on a google+github page", () => {
    const a = classifyAffordances([GOOGLE_BTN, GITHUB_BTN], "Sign up");
    expect(a.providers).toEqual(["google", "github"]);
    expect(a.has_email_signup).toBe(false);
    expect(a.card_gate).toBe(false);
    expect(a.interstitial).toBe(false);
  });

  it("detects an email/password signup form", () => {
    const a = classifyAffordances([EMAIL_INPUT, PASSWORD_INPUT], "Create your account");
    expect(a.has_email_signup).toBe(true);
    expect(a.has_email_field).toBe(true);
    expect(a.providers).toEqual([]);
  });

  it("an email field alone is not a full email_signup (no password)", () => {
    const a = classifyAffordances([EMAIL_INPUT], "Enter your email");
    expect(a.has_email_field).toBe(true);
    expect(a.has_email_signup).toBe(false);
  });

  it("flags a card gate from a card input field", () => {
    const cardField = mk({
      tag: "input",
      name: "cardNumber",
      placeholder: "Card number",
      selector: "#card",
    });
    const a = classifyAffordances([cardField], "Add a payment method");
    expect(a.card_gate).toBe(true);
  });

  it("flags a card gate from billing text alone", () => {
    const a = classifyAffordances([], "Please enter your credit card to continue");
    expect(a.card_gate).toBe(true);
  });

  it("flags an anti-bot interstitial from page text", () => {
    const a = classifyAffordances([], "Just a moment... Verifying you are human");
    expect(a.interstitial).toBe(true);
  });

  it("does not flag interstitial once verification passed", () => {
    const a = classifyAffordances([], "Just a moment... Verification successful");
    expect(a.interstitial).toBe(false);
  });

  it("a clean OAuth page shows no card gate and no interstitial", () => {
    const a = classifyAffordances([GOOGLE_BTN], "Welcome — sign up to get started");
    expect(a.providers).toEqual(["google"]);
    expect(a.card_gate).toBe(false);
    expect(a.interstitial).toBe(false);
    expect(a.has_email_signup).toBe(false);
  });
});
