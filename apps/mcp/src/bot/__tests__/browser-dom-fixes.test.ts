// Regression tests for the two browser.ts DOM-robustness fixes that landed
// in PR #90 (issues #61 weaviate, #59 redis-cloud). Both were Descope
// web-component shapes that crashed/blocked a run before the planner saw the
// page. The load-bearing logic is extracted into pure helpers so it can be
// exercised without a live browser.

import { describe, it, expect } from "vitest";
import {
  pickClickLocator,
  collectAcrossShadowRoots,
  isBareClickableCardTag,
} from "../browser.js";

describe("pickClickLocator — strict-mode click disambiguation (regression #61)", () => {
  // FakeLoc satisfies the helper's `L extends { first(): L }` constraint.
  type FakeLoc = { first: () => FakeLoc; id: string };
  const firstMatch: FakeLoc = { first: () => firstMatch, id: "first" };
  const locator: FakeLoc = { first: () => firstMatch, id: "locator" };

  it("narrows to .first() when the selector matches more than one element", () => {
    // Descope stamps the same id on the web component AND its text node → 2
    // matches → strict-mode throw. .first() is the documented fix.
    expect(pickClickLocator(locator, 2).id).toBe("first");
    expect(pickClickLocator(locator, 5).id).toBe("first");
  });

  it("uses the locator unchanged when it is unique (count 1)", () => {
    expect(pickClickLocator(locator, 1).id).toBe("locator");
  });

  it("uses the locator unchanged when count is 0 (no regression on the no-match path)", () => {
    // count() can return 0; the old behavior (bare locator → waitFor → time
    // out) must be preserved, not silently turned into a .first() on nothing.
    expect(pickClickLocator(locator, 0).id).toBe("locator");
  });
});

describe("collectAcrossShadowRoots — guard against roots with no querySelectorAll (regression #59)", () => {
  type Root = Parameters<typeof collectAcrossShadowRoots>[0];
  type FakeEl = { shadowRoot: Root; tag: string };

  const el = (tag: string, shadowRoot: Root = null): FakeEl => ({ shadowRoot, tag });
  // Mirrors how the walk queries: "*" yields the elements to recurse into,
  // any other selector yields the matches to collect.
  const root = (matches: FakeEl[], children: FakeEl[] = []): Root =>
    ({ querySelectorAll: (sel: string) => (sel === "*" ? children : matches) }) as Root;
  const tagsOf = (els: ReturnType<typeof collectAcrossShadowRoots>): string[] =>
    els.map((e) => (e as { tag?: string }).tag ?? "?");

  it("collects matches from a normal root", () => {
    expect(tagsOf(collectAcrossShadowRoots(root([el("a"), el("b")]), "sel"))).toEqual(["a", "b"]);
  });

  it("does not throw when the top-level root has no querySelectorAll", () => {
    const malformed = {} as Root; // detached/closed node → querySelectorAll undefined
    expect(() => collectAcrossShadowRoots(malformed, "sel")).not.toThrow();
    expect(collectAcrossShadowRoots(malformed, "sel")).toEqual([]);
  });

  it("does not throw when a NESTED shadow root has no querySelectorAll (the #59 crash)", () => {
    const malformedShadow = {} as Root; // the Descope shadowRoot that crashed inventory
    const host = el("host", malformedShadow);
    const tree = root([el("match")], [host]);
    let out: ReturnType<typeof collectAcrossShadowRoots> = [];
    expect(() => {
      out = collectAcrossShadowRoots(tree, "sel");
    }).not.toThrow();
    // The valid match is still collected — the bad subtree is skipped, not fatal.
    expect(tagsOf(out)).toContain("match");
  });

  it("does not throw when a nested shadowRoot is `undefined` (the 2026-06-03 #59 recurrence)", () => {
    // The crash the null-only guard missed: `Element.shadowRoot` is typed
    // `ShadowRoot | null`, but a detached/closed custom element yields
    // `undefined`. The recursion calls walk() on any non-null shadowRoot,
    // so `undefined` reached `typeof undefined.querySelectorAll` and threw
    // "Cannot read properties of undefined (reading 'querySelectorAll')" —
    // exactly redis-cloud's live failure. The loose `== null` guard fixes it.
    const host = el("host", undefined);
    const tree = root([el("match")], [host]);
    let out: ReturnType<typeof collectAcrossShadowRoots> = [];
    expect(() => {
      out = collectAcrossShadowRoots(tree, "sel");
    }).not.toThrow();
    expect(tagsOf(out)).toContain("match");
  });

  it("does not throw when the top-level root is `undefined`", () => {
    expect(() => collectAcrossShadowRoots(undefined, "sel")).not.toThrow();
    expect(collectAcrossShadowRoots(undefined, "sel")).toEqual([]);
  });

  it("still pierces well-formed nested shadow roots", () => {
    const inner = root([el("inner")]);
    const host = el("host", inner);
    const tree = root([el("outer")], [host]);
    expect(tagsOf(collectAcrossShadowRoots(tree, "sel")).sort()).toEqual(["inner", "outer"]);
  });
});

describe("isBareClickableCardTag — custom-element chip eligibility (1inch)", () => {
  it("accepts the generic container tags the div-only scan already covered", () => {
    for (const t of ["div", "li", "article", "section", "label"]) {
      expect(isBareClickableCardTag(t)).toBe(true);
    }
  });

  it("accepts a custom element (hyphenated tag) — the 1inch uikit chip", () => {
    // <uikit-internal-chip data-test-id="activity-chip-aiAgents"> — the tag the
    // old div-only scan missed, so the chip never reached the inventory.
    expect(isBareClickableCardTag("uikit-internal-chip")).toBe(true);
    expect(isBareClickableCardTag("my-card")).toBe(true);
  });

  it("is case-insensitive (DOM tagName is uppercase)", () => {
    expect(isBareClickableCardTag("UIKIT-INTERNAL-CHIP")).toBe(true);
    expect(isBareClickableCardTag("DIV")).toBe(true);
  });

  it("rejects standard interactive/text tags handled by the SELECTOR walk", () => {
    for (const t of ["span", "p", "h1", "a", "button", "input", "svg"]) {
      expect(isBareClickableCardTag(t)).toBe(false);
    }
  });
});
