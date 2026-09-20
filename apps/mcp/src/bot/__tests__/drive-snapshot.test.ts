import { matchingFactKeys } from "../operate-drive.js";
// Drive-loop snapshot conversion: visible-text labels, inferred fields,
// omitted card values, and all headings. No browser.

import { describe, expect, it } from "vitest";
import {
  DRIVE_SNAPSHOT_BUDGET_MS,
  DRIVE_SNAPSHOT_MAX_ELEMENTS,
  DRIVE_SNAPSHOT_MAX_NAME_VISITS,
  DRIVE_SNAPSHOT_MAX_WALK_NODES,
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
    scriptMs: 0,
    wallMs: 0,
    ...partial,
  };
}

describe("drive snapshot conversion", () => {
  it("bounds snapshot work", () => {
    expect(DRIVE_SNAPSHOT_MAX_ELEMENTS).toBe(250);
    expect(DRIVE_SNAPSHOT_BUDGET_MS).toBeLessThan(DRIVE_SNAPSHOT_MAX_ELEMENTS * 20);
    expect(DRIVE_SNAPSHOT_MAX_WALK_NODES).toBeLessThan(10_000);
    expect(DRIVE_SNAPSHOT_MAX_NAME_VISITS).toBeLessThan(DRIVE_SNAPSHOT_MAX_WALK_NODES);
  });

  it("keeps visible text labels and infers fields without slugging", () => {
    expect(inferFieldFromLabel("Zürich, largest city in Switzerland", "link")).toBeUndefined();
    expect(inferFieldFromLabel("Search Wikipedia", "searchbox")).toBe("search");
    expect(inferFieldFromLabel("Where from?", "combobox")).toBe("origin");
    expect(inferFieldFromLabel("Where to?", "combobox")).toBe("destination");
    expect(inferFieldFromLabel("Departure", "textbox")).toBe("date");
    expect(inferFieldFromLabel("Expiry", "textbox")).toBe("date");
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
    const suggestion = driveRowsFromSnapshot(
      snapshot({
        elements: [
          {
            ref: "@e:f0d20",
            role: "link",
            label: "Zurich Largest city in Switzerland",
            operations: ["click"],
            frameOrdinal: 0,
          },
        ],
      }),
    );
    expect(suggestion[0]?.[2]).toContain("Zurich Largest city in Switzerland");
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

  it("marks a picker on the wire so fillable date and combobox fields stay clickable", () => {
    const rows = driveRowsFromSnapshot(
      snapshot({
        elements: [
          {
            ref: "@e:dep",
            role: "textbox",
            label: "Departure",
            picker: true,
            operations: ["fill", "click"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:from",
            role: "combobox",
            label: "Where from?",
            picker: true,
            operations: ["fill", "click"],
            frameOrdinal: 0,
          },
        ],
      }),
    );
    expect(rows[0]?.[2]).toContain("f=date");
    expect(rows[0]?.[2]).toContain("a=picker");
    expect(rows[1]?.[1]).toBe("t");
    expect(rows[1]?.[2]).toContain("f=origin");
    expect(rows[1]?.[2]).toContain("a=picker");
  });

  it("serializes placeholder, pattern, inputmode, and invalid onto the row", () => {
    const rows = driveRowsFromSnapshot(
      snapshot({
        elements: [
          {
            ref: "@e:exp",
            role: "textbox",
            label: "Expiration date",
            placeholder: "MM/YYYY",
            pattern: "\\d{2}/\\d{4}",
            inputMode: "numeric",
            invalid: true,
            required: true,
            operations: ["fill"],
            frameOrdinal: 0,
          },
        ],
      }),
    );
    expect(rows[0]?.[2]).toContain("Expiration date");
    expect(rows[0]?.[2]).toContain("ph=MM/YYYY");
    expect(rows[0]?.[2]).toContain("pt=\\d{2}/\\d{4}");
    expect(rows[0]?.[2]).toContain("im=numeric");
    expect(rows[0]?.[2]).toMatch(/(?:^|\|)s=[^|]*i/);
    expect(
      matchingFactKeys(
        { card_ref: "card-1", card_expiry_long: "12/2030", card_expiry: "12/30" },
        rows[0]!,
      ),
    ).toEqual(["card_expiry_long"]);
  });

  it("serializes form membership and the covering control onto the row", () => {
    const rows = driveRowsFromSnapshot(
      snapshot({
        elements: [
          {
            ref: "@e:f0d1",
            role: "textbox",
            label: "Email",
            formId: 1,
            operations: ["fill"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:f0d2",
            role: "button",
            label: "Create account",
            formId: 1,
            occludedBy: "@e:f0d3",
            operations: ["click"],
            frameOrdinal: 0,
          },
          {
            ref: "@e:f0d3",
            role: "button",
            label: "Accept All",
            operations: ["click"],
            frameOrdinal: 0,
          },
        ],
      }),
    );
    expect(rows.find((row) => row[0] === "@e:f0d1")?.[2]).toContain("fm=1");
    expect(rows.find((row) => row[0] === "@e:f0d2")?.[2]).toContain("fm=1");
    expect(rows.find((row) => row[0] === "@e:f0d2")?.[2]).toContain("oc=@e:f0d3");
    expect(rows.find((row) => row[0] === "@e:f0d3")?.[2]).not.toContain("oc=");
  });

  it("maps a fillable combobox to a text field, not a select", () => {
    const rows = driveRowsFromSnapshot(
      snapshot({
        elements: [
          {
            ref: "@e:q",
            role: "combobox",
            label: "Search with DuckDuckGo",
            operations: ["fill", "click"],
            frameOrdinal: 0,
          },
        ],
      }),
    );
    expect(rows[0]?.[1]).toBe("t");
    expect(rows[0]?.[2]).toContain("f=search");
  });
});

describe("second address line inference", () => {
  it.each([
    "Address line 2",
    "Address 2",
    "Address2",
    "Apt",
    "Apartment",
    "Unit",
    "Suite",
    "Apartment, suite, etc. (optional)",
  ])("assigns %s to address2", (label) => {
    const rows = driveRowsFromSnapshot(
      snapshot({
        elements: [
          { ref: "@e:f0d1", role: "textbox", label, frameOrdinal: 0, operations: ["fill"] },
        ],
      }),
    );
    expect(inferFieldFromLabel(label, "textbox")).toBe("address2");
    expect(matchingFactKeys({ address: "1 Main St", address2: "Apt 4" }, rows[0]!)).toEqual([
      "address2",
    ]);
  });
});
