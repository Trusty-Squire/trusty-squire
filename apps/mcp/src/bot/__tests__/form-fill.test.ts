// Unit tests for the pure form-fill no-progress / stuck-loop primitives
// (strangler slice 3 — DESIGN-form-fill-engine.md). Browser-free. Pins the F14
// behaviors that caused the kinde/Railway false-bails.

import { describe, expect, it } from "vitest";
import {
  computePageSig,
  isStuckRepeat,
  nextNoProgressSet,
  pageMovedSince,
} from "../form-fill.js";

describe("computePageSig / pageMovedSince", () => {
  it("fingerprints url + the sorted selector set (selector order doesn't matter)", () => {
    expect(computePageSig("https://x/signup", ["#b", "#a"])).toBe(computePageSig("https://x/signup", ["#a", "#b"]));
  });
  it("a changed URL OR a changed selector set = page moved", () => {
    const a = computePageSig("https://x/signup", ["#a", "#b"]);
    expect(pageMovedSince(a, computePageSig("https://x/step2", ["#a", "#b"]))).toBe(true); // url changed
    expect(pageMovedSince(a, computePageSig("https://x/signup", ["#a", "#b", "#c"]))).toBe(true); // field gained
    expect(pageMovedSince(a, computePageSig("https://x/signup", ["#a", "#b"]))).toBe(false); // identical
  });
  it("no prior sig (first round) is never a move", () => {
    expect(pageMovedSince(null, computePageSig("https://x", ["#a"]))).toBe(false);
  });
});

describe("isStuckRepeat (F14)", () => {
  const dead = new Set(["#next"]);
  it("a click-only plan re-picking ONLY dead selectors is stuck", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next"], planEditsAField: false, noProgressSelectors: dead })).toBe(true);
  });
  it("NOT stuck when the plan adds a new selector (legitimate exploration)", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next", "#newlink"], planEditsAField: false, noProgressSelectors: dead })).toBe(false);
  });
  it("NOT stuck when the plan ALSO edits a field (kinde: tick box + re-click Next)", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next"], planEditsAField: true, noProgressSelectors: dead })).toBe(false);
  });
  it("NOT stuck on a pure fill plan (no clicks)", () => {
    expect(isStuckRepeat({ planClickSelectors: [], planEditsAField: true, noProgressSelectors: dead })).toBe(false);
  });
  it("NOT stuck with no dead-selector memory yet (first no-progress round)", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next"], planEditsAField: false, noProgressSelectors: new Set() })).toBe(false);
  });
});

describe("nextNoProgressSet", () => {
  it("records the click selectors after a no-progress round", () => {
    expect([...nextNoProgressSet({ planClickSelectors: ["#a", "#b"], hadFieldEdit: false })].sort()).toEqual(["#a", "#b"]);
  });
  it("a field edit clears the memory (real progress)", () => {
    expect(nextNoProgressSet({ planClickSelectors: ["#a"], hadFieldEdit: true }).size).toBe(0);
  });
});
