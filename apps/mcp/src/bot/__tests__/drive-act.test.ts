import { describe, expect, it } from "vitest";
import { drivePointerUsesCdp, listOptionIdentity } from "../drive-act.js";

describe("drive pointer path", () => {
  it("keeps CDP coordinates only for a cross-origin child frame", () => {
    expect(drivePointerUsesCdp(true, true)).toBe(false);
    expect(drivePointerUsesCdp(true, false)).toBe(false);
    expect(drivePointerUsesCdp(false, true)).toBe(false);
    expect(drivePointerUsesCdp(false, false)).toBe(true);
  });
});

describe("list option identity", () => {
  it("accepts an ARIA option or a listbox child, not a combobox trigger", () => {
    expect(listOptionIdentity("option", false, false, "Other")).toEqual({
      text: "Other",
      role: "option",
    });
    expect(listOptionIdentity("none", true, false, "Keyword Search")).toEqual({
      text: "Keyword Search",
      role: "option",
    });
    expect(listOptionIdentity("menuitem", false, true, "Save")).toEqual({
      text: "Save",
      role: "menuitem",
    });
    expect(listOptionIdentity("combobox", false, false, "Select reasons...")).toBeNull();
    expect(listOptionIdentity("option", false, false, "   ")).toBeNull();
  });
});
