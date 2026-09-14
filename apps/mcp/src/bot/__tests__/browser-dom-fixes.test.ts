// Regression test for the browser.ts DOM-robustness fix that landed in PR #90
// (issue #61 weaviate) — a Descope web-component shape that blocked a run
// before the planner saw the page. The load-bearing logic is extracted into a
// pure helper so it can be exercised without a live browser.

import { describe, it, expect } from "vitest";
import { pickClickLocator } from "../browser.js";

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
