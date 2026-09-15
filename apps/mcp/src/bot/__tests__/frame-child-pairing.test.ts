// Pairing one CDP frame-tree child with the Playwright child frame it denotes.
// Extracted from bindFrames so the asymmetric shapes a real page produces can
// be stated directly. The load-bearing property is that position is resolved
// among the REMAINING candidates rather than by index into the full child
// lists: Page.getFrameTree omits out-of-process children while childFrames()
// includes them, so on a checkout page the two lists have different lengths.

import { describe, expect, it } from "vitest";
import { matchFrameChild } from "../browser-use-capture.js";

const frame = (url: string): { url(): string } => ({ url: () => url });

// bindFrames walks the CDP children in order and removes each frame it claims.
const pairAll = (
  cdpChildUrls: readonly string[],
  playwrightChildren: readonly { url(): string }[],
): Array<{ url(): string } | undefined> => {
  const available = new Set(playwrightChildren);
  return cdpChildUrls.map((url) => {
    const matched = matchFrameChild(url, available);
    if (matched) available.delete(matched);
    return matched;
  });
};

describe("matchFrameChild", () => {
  it("pairs a committed child by its url wherever it sits", () => {
    const a = frame("https://a.example/one");
    const b = frame("https://b.example/two");
    expect(matchFrameChild("https://b.example/two", new Set([a, b]))).toBe(b);
  });

  it.each([":", ""])("pairs an uncommitted child (cdp %j) with a pending sibling", (sentinel) => {
    const pending = frame("");
    expect(matchFrameChild(sentinel, new Set([pending]))).toBe(pending);
  });

  it.each([":", ""])(
    "gives each uncommitted child (cdp %j) a distinct pending sibling, in order",
    (sentinel) => {
      const first = frame("");
      const second = frame("");
      expect(pairAll([sentinel, sentinel], [first, second])).toEqual([first, second]);
    },
  );

  // The ouraring checkout shape, and the reason index-based pairing is wrong:
  // the committed cross-site field is an OOPIF, so it is absent from the CDP
  // child list entirely while Playwright still reports it at child 0.
  it("pairs pending children when a committed out-of-process sibling is missing from the cdp list", () => {
    const hostedField = frame("https://pay.example/card-field");
    const pending0 = frame("");
    const pending1 = frame("");

    const paired = pairAll([":", ":"], [hostedField, pending0, pending1]);

    expect(paired).toEqual([pending0, pending1]);
    expect(paired).not.toContain(hostedField);
  });

  it("claims a committed sibling by url before any pending child can take its slot", () => {
    const hostedField = frame("https://pay.example/card-field");
    const pending = frame("");

    expect(pairAll(["https://pay.example/card-field", ":"], [hostedField, pending])).toEqual([
      hostedField,
      pending,
    ]);
  });

  it("never pairs an uncommitted child with a committed sibling", () => {
    const committed = frame("https://a.example/one");
    expect(matchFrameChild(":", new Set([committed]))).toBe(undefined);
    expect(matchFrameChild("", new Set([committed]))).toBe(undefined);
  });

  it("leaves an uncommitted child unpaired once every pending sibling is claimed", () => {
    const onlyPending = frame("");
    expect(pairAll([":", ":"], [onlyPending])).toEqual([onlyPending, undefined]);
  });

  it("leaves a committed child unpaired when no sibling carries its url", () => {
    expect(
      matchFrameChild("https://a.example/one", new Set([frame("https://b.example/two")])),
    ).toBe(undefined);
  });
});
