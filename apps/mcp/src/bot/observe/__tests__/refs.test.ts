// Moved alongside elementRef from provision-session.test.ts
// (layer-contracts PR 9 — the observe module split; implementation now in
// ../refs.ts).
import { describe, expect, it } from "vitest";
import type { InteractiveElement } from "../../browser.js";
import { elementRef } from "../refs.js";

// Minimal InteractiveElement factory — only the fields targeting reads matter;
// the rest get inert defaults so the fixtures stay readable.
function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "button",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

describe("elementRef", () => {
  it("prefers visibleText, then falls back through the label chain", () => {
    expect(elementRef(el({ visibleText: "Continue with Google" }))).toBe("Continue with Google");
    expect(elementRef(el({ visibleText: null, ariaLabel: "Show key" }))).toBe("Show key");
    expect(elementRef(el({ visibleText: null, placeholder: "Organization name" }))).toBe(
      "Organization name",
    );
  });

  it("falls back to tag#index when there is no label at all", () => {
    expect(elementRef(el({ tag: "input", index: 7 }))).toBe("input#7");
  });
});
