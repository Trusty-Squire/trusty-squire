import { describe, expect, it } from "vitest";
import type { InteractiveElement } from "../browser.js";
import {
  identityFromInteractiveElement,
  identityKey,
  resolveControlIdentity,
  sameControlIdentity,
  type ActControlIdentity,
} from "../act/identity.js";

function el(partial: Partial<InteractiveElement> & Pick<InteractiveElement, "selector">): InteractiveElement {
  return {
    index: 0,
    tag: "a",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: "link",
    labelText: null,
    visibleText: "Reputation",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

const reputation: ActControlIdentity = {
  selector: "#rep",
  frameUrl: "https://app.example.test/dash",
  frameOrigin: "https://app.example.test",
  role: "link",
  label: "Reputation",
  href: "https://app.example.test/reputation",
};

describe("act control identity", () => {
  it("resolves the same control after a remint, not the ordinal's new occupant", () => {
    const reminted = el({
      selector: "#rep",
      visibleText: "Reputation",
      href: "https://app.example.test/reputation",
      frameUrl: "https://app.example.test/dash",
      frameOrigin: "https://app.example.test",
    });
    const trap = el({
      selector: "#new",
      visibleText: "Create app",
      href: "https://app.example.test/new",
      frameUrl: "https://app.example.test/dash",
      frameOrigin: "https://app.example.test",
    });
    expect(resolveControlIdentity([trap, reminted], reputation, "https://app.example.test/dash")).toBe(
      reminted,
    );
    expect(
      resolveControlIdentity(
        [trap],
        { ...reputation, selector: "#new" },
        "https://app.example.test/dash",
      ),
    ).toBeNull();
  });

  it("returns null after navigation so the old page's ref cannot act", () => {
    const otherPage = el({
      selector: "#rep",
      visibleText: "Reputation",
      href: "https://app.example.test/reputation",
      frameUrl: "https://app.example.test/settings",
      frameOrigin: "https://app.example.test",
    });
    expect(
      resolveControlIdentity([otherPage], reputation, "https://app.example.test/settings"),
    ).toBeNull();
  });

  it("treats a unique selector as the same control when labels are read differently", () => {
    expect(
      sameControlIdentity(
        reputation,
        { ...reputation, label: "" },
        "https://app.example.test/dash",
      ),
    ).toBe(true);
    expect(
      sameControlIdentity(
        reputation,
        { ...reputation, selector: "#new", label: "Create app", href: "https://app.example.test/new" },
        "https://app.example.test/dash",
      ),
    ).toBe(false);
  });

  it("treats two same-label links as distinct when destinations differ", () => {
    const a = identityFromInteractiveElement(
      el({
        selector: "#one",
        visibleText: "Docs",
        href: "https://app.example.test/docs",
        frameUrl: "https://app.example.test/",
        frameOrigin: "https://app.example.test",
      }),
      "https://app.example.test/",
    );
    const b = identityFromInteractiveElement(
      el({
        selector: "#two",
        visibleText: "Docs",
        href: "https://help.example.test/docs",
        frameUrl: "https://app.example.test/",
        frameOrigin: "https://app.example.test",
      }),
      "https://app.example.test/",
    );
    expect(identityKey(a, "https://app.example.test/")).not.toBe(
      identityKey(b, "https://app.example.test/"),
    );
  });
});
