import { describe, expect, it } from "vitest";
import type { ObservationFrame } from "../observation-frame.js";
import { classifyObservationFrame } from "../state-classifier.js";
import type { InteractiveElement } from "../browser.js";

function frame(input: {
  url?: string;
  title?: string;
  visibleText?: string;
  html?: string;
  inventory?: Partial<InteractiveElement>[];
}): ObservationFrame {
  return {
    frameId: "frame-test",
    capturedAt: "2026-06-18T00:00:00.000Z",
    visibleText: input.visibleText ?? "",
    domDigest: "0".repeat(64),
    state: {
      url: input.url ?? "https://example.com/signup",
      title: input.title ?? "",
      html: input.html ?? "<html></html>",
      screenshot: "",
    },
    inventory: (input.inventory ?? []).map((partial, index) => ({
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

describe("classifyObservationFrame", () => {
  it("classifies account review gates", () => {
    const verdict = classifyObservationFrame(frame({ visibleText: "Your account is in a waiting room pending review." }));
    expect(verdict.state).toBe("account_review_gate");
  });

  it("classifies managed captcha gates", () => {
    const verdict = classifyObservationFrame(frame({ visibleText: "Please complete the verification challenge." }));
    expect(verdict.state).toBe("captcha_gate");
  });

  it("classifies API key create surfaces", () => {
    const verdict = classifyObservationFrame(frame({
      visibleText: "API keys",
      inventory: [{ visibleText: "Create API Key" }],
    }));
    expect(verdict.state).toBe("api_key_create_modal");
  });

  it("classifies signup forms from inventory", () => {
    const verdict = classifyObservationFrame(frame({
      inventory: [
        { tag: "input", type: "email", labelText: "Email" },
        { tag: "input", type: "password", labelText: "Password" },
      ],
    }));
    expect(verdict.state).toBe("signup_form");
  });

  it("keeps terminal billing gates higher precedence than key affordances", () => {
    const verdict = classifyObservationFrame(frame({
      visibleText: "Billing setup required before API keys can be created.",
      inventory: [{ visibleText: "Create API Key" }],
    }));
    expect(verdict.state).toBe("payment_gate");
  });

  it("does not treat a billing navigation item as a terminal payment gate", () => {
    const verdict = classifyObservationFrame(frame({
      visibleText: "API keys Billing Usage",
      inventory: [{ visibleText: "Create API Key" }],
    }));
    expect(verdict.state).toBe("api_key_create_modal");
  });

  it("does not treat subscribe/update copy as a terminal payment gate", () => {
    const verdict = classifyObservationFrame(frame({
      visibleText: "API keys Subscribe to updates Checkout our docs",
      inventory: [{ visibleText: "Create API Key" }],
    }));
    expect(verdict.state).toBe("api_key_create_modal");
  });
});
