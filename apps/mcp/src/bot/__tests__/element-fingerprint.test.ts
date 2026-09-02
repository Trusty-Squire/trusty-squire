import { describe, expect, it } from "vitest";
import { elementFingerprints, isFrameworkRandomDomId } from "../element-fingerprint.js";
import type { InteractiveElement } from "../browser.js";

function element(overrides: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: "button",
    labelText: null,
    visibleText: null,
    selector: "button",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...overrides,
  };
}

function fingerprintsOf(elements: readonly InteractiveElement[]): string[] {
  const map = elementFingerprints(elements);
  return elements.map((el) => map.get(el)!);
}

describe("element fingerprints", () => {
  it("rejects framework-random ids and accepts authored ones", () => {
    // React useId, and the libraries that embed it.
    expect(isFrameworkRandomDomId(":r3:")).toBe(true);
    expect(isFrameworkRandomDomId(":R1abc:-form-item")).toBe(true);
    expect(isFrameworkRandomDomId("radix-:r7:-trigger")).toBe(true);
    // Render-scoped counters and generated tokens.
    expect(isFrameworkRandomDomId("mui-482193")).toBe(true);
    expect(isFrameworkRandomDomId("field-1234567")).toBe(true);
    expect(isFrameworkRandomDomId("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
    expect(isFrameworkRandomDomId("   ")).toBe(true);
    // Authored ids.
    expect(isFrameworkRandomDomId("checkout-email")).toBe(false);
    expect(isFrameworkRandomDomId("address_line1")).toBe(false);
    expect(isFrameworkRandomDomId("step2")).toBe(false);
  });

  it("keys on an authored id and ignores everything volatile around it", () => {
    const before = element({ id: "checkout-email", tag: "input", selector: "#checkout-email" });
    const after = element({
      id: "checkout-email",
      tag: "input",
      // A re-render: new CSS-in-JS selector, a validation message now labels it,
      // and the user's typed value is present.
      selector: ".css-1x9dk2p > input:nth-child(3)",
      ariaLabel: "Email address (required)",
      value: "buyer@example.com",
      required: true,
    });
    expect(fingerprintsOf([before])).toEqual(fingerprintsOf([after]));
  });

  it("falls back to the structural signal when the id is framework-random", () => {
    const first = element({
      id: ":r1:",
      screenPath: "form:signup > button:continue",
      visibleText: "Continue",
    });
    const rerendered = element({
      id: ":r9:",
      screenPath: "form:signup > button:continue",
      visibleText: "Continue",
      selector: "button.rerendered",
    });
    expect(fingerprintsOf([first])).toEqual(fingerprintsOf([rerendered]));
    expect(fingerprintsOf([first])[0]).not.toContain(":r1:");
  });

  it("refuses a duplicated id and separates the siblings structurally", () => {
    const [left, right] = fingerprintsOf([
      element({ id: "dup", screenPath: "main > button:add", visibleText: "Add to cart" }),
      element({ id: "dup", screenPath: "main > button:add", visibleText: "Add to cart" }),
    ]);
    expect(left).not.toBe(right);
    expect(left).not.toContain("dup");
  });

  it("gives two same-named grid controls distinct fingerprints", () => {
    const grid = [0, 1, 2].map((index) =>
      element({
        index,
        screenPath: "main:products > button:add-to-cart",
        visibleText: "Add to cart",
        selector: `.product:nth-child(${index + 1}) button`,
      }),
    );
    expect(new Set(fingerprintsOf(grid)).size).toBe(3);
  });

  it("scopes fingerprints to their frame", () => {
    const main = element({ id: "pan", screenPath: "form > input:pan" });
    const framed = element({
      id: "pan",
      screenPath: "form > input:pan",
      frameOrigin: "https://pay.example",
      framePath: "0",
    });
    const [mainFp, framedFp] = fingerprintsOf([main, framed]);
    expect(mainFp).not.toBe(framedFp);
  });
});
