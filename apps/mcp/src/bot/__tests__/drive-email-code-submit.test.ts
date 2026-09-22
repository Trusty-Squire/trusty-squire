import { describe, expect, it } from "vitest";
import { emailCodeSubmitRow, type WireRow } from "../operate-drive.js";

describe("submit after an emailed code fill", () => {
  const filledCode: WireRow = ["@e:code", "t", "vcode|n=845779|fm=1"];
  const otherFormSubmit: WireRow = ["@e:other", "b", "Continue|fm=2"];
  const ownSubmit: WireRow = ["@e:submit", "b", "Continue|fm=1"];
  const rows: WireRow[] = [
    filledCode,
    ["@e:back", "b", "back|fm=1"],
    otherFormSubmit,
    ownSubmit,
    ["@e:alternate", "l", "Use SSO|u=/other"],
  ];
  const codeFill = { action: "type_otp", target: filledCode[0] };

  it("chooses the enabled submit in the filled code's form", () => {
    expect(emailCodeSubmitRow(rows, codeFill)).toEqual(ownSubmit);
  });

  it("requires a visible filled code and a recent emailed-code action", () => {
    expect(emailCodeSubmitRow(rows, { action: "type", target: filledCode[0] })).toBeUndefined();
    expect(
      emailCodeSubmitRow(
        [["@e:code", "t", "vcode|fm=1"], ...rows.slice(1)],
        codeFill,
      ),
    ).toBeUndefined();
    expect(emailCodeSubmitRow(rows, { action: "type_otp", target: "@e:absent" })).toBeUndefined();
  });

  it("does not click another form or a disabled submit", () => {
    expect(
      emailCodeSubmitRow([filledCode, otherFormSubmit, rows[4]!], codeFill),
    ).toBeUndefined();
    expect(
      emailCodeSubmitRow(
        [filledCode, ["@e:submit", "b", "Continue|fm=1|s=d"]],
        codeFill,
      ),
    ).toBeUndefined();
  });

  it("keeps an offscreen submit eligible for the normal click path", () => {
    expect(
      emailCodeSubmitRow(
        [filledCode, ["@e:submit", "b", "Continue|fm=1|v=offscreen"]],
        codeFill,
      )?.[0],
    ).toBe("@e:submit");
  });
});
