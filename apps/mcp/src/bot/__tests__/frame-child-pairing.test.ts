// Pairing one CDP frame-tree child with the Playwright child frame it denotes.
// Extracted from bindFrames so the asymmetric shapes that a real page produces
// only under a timing race can be stated directly: the CDP tree and Playwright
// disagree about a child's url for as long as its navigation stays pending, and
// a rule looser than "the same sibling position" silently binds one frame's
// slot to another — a later action then runs in the wrong document, with no
// error to notice.

import { describe, expect, it } from "vitest";
import { matchFrameChild } from "../browser-use-capture.js";

const frame = (url: string): { url(): string } => ({ url: () => url });

describe("matchFrameChild", () => {
  it("pairs a committed child by its url regardless of sibling position", () => {
    const a = frame("https://a.example/one");
    const b = frame("https://b.example/two");
    const available = new Set([a, b]);
    expect(matchFrameChild("https://b.example/two", available, a)).toBe(b);
  });

  it.each([":", ""])(
    "pairs an uncommitted child (cdp %j) with its own sibling position",
    (sentinel) => {
      const first = frame("");
      const second = frame("");
      const available = new Set([first, second]);
      expect(matchFrameChild(sentinel, available, second)).toBe(second);
    },
  );

  // Both CDP spellings of "no committed url" must pair identically. "" is also
  // what Playwright reports for such a frame, so it is the spelling that an
  // exact-url pass would silently accept against the WRONG sibling.
  it.each([":", ""])(
    "never hands an uncommitted child (cdp %j) the slot of an earlier unmatched sibling",
    (sentinel) => {
      // The live skew: CDP reports child 0 as committed while Playwright has
      // not yet processed that navigation, so both Playwright children still
      // read "". Child 0 matches nothing; child 1 is uncommitted. Pairing
      // child 1 with the FIRST remaining "" candidate binds it to child 0.
      const playwrightChild0 = frame("");
      const playwrightChild1 = frame("");
      const available = new Set([playwrightChild0, playwrightChild1]);

      expect(matchFrameChild("https://a.example/committed", available, playwrightChild0)).toBe(
        undefined,
      );
      expect(matchFrameChild(sentinel, available, playwrightChild1)).toBe(playwrightChild1);
    },
  );

  it("leaves an uncommitted child unpaired when its sibling position is already taken", () => {
    const taken = frame("");
    const available = new Set<{ url(): string }>();
    expect(matchFrameChild(":", available, taken)).toBe(undefined);
  });

  it("leaves an uncommitted child unpaired when its sibling position has committed", () => {
    const committed = frame("https://a.example/one");
    const available = new Set([committed]);
    expect(matchFrameChild("", available, committed)).toBe(undefined);
  });

  it("leaves a child unpaired when the tree has no sibling at that position", () => {
    const available = new Set([frame("")]);
    expect(matchFrameChild(":", available, undefined)).toBe(undefined);
  });
});
