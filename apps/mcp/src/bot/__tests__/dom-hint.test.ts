// Stable-attribute (name=/id=) click anchor — the Bucket-2 fix for the
// verifier-sweep brittleness: visible text drifts ("Create" → "Create token")
// and goes ambiguous on a fresh user's page ("Next" matching two wizard
// buttons), so the synthesizer now also captures a STABLE name/id when the
// element has one, and the replay matcher prefers a unique dom_hint match.

import { describe, expect, it } from "vitest";
import { isStableDomAttr, pickStableDomHint } from "../promote-to-skill.js";
import { matchesDomHint } from "../replay-skill.js";
import type { InteractiveElement } from "../browser.js";

function el(over: Partial<InteractiveElement>): InteractiveElement {
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
    ...over,
  };
}

describe("testid anchor (strongest stable hint)", () => {
  it("pickStableDomHint prefers a data-testid when present", () => {
    const hint = pickStableDomHint(el({ testId: "create-api-key", id: "btn-x", name: "submit" }));
    expect(hint).toEqual({ testid: "create-api-key", name: "submit", id: "btn-x" });
  });

  it("pickStableDomHint emits testid alone when name/id are absent", () => {
    expect(pickStableDomHint(el({ testId: "copy-key-button" }))).toEqual({ testid: "copy-key-button" });
  });

  it("pickStableDomHint ignores a hash-shaped testid", () => {
    expect(pickStableDomHint(el({ testId: "css-1a2b3c4d" }))).toBeUndefined();
  });

  it("matchesDomHint resolves on testid", () => {
    expect(matchesDomHint(el({ testId: "create-api-key" }), { testid: "create-api-key" })).toBe(true);
    expect(matchesDomHint(el({ testId: "other" }), { testid: "create-api-key" })).toBe(false);
    expect(matchesDomHint(el({ id: "x" }), { testid: "create-api-key" })).toBe(false);
  });

  it("matchesDomHint requires ALL provided anchors to agree", () => {
    expect(matchesDomHint(el({ testId: "k", name: "submit" }), { testid: "k", name: "submit" })).toBe(true);
    expect(matchesDomHint(el({ testId: "k", name: "other" }), { testid: "k", name: "submit" })).toBe(false);
  });
});

describe("isStableDomAttr", () => {
  it("accepts human-authored semantic identifiers", () => {
    for (const v of ["email", "submit", "continue-btn", "api_key_name", "next-step", "google"]) {
      expect(isStableDomAttr(v)).toBe(true);
    }
  });

  it("rejects framework-generated / hashed values", () => {
    for (const v of [
      ":r3:", // React useId
      ":r1a:",
      "css-1a2b3c", // emotion
      "sc-bdfBwQ", // styled-components
      "radix-:r5:-trigger", // radix embeds a React useId
      "a1b2c3d4e5f6", // hex hash
      "field-1234567", // long digit run
      "8f3e9c2a-1b4d-4e7a-9f01-2c3d4e5f6a7b", // uuid
    ]) {
      expect(isStableDomAttr(v)).toBe(false);
    }
  });

  it("rejects null / empty / over-long", () => {
    expect(isStableDomAttr(null)).toBe(false);
    expect(isStableDomAttr("")).toBe(false);
    expect(isStableDomAttr("x".repeat(41))).toBe(false);
  });
});

describe("pickStableDomHint", () => {
  it("captures a stable name and id", () => {
    expect(pickStableDomHint(el({ name: "submit", id: "create-key-btn" }))).toEqual({
      name: "submit",
      id: "create-key-btn",
    });
  });

  it("captures only the stable attribute when the other is generated", () => {
    expect(pickStableDomHint(el({ name: "next", id: ":r7:" }))).toEqual({ name: "next" });
  });

  it("returns undefined when neither attribute is stable (keeps canonical bytes)", () => {
    expect(pickStableDomHint(el({ name: null, id: "css-1x2y3z" }))).toBeUndefined();
    expect(pickStableDomHint(el({}))).toBeUndefined();
  });
});

describe("matchesDomHint", () => {
  it("matches when every specified attribute equals the element's", () => {
    expect(matchesDomHint(el({ name: "next" }), { name: "next" })).toBe(true);
    expect(matchesDomHint(el({ id: "create" }), { id: "create" })).toBe(true);
    expect(matchesDomHint(el({ name: "next", id: "create" }), { name: "next", id: "create" })).toBe(
      true,
    );
  });

  it("does NOT match when a specified attribute differs or is absent", () => {
    expect(matchesDomHint(el({ name: "previous" }), { name: "next" })).toBe(false);
    expect(matchesDomHint(el({ name: null }), { name: "next" })).toBe(false);
    // id specified in the hint but the element only matches on name → no match
    expect(matchesDomHint(el({ name: "next", id: "other" }), { name: "next", id: "create" })).toBe(
      false,
    );
  });

  it("never matches an empty hint", () => {
    expect(matchesDomHint(el({ name: "next" }), {})).toBe(false);
  });
});
