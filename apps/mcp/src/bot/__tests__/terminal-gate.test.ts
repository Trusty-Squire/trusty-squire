import { describe, expect, it } from "vitest";
import type { InteractiveElement } from "../browser.js";
import type { ObservationFrame } from "../observation-frame.js";
import { classifyTerminalGate } from "../terminal-gate.js";

function frame(visibleText: string, inventory: Partial<InteractiveElement>[] = []): ObservationFrame {
  return {
    frameId: "frame-test",
    capturedAt: "2026-06-18T00:00:00.000Z",
    visibleText,
    domDigest: "0".repeat(64),
    state: {
      url: "https://example.com/dashboard",
      title: "",
      html: "<html></html>",
      screenshot: "",
    },
    inventory: inventory.map((partial, index) => ({
      index,
      tag: partial.tag ?? "button",
      type: partial.type ?? null,
      id: partial.id ?? null,
      name: partial.name ?? null,
      placeholder: partial.placeholder ?? null,
      ariaLabel: partial.ariaLabel ?? null,
      role: partial.role ?? null,
      labelText: partial.labelText ?? null,
      visibleText: partial.visibleText ?? null,
      selector: partial.selector ?? `#x-${index}`,
      visible: partial.visible ?? true,
      inViewport: partial.inViewport ?? true,
      inConsentWidget: partial.inConsentWidget ?? false,
      href: partial.href,
      iconLabel: partial.iconLabel,
    })) as InteractiveElement[],
  };
}

describe("classifyTerminalGate", () => {
  it("folds the planner done reason into terminal classification", () => {
    const verdict = classifyTerminalGate({
      frame: frame("Dashboard"),
      fallbackText: "Dashboard",
      lastDoneReason: "A credit card required message blocks key creation.",
    });
    expect(verdict.kind).toBe("payment");
    expect(verdict.text).toMatch(/credit card required/);
  });

  it("prefers phone gates over generic payment predicates", () => {
    const verdict = classifyTerminalGate({
      frame: frame("Verify your phone before creating an API key."),
      fallbackText: "Verify your phone before creating an API key.",
      lastDoneReason: "A credit card required message is also visible.",
    });
    expect(verdict.kind).toBe("phone");
  });

  it("keeps signups-closed terminal above other gates", () => {
    const verdict = classifyTerminalGate({
      frame: frame("Sign-ups are closed. Verify your phone to continue."),
      fallbackText: "Sign-ups are closed. Verify your phone to continue.",
      lastDoneReason: "A credit card required message is also visible.",
    });
    expect(verdict.kind).toBe("signups_closed");
  });

  it("classifies account-review gates", () => {
    const verdict = classifyTerminalGate({
      frame: frame("Your account is pending approval."),
      fallbackText: "Your account is pending approval.",
      lastDoneReason: null,
    });
    expect(verdict.kind).toBe("account_review");
  });

  it("classifies authenticated permission-denied app shells", () => {
    const verdict = classifyTerminalGate({
      frame: frame("Loading... Error: You do not have enough permissions to execute this request"),
      fallbackText: "Loading... Error: You do not have enough permissions to execute this request",
      lastDoneReason: null,
    });
    expect(verdict.kind).toBe("permission_denied");
  });

  it("does not classify an active legal onboarding form as account review", () => {
    const visibleText =
      "Start building with Claude. What’s your full name? What should we call you? " +
      "I am at least 18 years old, agree to Commercial Terms and Usage Policy, " +
      "and acknowledge the Privacy Policy. Continue";
    const verdict = classifyTerminalGate({
      frame: frame(visibleText, [
        { tag: "input", type: "text", name: "fullname", labelText: "What’s your full name?" },
        { tag: "input", type: "text", name: "displayname", labelText: "What should we call you?" },
        { tag: "span", role: "checkbox", ariaLabel: "Accept terms" },
        { tag: "button", visibleText: "Continue" },
      ]),
      fallbackText: visibleText,
      lastDoneReason: "Planner thought the user was in an account review flow.",
    });
    expect(verdict.stateVerdict?.state).toBe("account_review_gate");
    expect(verdict.kind).toBe("none");
  });

  it("keeps explicit approval language terminal even when a form is visible", () => {
    const visibleText =
      "We need more information to approve your account. " +
      "I agree to the Terms and Privacy Policy. Continue";
    const verdict = classifyTerminalGate({
      frame: frame(visibleText, [
        { tag: "input", type: "text", name: "company", labelText: "Company name" },
        { tag: "input", type: "checkbox", labelText: "I agree to the Terms" },
        { tag: "button", visibleText: "Continue" },
      ]),
      fallbackText: visibleText,
      lastDoneReason: null,
    });
    expect(verdict.kind).toBe("account_review");
  });

  it("does not treat paywall negation as a payment wall", () => {
    const verdict = classifyTerminalGate({
      frame: frame("No credit card required. Create API Key."),
      fallbackText: "No credit card required. Create API Key.",
      lastDoneReason: null,
    });
    expect(verdict.kind).toBe("none");
  });

  it("does not promote negated payment-required copy to a terminal wall", () => {
    const verdict = classifyTerminalGate({
      frame: frame("No payment required. Create API Key."),
      fallbackText: "No payment required. Create API Key.",
      lastDoneReason: null,
    });
    expect(verdict.stateVerdict?.state).toBe("payment_gate");
    expect(verdict.kind).toBe("none");
  });

  it("does not promote negated payment-method-required copy to a terminal wall", () => {
    const verdict = classifyTerminalGate({
      frame: frame("No payment method required. Create API Key."),
      fallbackText: "No payment method required. Create API Key.",
      lastDoneReason: null,
    });
    expect(verdict.stateVerdict?.state).toBe("payment_gate");
    expect(verdict.kind).toBe("none");
  });

  it("uses fallback text even when no frame was captured", () => {
    const verdict = classifyTerminalGate({
      frame: null,
      fallbackText: "Please add a payment method to create an API key.",
      lastDoneReason: null,
    });
    expect(verdict.kind).toBe("payment");
    expect(verdict.stateVerdict).toBeNull();
  });

  it("uses specific terminal predicates when the generic frame classifier is unknown", () => {
    const verdict = classifyTerminalGate({
      frame: frame("Console"),
      fallbackText: "Console",
      lastDoneReason: "This page shows a payment form before creating credentials.",
    });
    expect(verdict.stateVerdict?.state).toBe("unknown");
    expect(verdict.kind).toBe("payment");
  });
});
