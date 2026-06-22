// isContinuationFormStep — after a clean submit, distinguish a CONTINUATION
// form step (amplitude's dedicated "Create your password" page) from a
// dashboard / verify-email / login page, so the bot fills the next step
// instead of polling the inbox for mail that never comes.
import { describe, expect, it } from "vitest";
import { isContinuationFormStep } from "../agent.js";
import type { InteractiveElement } from "../browser.js";

function el(over: Partial<InteractiveElement>): InteractiveElement {
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

const PASSWORD = el({ tag: "input", type: "password", value: "", selector: "#pw" });
const CREATE_BTN = el({ tag: "button", visibleText: "Create Account", selector: "#go" });

describe("isContinuationFormStep", () => {
  it("flags amplitude's 'Create your password' step (empty password + create button)", () => {
    expect(
      isContinuationFormStep("Create your password Create Account Return to Signup", [
        PASSWORD,
        CREATE_BTN,
      ]),
    ).toBe(true);
  });

  it("flags Arize-style post-OAuth 'Create New Password' steps", () => {
    expect(
      isContinuationFormStep("Create New Password New Password Confirm Password Continue", [
        el({ tag: "input", type: "password", value: "", labelText: "New Password", selector: "#new" }),
        el({ tag: "input", type: "password", value: "", labelText: "Confirm Password", selector: "#confirm" }),
        el({ tag: "button", visibleText: "Continue", selector: "#continue" }),
      ]),
    ).toBe(true);
  });

  it("does NOT flag a settled dashboard (no password field)", () => {
    expect(
      isContinuationFormStep("API Keys Dashboard Default Project", [
        el({ tag: "a", visibleText: "API Keys", selector: "#k" }),
      ]),
    ).toBe(false);
  });

  it("flags Paddle-style business-details wizard steps", () => {
    expect(
      isContinuationFormStep("Business details Part 1 of 2 Annual revenue Continue", [
        el({ tag: "input", type: "text", value: "", labelText: "Business name", selector: "#business" }),
        el({ tag: "select", value: "", labelText: "Business type", selector: "#type" }),
        el({ tag: "select", value: "", labelText: "What's your annual revenue?", selector: "#revenue" }),
        el({ tag: "input", type: "text", value: "", labelText: "Website address", selector: "#website" }),
        el({ tag: "button", visibleText: "Continue", selector: "#go" }),
      ]),
    ).toBe(true);
  });

  it("does NOT flag a verify-your-email screen (handled by the inbox poll)", () => {
    // Even with a password field present, a check-your-email page is not a
    // continuation we re-fill.
    expect(
      isContinuationFormStep("Please check your email to verify your account", [
        PASSWORD,
        CREATE_BTN,
      ]),
    ).toBe(false);
  });

  it("does NOT flag a login page (password field belongs to 'sign in')", () => {
    expect(
      isContinuationFormStep("Sign in to your account Welcome back Password Sign in", [
        PASSWORD,
        el({ tag: "button", visibleText: "Sign in", selector: "#si" }),
      ]),
    ).toBe(false);
  });

  it("does NOT fire when the password field is already filled", () => {
    expect(
      isContinuationFormStep("Create your password Create Account", [
        el({ tag: "input", type: "password", value: "hunter2", selector: "#pw" }),
        CREATE_BTN,
      ]),
    ).toBe(false);
  });

  it("does NOT fire with a password field but no submit/continue control", () => {
    expect(isContinuationFormStep("Create your password", [PASSWORD])).toBe(false);
  });
});
