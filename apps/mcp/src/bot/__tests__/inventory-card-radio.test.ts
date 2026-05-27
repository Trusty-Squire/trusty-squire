// T38 — card-radio cluster detection. The DOM-side extractor in
// browser.ts captures parent identity + dimensions per element; the
// pure assignCardRadioGroups function then identifies "choose-one"
// wizard cards by sibling clustering. Tests exercise the pure
// function with the shape the DOM-side caller feeds it.
//
// Two layers:
//   - assignCardRadioGroups: pure clustering logic (this file's main subject)
//   - formatInventory: renders [card-radio P/T] when the group field is set

import { describe, expect, it } from "vitest";
import { assignCardRadioGroups, type InteractiveElement } from "../browser.js";
import { formatInventory } from "../agent.js";

// Same helper pattern as f3-inventory.test.ts — fill in defaults so
// tests express only the fields they care about.
function mk(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "div",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "div",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

describe("assignCardRadioGroups — pure clustering", () => {
  it("groups 4 sibling cards with similar dimensions", () => {
    const candidates = [
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 205, height: 152, clickable: true },
      { parentId: 1, width: 198, height: 148, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: true },
    ];
    const out = assignCardRadioGroups(candidates);
    expect(out).toHaveLength(4);
    expect(out.every((g) => g !== null)).toBe(true);
    expect(out.map((g) => g!.position)).toEqual([1, 2, 3, 4]);
    expect(out.every((g) => g!.total === 4)).toBe(true);
    expect(out.every((g) => g!.id === 1)).toBe(true);
  });

  it("does NOT group when widths exceed the 20% tolerance", () => {
    const candidates = [
      { parentId: 1, width: 100, height: 50, clickable: true },
      { parentId: 1, width: 300, height: 50, clickable: true }, // 3× wider
    ];
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("does NOT group when heights exceed the 20% tolerance", () => {
    const candidates = [
      { parentId: 1, width: 200, height: 100, clickable: true },
      { parentId: 1, width: 200, height: 250, clickable: true }, // 2.5× taller
    ];
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("requires at least 2 clickable siblings", () => {
    // Only one of two has a click affordance.
    const candidates = [
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: false },
    ];
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("rejects groups larger than 8 (probably a list, not a wizard)", () => {
    const candidates = Array.from({ length: 9 }, () => ({
      parentId: 1,
      width: 200,
      height: 150,
      clickable: true,
    }));
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("rejects siblings under different parents", () => {
    const candidates = [
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 2, width: 200, height: 150, clickable: true },
    ];
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("ignores candidates with parentId < 0 (orphans / no parent)", () => {
    const candidates = [
      { parentId: -1, width: 200, height: 150, clickable: true },
      { parentId: -1, width: 200, height: 150, clickable: true },
    ];
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("rejects degenerate (zero-sized) candidates", () => {
    const candidates = [
      { parentId: 1, width: 0, height: 0, clickable: true },
      { parentId: 1, width: 0, height: 0, clickable: true },
    ];
    expect(assignCardRadioGroups(candidates).every((g) => g === null)).toBe(true);
  });

  it("assigns distinct group ids for multiple clusters in the same page", () => {
    const candidates = [
      // Parent 1 — 3 cards of size 200x150
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: true },
      // Parent 2 — 2 cards of size 300x100 (a separate wizard step or pair)
      { parentId: 2, width: 300, height: 100, clickable: true },
      { parentId: 2, width: 300, height: 100, clickable: true },
    ];
    const out = assignCardRadioGroups(candidates);
    expect(out[0]?.id).toBe(1);
    expect(out[0]?.total).toBe(3);
    expect(out[3]?.id).toBe(2);
    expect(out[3]?.total).toBe(2);
    expect(new Set(out.slice(0, 3).map((g) => g!.id))).toEqual(new Set([1]));
    expect(new Set(out.slice(3).map((g) => g!.id))).toEqual(new Set([2]));
  });

  it("counts only the clickable members in `total`, ignoring non-clickable siblings", () => {
    // A wizard with 3 visible card-radios + a non-clickable decorative
    // sibling under the same parent. The cluster size for the planner
    // is 3, not 4.
    const candidates = [
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: true },
      { parentId: 1, width: 200, height: 150, clickable: false }, // decorative
    ];
    const out = assignCardRadioGroups(candidates);
    expect(out.filter((g) => g !== null)).toHaveLength(3);
    expect(out.filter((g) => g !== null).every((g) => g!.total === 3)).toBe(true);
    expect(out[3]).toBeNull();
  });

  it("returns an empty result for empty input (no crash)", () => {
    expect(assignCardRadioGroups([])).toEqual([]);
  });
});

describe("formatInventory — card-radio annotation", () => {
  it("appends `[card-radio P/T]` when the group field is set", () => {
    const el = mk({
      index: 7,
      tag: "div",
      visibleText: "Personal use",
      cardRadioGroup: { id: 1, position: 2, total: 4 },
    });
    const rendered = formatInventory([el]);
    expect(rendered).toContain("[card-radio 2/4]");
    expect(rendered).toContain("[7]");
    expect(rendered).toContain('text="Personal use"');
  });

  it("omits the annotation when cardRadioGroup is null", () => {
    const el = mk({
      index: 0,
      tag: "button",
      visibleText: "Submit",
      cardRadioGroup: null,
    });
    expect(formatInventory([el])).not.toContain("card-radio");
  });

  it("omits the annotation when cardRadioGroup is absent (legacy fixtures)", () => {
    // Older test fixtures predate the cardRadioGroup field — the
    // optional-field convention means undefined should render the
    // same as null.
    const el = mk({ index: 0, tag: "button", visibleText: "Submit" });
    expect(formatInventory([el])).not.toContain("card-radio");
  });

  it("renders multiple cluster members in a single inventory string", () => {
    const cards = [1, 2, 3, 4].map((p) =>
      mk({
        index: p - 1,
        tag: "div",
        visibleText: `Option ${p}`,
        cardRadioGroup: { id: 1, position: p, total: 4 },
      }),
    );
    const rendered = formatInventory(cards);
    for (const p of [1, 2, 3, 4]) {
      expect(rendered).toContain(`[card-radio ${p}/4]`);
    }
  });
});
