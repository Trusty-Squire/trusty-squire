import { describe, expect, it } from "vitest";
import {
  INVENTED_PASSWORD_DEFAULT_LENGTH,
  inventPassword,
  parsePasswordRequirements,
} from "../drive-password.js";
import { newAccountPasswordTargets, type WireRow } from "../operate-drive.js";

function classes(value: string): {
  lower: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
} {
  return {
    lower: /[a-z]/.test(value),
    upper: /[A-Z]/.test(value),
    digit: /[0-9]/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };
}

describe("parsePasswordRequirements", () => {
  it("reads a minimum stated beside the field", () => {
    expect(parsePasswordRequirements("Password (min 12 chars, required)").minLength).toBe(12);
    expect(parsePasswordRequirements("Use at least 30 characters").minLength).toBe(30);
    expect(parsePasswordRequirements("Must be 32+ characters").minLength).toBe(32);
    expect(parsePasswordRequirements("40 characters minimum").minLength).toBe(40);
  });

  it("does not read an unrelated number as a length", () => {
    const parsed = parsePasswordRequirements(
      "Password (required)\nI confirm that I am at least 18\nAt least 1 number",
    );
    expect(parsed.minLength).toBe(0);
    expect(parsed.maxLength).toBeUndefined();
  });

  it("reads a range and the control's maxlength as the ceiling", () => {
    const ranged = parsePasswordRequirements("Between 8 and 16 characters");
    expect(ranged).toMatchObject({ minLength: 8, maxLength: 16 });
    expect(parsePasswordRequirements("8-20 characters", 18).maxLength).toBe(18);
    expect(parsePasswordRequirements("Password", 14).maxLength).toBe(14);
  });

  it("drops symbols when the page forbids them and keeps only listed ones", () => {
    expect(parsePasswordRequirements("Letters and numbers only").symbols).toBe("");
    expect(parsePasswordRequirements("No special characters").symbols).toBe("");
    expect(parsePasswordRequirements("Include a special character (!@#)").symbols).toBe("!@#");
    expect(
      parsePasswordRequirements("Include one uppercase letter").symbols.length,
    ).toBeGreaterThan(0);
  });

  it("enforces only a complete, compilable pattern", () => {
    expect(parsePasswordRequirements("", undefined, "[A-Za-z0-9]{20,}").pattern).toBeInstanceOf(
      RegExp,
    );
    expect(parsePasswordRequirements("", undefined, "[unclosed").pattern).toBeUndefined();
  });
});

describe("inventPassword", () => {
  it("defaults to a long mixed password", () => {
    const value = inventPassword(parsePasswordRequirements("Password"))!;
    expect(value).toHaveLength(INVENTED_PASSWORD_DEFAULT_LENGTH);
    expect(classes(value)).toEqual({ lower: true, upper: true, digit: true, symbol: true });
  });

  it("is random per call", () => {
    const requirements = parsePasswordRequirements("Password");
    expect(inventPassword(requirements)).not.toBe(inventPassword(requirements));
  });

  it("meets a stated minimum above the default and a ceiling below it", () => {
    expect(inventPassword(parsePasswordRequirements("at least 40 characters"))).toHaveLength(40);
    expect(inventPassword(parsePasswordRequirements("8 to 16 characters"))).toHaveLength(16);
  });

  it("uses only permitted symbols", () => {
    const none = inventPassword(parsePasswordRequirements("alphanumeric only"))!;
    expect(classes(none).symbol).toBe(false);
    const listed = inventPassword(parsePasswordRequirements("special characters: ! or #"))!;
    expect(listed.replace(/[A-Za-z0-9]/g, "")).toMatch(/^[!#]+$/);
  });

  it("satisfies the control's pattern", () => {
    const value = inventPassword(
      parsePasswordRequirements("", undefined, "[A-Za-z0-9!@#$%^&*=+_]{24}"),
    )!;
    expect(value).toMatch(/^[A-Za-z0-9!@#$%^&*=+_]{24}$/);
    const plain = inventPassword(parsePasswordRequirements("", undefined, "[A-Za-z0-9]{24}"))!;
    expect(plain).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it("refuses limits that cannot all hold", () => {
    expect(inventPassword(parsePasswordRequirements("at least 30 characters", 12))).toBeUndefined();
  });
});

describe("newAccountPasswordTargets", () => {
  const signup: WireRow[] = [
    ["@e:email", "t", "Email|f=email|s=r|n=ada@fixture.test|fm=1"],
    ["@e:pw", "t", "Password (min 12 chars, required)|f=password|s=r|fm=1"],
    ["@e:pw2", "t", "Confirm password|f=password|s=r|fm=1"],
    ["@e:age", "c", "I confirm that I am at least 18|s=ru|fm=1"],
    ["@e:create", "b", "Create account|a=submit|fm=1"],
  ];

  it("names the new password, its confirm field, and the login on the form", () => {
    const targets = newAccountPasswordTargets(signup, {}, [], "https://example.test/login");
    expect(targets?.password[0]).toBe("@e:pw");
    expect(targets?.confirms.map((row) => row[0])).toEqual(["@e:pw2"]);
    expect(targets?.login).toBe("ada@fixture.test");
  });

  it("waits for the form's email before inventing", () => {
    const rows: WireRow[] = signup.map((row) =>
      row[0] === "@e:email" ? ["@e:email", "t", "Email|f=email|s=r|fm=1"] : row,
    );
    expect(newAccountPasswordTargets(rows, {}, [], "https://example.test/signup")).toBeUndefined();
  });

  it("leaves a supplied password, a filled field, and a sign-in form alone", () => {
    expect(newAccountPasswordTargets(signup, { password: "given" }, [], "")).toBeUndefined();
    expect(newAccountPasswordTargets(signup, {}, ["@e:pw"], "")).toBeUndefined();
    const signin: WireRow[] = [
      ["@e:email", "t", "Email|f=email|s=r|n=ada@fixture.test|fm=1"],
      ["@e:pw", "t", "Password|f=password|s=r|fm=1"],
      ["@e:go", "b", "Sign in|a=submit|fm=1"],
      ["@e:tab", "b", "Sign up|fm=2"],
    ];
    expect(newAccountPasswordTargets(signin, {}, [], "https://example.test/login")).toBeUndefined();
  });

  it("never fills a change-password form", () => {
    const rows: WireRow[] = [
      ["@e:old", "t", "Current password|f=password|s=r|fm=1"],
      ["@e:new", "t", "New password|f=password|s=r|fm=1"],
      ["@e:again", "t", "Confirm new password|f=password|s=r|fm=1"],
      ["@e:save", "b", "Save|a=submit|fm=1"],
    ];
    expect(
      newAccountPasswordTargets(rows, {}, [], "https://example.test/settings"),
    ).toBeUndefined();
  });
});
