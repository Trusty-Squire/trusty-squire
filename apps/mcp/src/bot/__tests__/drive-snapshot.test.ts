// Drive-loop snapshot conversion: visible-text labels, inferred fields,
// omitted card values, and all headings. No browser.

import { describe, expect, it } from "vitest";
import {
  DRIVE_SNAPSHOT_CREDIT,
  driveRowsFromSnapshot,
  inferFieldFromLabel,
  snapshotSelectOptions,
  type DriveSnapshot,
} from "../drive-snapshot.js";

function snapshot(partial: Partial<DriveSnapshot> = {}): DriveSnapshot {
  return {
    url: "https://example.test/",
    title: "Directory",
    headings: ["Offices", "Found 3 offices"],
    text: "Found 3 offices in California",
    fingerprint: "fp",
    documentEpoch: "1|https://example.test/",
    elements: [],
    omittedValues: 0,
    ...partial,
  };
}

describe("drive snapshot conversion", () => {
  it("credits jev-ultrafast snapshot.js", () => {
    expect(DRIVE_SNAPSHOT_CREDIT).toContain("jev-ultrafast");
    expect(DRIVE_SNAPSHOT_CREDIT).toContain("MIT");
  });

  it("keeps visible text labels and infers fields without slugging", () => {
    expect(inferFieldFromLabel("Zürich, largest city in Switzerland", "link")).toBeUndefined();
    expect(inferFieldFromLabel("Search Wikipedia", "searchbox")).toBe("search");
    expect(inferFieldFromLabel("Card number", "textbox")).toBe("payment");
    const rows = driveRowsFromSnapshot(
      snapshot({
        elements: [
          {
            ref: "@e:f0d1",
            role: "searchbox",
            label: "Search Wikipedia",
            operations: ["fill", "click"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:f0d2",
            role: "option",
            label: "Zürich, largest city in Switzerland",
            operations: ["click"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:f0d3",
            role: "option",
            label: "Zürich, canton of Switzerland",
            operations: ["click"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:f0d4",
            role: "option",
            label: "Zürich District",
            operations: ["click"],
            frameOrdinal: 0,
          },
        ],
      }),
    );
    expect(rows[0]?.[2]).toContain("Search Wikipedia");
    expect(rows[0]?.[2]).toContain("f=search");
    expect(rows[1]?.[2]).toContain("Zürich, largest city in Switzerland");
    expect(rows[1]?.[2]).not.toContain("zurich-largest-city");
    expect(rows[1]?.[2]).toContain("q=1/3");
  });

  it("omits marked card values and keeps select option text", () => {
    const rows = driveRowsFromSnapshot(
      snapshot({
        omittedValues: 1,
        elements: [
          {
            ref: "@e:f0d9",
            role: "textbox",
            label: "Card number",
            operations: ["fill"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:f0d8",
            role: "combobox",
            label: "State",
            operations: ["select"],
            frameOrdinal: 0,
            options: [
              { value: "CA", label: "California" },
              { value: "OR", label: "Oregon" },
            ],
          },
        ],
      }),
    );
    expect(rows.find((row) => row[0] === "@e:f0d9")?.[2]).not.toContain("n=");
    expect(rows.find((row) => row[0] === "@e:f0d8")?.[1]).toBe("s");
    const options = snapshotSelectOptions(
      snapshot({
        elements: [
          {
            ref: "@e:f0d8",
            role: "combobox",
            label: "State",
            operations: ["select"],
            frameOrdinal: 0,
            options: [
              { value: "CA", label: "California" },
              { value: "OR", label: "Oregon" },
            ],
          },
        ],
      }),
    );
    expect(options.get("@e:f0d8")).toEqual(["California", "Oregon"]);
  });
});
