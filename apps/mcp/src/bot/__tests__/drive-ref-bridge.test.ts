import type { Frame } from "playwright";
import { describe, expect, it } from "vitest";
import { isCompactV2Handle, StableObservationRefs } from "../compact-observation-v2.js";
import { DriveRefBridge } from "../drive-ref-bridge.js";
import type { DriveSnapshot } from "../drive-snapshot.js";

const DOC = "main-document-epoch";
const frame = (): Frame => ({}) as Frame;
const snapshot = (documentEpoch: string, frameOrdinal: number, nodes: number[]): DriveSnapshot => ({
  url: "https://example.test/checkout",
  title: "",
  headings: [],
  text: "",
  fingerprint: "",
  documentEpoch,
  elements: nodes.map((node) => ({
    ref: `@e:f${frameOrdinal}d${node}`,
    role: "textbox",
    label: `Field ${node}`,
    operations: ["fill"],
    frameOrdinal,
  })),
  omittedValues: 0,
  scriptMs: 0,
  wallMs: 0,
});

describe("drive ref allocator bridge", () => {
  it("keeps a node's compact-v2 handle through snapshots and sibling deletion", () => {
    const bridge = new DriveRefBridge(new StableObservationRefs());
    const owner = frame();
    bridge.reserve(DOC, [
      { frame: owner, snapshot: snapshot("100|https://example.test/a", 0, [1, 2, 3]) },
    ]);
    const first = bridge.publicRef("@e:f0d3");
    expect(first).toBeDefined();
    expect(isCompactV2Handle(first!)).toBe(true);
    bridge.reserve(DOC, [
      { frame: owner, snapshot: snapshot("100|https://example.test/b", 0, [1, 3]) },
    ]);
    expect(bridge.publicRef("@e:f0d3")).toBe(first);
    expect(bridge.publicRef("@e:f0d2")).toBeUndefined();
    expect(bridge.publicRows([["@e:f0d3", "t", "n=[card number]|oc=@e:f0d1"]])).toEqual([
      [first, "t", `n=[card number]|oc=${bridge.publicRef("@e:f0d1")}`],
    ]);
  });

  it("refreshes a frame incarnation when its document changes", () => {
    const bridge = new DriveRefBridge(new StableObservationRefs());
    const owner = frame();
    bridge.reserve(DOC, [
      { frame: owner, snapshot: snapshot("100|https://example.test/checkout", 0, [1]) },
    ]);
    const before = bridge.publicRef("@e:f0d1");
    bridge.reserve(DOC, [
      { frame: owner, snapshot: snapshot("200|https://example.test/checkout", 0, [1]) },
    ]);
    expect(bridge.publicRef("@e:f0d1")).not.toBe(before);
  });

  it("keeps same-URL frames distinct through frame reorder and remount", () => {
    const bridge = new DriveRefBridge(new StableObservationRefs());
    const left = frame();
    const right = frame();
    const sameDocument = "100|https://hosted.test/field";
    bridge.reserve(DOC, [
      { frame: left, snapshot: snapshot(sameDocument, 1, [1]) },
      { frame: right, snapshot: snapshot(sameDocument, 2, [1]) },
    ]);
    const leftRef = bridge.publicRef("@e:f1d1");
    const rightRef = bridge.publicRef("@e:f2d1");
    expect(leftRef).not.toBe(rightRef);
    bridge.reserve(DOC, [
      { frame: right, snapshot: snapshot(sameDocument, 1, [1]) },
      { frame: left, snapshot: snapshot(sameDocument, 2, [1]) },
    ]);
    expect(bridge.publicRef("@e:f1d1")).toBe(rightRef);
    expect(bridge.publicRef("@e:f2d1")).toBe(leftRef);
    bridge.reserve(DOC, [{ frame: frame(), snapshot: snapshot(sameDocument, 1, [1]) }]);
    expect(bridge.publicRef("@e:f1d1")).not.toBe(rightRef);
  });

  it("shares the session allocator and discards unreserved private rows", () => {
    const allocator = new StableObservationRefs();
    const bridge = new DriveRefBridge(allocator);
    const owner = frame();
    bridge.reserve(DOC, [
      { frame: owner, snapshot: snapshot("100|https://example.test/", 0, [1]) },
    ]);
    const ref = bridge.publicRef("@e:f0d1");
    expect(ref).toBe(allocator.get(DOC, "drive:1:d1"));
    expect(
      bridge.publicRows([
        ["@e:f0d1", "t"],
        ["@e:f0d99", "t"],
      ]),
    ).toEqual([[ref, "t"]]);
  });

  it("keeps a row visible when it lacks the selector needed for public admission", () => {
    const bridge = new DriveRefBridge(new StableObservationRefs());
    const owner = frame();
    bridge.reserve(DOC, [
      { frame: owner, snapshot: snapshot("100|https://example.test/", 0, [1]) },
    ]);
    expect(bridge.publicRows([["@e:f0d1", "t", "Field"]])).toHaveLength(1);
    expect(
      bridge.anchors(
        new Map([
          [
            "@e:f0d1",
            {
              selector: "",
              frameUrl: "https://example.test/",
              frameOrigin: "https://example.test",
              role: "textbox",
              label: "Field",
            },
          ],
        ]),
      ).size,
    ).toBe(0);
  });
});
