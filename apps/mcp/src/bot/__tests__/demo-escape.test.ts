// Demo-escape: detect a read-only demo/sandbox the service drops OAuth users
// into (amplitude's app.amplitude.com/analytics/demo) and find the "Create a
// free account" CTA that escapes into the real signup form.
import { describe, expect, it } from "vitest";
import { isSandboxDemoState, findCreateAccountCta } from "../agent.js";
import type { InteractiveElement } from "../browser.js";

function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "a",
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

describe("isSandboxDemoState", () => {
  it("flags amplitude's demo by URL segment", () => {
    expect(isSandboxDemoState("https://app.amplitude.com/analytics/demo/home", "")).toBe(true);
    expect(isSandboxDemoState("https://app.amplitude.com/analytics/demo", "")).toBe(true);
  });
  it("flags explicit demo copy", () => {
    expect(
      isSandboxDemoState("https://x.io/app", "You are currently in the Amplitude Demo. Create a free account"),
    ).toBe(true);
    expect(isSandboxDemoState("https://x.io/app", "This is a demo environment")).toBe(true);
  });
  it("does NOT flag a real dashboard / org", () => {
    expect(isSandboxDemoState("https://app.amplitude.com/analytics/acme-corp/home", "Dashboard")).toBe(false);
    expect(isSandboxDemoState("https://x.io/demolition/report", "Quarterly report")).toBe(false);
    expect(isSandboxDemoState("not a url", "ordinary dashboard")).toBe(false);
  });
});

describe("findCreateAccountCta", () => {
  it("finds the 'Create a free account' CTA (the 'free' the tighter regex misses)", () => {
    const cta = findCreateAccountCta([
      el({ tag: "a", visibleText: "Documentation", selector: "#d" }),
      el({ tag: "button", visibleText: "Create a free account", selector: "#go" }),
    ]);
    expect(cta?.selector).toBe("#go");
  });
  it("matches 'Sign up for free' / 'Create account' variants", () => {
    expect(findCreateAccountCta([el({ tag: "button", visibleText: "Sign up for free", selector: "#a" })])?.selector).toBe("#a");
    expect(findCreateAccountCta([el({ tag: "a", visibleText: "Create account", selector: "#b" })])?.selector).toBe("#b");
  });
  it("returns null when no create-account CTA is present", () => {
    expect(
      findCreateAccountCta([
        el({ tag: "a", visibleText: "Contact us", selector: "#c" }),
        el({ tag: "button", visibleText: "Log in", selector: "#l" }),
      ]),
    ).toBeNull();
  });
});
