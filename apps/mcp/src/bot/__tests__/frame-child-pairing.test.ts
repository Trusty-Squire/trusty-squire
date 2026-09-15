// Pairing a parent's CDP frame-tree children with the Playwright child frames
// they denote. Extracted from bindFrames so the asymmetric shapes a real page
// produces can be stated directly.
//
// Two properties carry the weight. Position among the pending frames is
// resolved against the REMAINING siblings, never by index into the full child
// lists — Page.getFrameTree omits out-of-process children while childFrames()
// includes them, so on a checkout page the lists have different lengths. And
// that in-order pairing applies only while the two remainders are the same
// size, because a size mismatch means they no longer describe the same set of
// frames and pairing across it would bind a CDP frame to a different document.

import { describe, expect, it } from "vitest";
import { pairFrameChildren } from "../browser-use-capture.js";

const frame = (url: string): { url(): string } => ({ url: () => url });

describe("pairFrameChildren", () => {
  it("pairs committed children by url wherever they sit", () => {
    const a = frame("https://a.example/one");
    const b = frame("https://b.example/two");
    expect(pairFrameChildren(["https://b.example/two", "https://a.example/one"], [a, b])).toEqual([
      b,
      a,
    ]);
  });

  it.each([":", ""])("pairs an uncommitted child (cdp %j) with a pending sibling", (sentinel) => {
    const pending = frame("");
    expect(pairFrameChildren([sentinel], [pending])).toEqual([pending]);
  });

  it.each([":", ""])(
    "gives each uncommitted child (cdp %j) a distinct pending sibling, in order",
    (sentinel) => {
      const first = frame("");
      const second = frame("");
      expect(pairFrameChildren([sentinel, sentinel], [first, second])).toEqual([first, second]);
    },
  );

  // The ouraring checkout shape, and the reason index-based pairing is wrong:
  // the committed cross-site field is an OOPIF, so it is absent from the CDP
  // child list entirely while Playwright still reports it at child 0.
  it("pairs pending children when a committed out-of-process sibling is missing from the cdp list", () => {
    const hostedField = frame("https://pay.example/card-field");
    const pending0 = frame("");
    const pending1 = frame("");

    const paired = pairFrameChildren([":", ":"], [hostedField, pending0, pending1]);

    expect(paired).toEqual([pending0, pending1]);
    expect(paired).not.toContain(hostedField);
  });

  it("claims a committed sibling by url before any pending child can take its slot", () => {
    const hostedField = frame("https://pay.example/card-field");
    const pending = frame("");

    expect(
      pairFrameChildren([":", "https://pay.example/card-field"], [hostedField, pending]),
    ).toEqual([pending, hostedField]);
  });

  // A document.write'd frame reports its PARENT's url to CDP while Playwright
  // reports "", so one pending frame beside it leaves 1 sentinel against 2
  // pending siblings. Pairing in order there would bind the pending CDP frame
  // to the written frame's document.
  it("refuses to pair when more siblings are pending than the cdp tree has sentinels", () => {
    const written = frame("");
    const pending = frame("");

    expect(
      pairFrameChildren(["https://merchant.example/checkout", ":"], [written, pending]),
    ).toEqual([undefined, undefined]);
  });

  it("refuses to pair when the cdp tree has more sentinels than there are pending siblings", () => {
    const onlyPending = frame("");
    expect(pairFrameChildren([":", ":"], [onlyPending])).toEqual([undefined, undefined]);
  });

  it("still pairs the committed children when the pending remainders disagree", () => {
    const committed = frame("https://a.example/one");
    const pending = frame("");

    expect(pairFrameChildren(["https://a.example/one", ":", ":"], [committed, pending])).toEqual([
      committed,
      undefined,
      undefined,
    ]);
  });

  it("never pairs an uncommitted child with a committed sibling", () => {
    const committed = frame("https://a.example/one");
    expect(pairFrameChildren([":"], [committed])).toEqual([undefined]);
    expect(pairFrameChildren([""], [committed])).toEqual([undefined]);
  });

  it("leaves a committed child unpaired when no sibling carries its url", () => {
    expect(pairFrameChildren(["https://a.example/one"], [frame("https://b.example/two")])).toEqual([
      undefined,
    ]);
  });
});
