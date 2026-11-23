import { describe, expect, it, vi } from "vitest";
import {
  INVENTED_PASSWORD_DEFAULT_LENGTH,
  inventPassword,
  parsePasswordRequirements,
  passwordMeetsRequirements,
} from "../drive-password.js";
import { emailCodeCandidates, newAccountPasswordTargets, type WireRow } from "../operate-drive.js";
import { driveRowsFromSnapshot, type DriveSnapshotElement } from "../drive-snapshot.js";
import { storeInventedLogin } from "../../tools/provision-drive.js";
import type { ApiClient } from "../../api-client.js";
import { withOperatorRequestContext } from "../request-cancellation.js";
import type * as provisionSession from "../provision-session.js";

vi.mock("../provision-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof provisionSession>()),
  observedHostsForSession: () => ["example.test"],
}));

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

  it.each([undefined, "[A-Za-z0-9.?]{24}"])(
    "preserves explicitly allowed punctuation with pattern %s",
    (pattern) => {
      const value = inventPassword(
        parsePasswordRequirements("Allowed special characters: .?", undefined, pattern),
      )!;
      expect(value.replace(/[A-Za-z0-9]/g, "")).toMatch(/^[.?]+$/);
    },
  );

  it.each(["!, @, #", "!,@,#", "!; @; #"])(
    "excludes delimiters from a separated symbol list: %s",
    (list) => {
      for (const pattern of [undefined, "[A-Za-z0-9!@#,;]{24}"]) {
        const requirements = parsePasswordRequirements(
          `Allowed special characters: ${list}`,
          undefined,
          pattern,
        );
        expect(requirements.symbols).toBe("!@#");
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const value = inventPassword(requirements)!;
          expect(value.replace(/[A-Za-z0-9]/g, "")).toMatch(/^[!@#]+$/);
        }
      }
    },
  );

  it.each([",", ";", ".?"])("preserves compact literal punctuation: %s", (symbols) => {
    const requirements = parsePasswordRequirements(`Allowed special characters: ${symbols}`);
    expect(requirements.symbols).toBe(symbols);
    const value = inventPassword(requirements)!;
    expect(
      [...value.replace(/[A-Za-z0-9]/g, "")].every((character) => symbols.includes(character)),
    ).toBe(true);
  });

  it("does not substitute the default alphabet for an empty explicit list", () => {
    const value = inventPassword(parsePasswordRequirements("Symbols: none"))!;
    expect(value).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("satisfies the control's pattern", () => {
    const value = inventPassword(
      parsePasswordRequirements("", undefined, "[A-Za-z0-9!@#$%^&*=+_]{24}"),
    )!;
    expect(value).toMatch(/^[A-Za-z0-9!@#$%^&*=+_]{24}$/);
    const plain = inventPassword(parsePasswordRequirements("", undefined, "[A-Za-z0-9]{24}"))!;
    expect(plain).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it("honors a native minimum without visible length instructions", () => {
    const value = inventPassword(parsePasswordRequirements("Password", undefined, undefined, 30))!;
    expect(value.length).toBeGreaterThanOrEqual(30);
  });

  it.each([
    ["[A-Za-z0-9]{12,20}", /^[A-Za-z0-9]{12,20}$/],
    ["[A-Z0-9]{24}", /^[A-Z0-9]{24}$/],
    ["[a-z]{30,}", /^[a-z]{30,}$/],
    [".{12,20}", /^.{12,20}$/],
    ["(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{12,20}", /^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{12,20}$/],
    [
      "(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{12,20}",
      /^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{12,20}$/,
    ],
    ["^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{12,20}$", /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{12,20}$/],
  ])("generates within the character and length space of %s", (pattern, oracle) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = inventPassword(
        parsePasswordRequirements("Password", undefined, pattern as string),
      );
      expect(value).toBeDefined();
      expect(value).toMatch(oracle as RegExp);
    }
  });

  it.each([
    ["Confirm password", 20, undefined, undefined, /^[\s\S]{12,20}$/],
    ["Confirm password", undefined, undefined, 30, /^[\s\S]{30,64}$/],
    ["Confirm password", undefined, "[A-Z0-9]{16}", undefined, /^[A-Z0-9]{16}$/],
    [
      "At most 18 characters. No special characters",
      undefined,
      undefined,
      undefined,
      /^[A-Za-z0-9]{12,18}$/,
    ],
  ] as const)(
    "satisfies primary and confirmation constraints: %s",
    (text, max, pattern, min, oracle) => {
      const primary = parsePasswordRequirements("Password", 64, undefined, 12);
      const confirmation = parsePasswordRequirements(text, max, pattern, min);
      const value = inventPassword(primary, confirmation)!;
      expect(value).toMatch(oracle);
      expect(passwordMeetsRequirements(value, primary)).toBe(true);
      expect(passwordMeetsRequirements(value, confirmation)).toBe(true);
    },
  );

  it("uses a confirmation's explicit symbols when the primary has no symbol restriction", () => {
    const value = inventPassword(
      parsePasswordRequirements("Password"),
      parsePasswordRequirements("Allowed special characters: .?"),
    )!;
    expect(value.replace(/[A-Za-z0-9]/g, "")).toMatch(/^[.?]+$/);
  });

  it("refuses conflicting primary and confirmation constraints", () => {
    expect(
      inventPassword(
        parsePasswordRequirements("Password", undefined, undefined, 30),
        parsePasswordRequirements("Confirm password", 20),
      ),
    ).toBeUndefined();
    expect(
      passwordMeetsRequirements(
        "Mixed-password-23456789012",
        parsePasswordRequirements("Confirm password", 20),
      ),
    ).toBe(false);
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
    const targets = newAccountPasswordTargets(signup, {}, []);
    expect(targets?.password[0]).toBe("@e:pw");
    expect(targets?.confirms.map((row) => row[0])).toEqual(["@e:pw2"]);
    expect(targets?.identity?.[0]).toBe("@e:email");
    expect(targets?.login).toBeUndefined();
  });

  it("waits for the form's email before inventing", () => {
    const rows: WireRow[] = signup.map((row) =>
      row[0] === "@e:email" ? ["@e:email", "t", "Email|f=email|s=r|fm=1"] : row,
    );
    expect(newAccountPasswordTargets(rows, {}, [])).toBeUndefined();
  });

  it("leaves a supplied password, a filled field, and a sign-in form alone", () => {
    expect(newAccountPasswordTargets(signup, { password: "given" }, [])).toBeUndefined();
    expect(newAccountPasswordTargets(signup, {}, ["@e:pw"])).toBeUndefined();
    const signin: WireRow[] = [
      ["@e:email", "t", "Email|f=email|s=r|n=ada@fixture.test|fm=1"],
      ["@e:pw", "t", "Password|f=password|s=r|fm=1"],
      ["@e:go", "b", "Sign in|a=submit|fm=1"],
      ["@e:tab", "b", "Sign up|fm=2"],
    ];
    expect(newAccountPasswordTargets(signin, {}, [])).toBeUndefined();
  });

  it("selects pending confirmations after the primary was filled or removed", () => {
    for (const rows of [signup, signup.filter((row) => row[0] !== "@e:pw")]) {
      const targets = newAccountPasswordTargets(
        rows,
        {},
        ["@e:pw"],
        () => [],
        () => true,
      );
      expect(targets?.password[0]).toBe("@e:pw2");
      expect(targets?.confirms).toEqual([]);
    }
  });

  it("requires signup evidence even when password confirmation is present", () => {
    const reset: WireRow[] = signup.map((row) =>
      row[0] === "@e:create" ? [row[0], "b", "Reset password|a=submit|fm=1"] : row,
    );
    expect(newAccountPasswordTargets(reset, { email: "ada@fixture.test" }, [])).toBeUndefined();
    expect(
      newAccountPasswordTargets(
        reset,
        {},
        ["@e:pw"],
        () => [],
        () => true,
      ),
    ).toBeUndefined();
  });

  it.each(["Get started", "Join"])("does not invent from a generic %s submit", (label) => {
    const rows: WireRow[] = signup.map((row) =>
      row[0] === "@e:create" ? [row[0], "b", `${label}|a=submit|fm=1`] : row,
    );
    expect(newAccountPasswordTargets(rows, {}, [], () => ["Sign in"])).toBeUndefined();
    expect(newAccountPasswordTargets(rows, {}, [])).toBeUndefined();
    expect(newAccountPasswordTargets(rows, {}, [], () => ["Create account"])).toBeDefined();
  });

  it.each(["Sign in", "Sign-in", "Reset password", "Password reset"])(
    "rejects explicit %s evidence even with a create-account submit",
    (heading) => {
      expect(newAccountPasswordTargets(signup, {}, [], () => [heading])).toBeUndefined();
      expect(
        newAccountPasswordTargets(
          signup,
          {},
          ["@e:pw"],
          () => [heading],
          () => true,
        ),
      ).toBeUndefined();
    },
  );

  it("reuses confirmation on a neutral continuation only after invention", () => {
    const rows: WireRow[] = signup.map((row) =>
      row[0] === "@e:create" ? [row[0], "b", "Continue|a=submit|fm=1"] : row,
    );
    expect(newAccountPasswordTargets(rows, {}, [])).toBeUndefined();
    expect(
      newAccountPasswordTargets(
        rows,
        {},
        ["@e:pw"],
        () => [],
        () => true,
      )?.password[0],
    ).toBe("@e:pw2");
  });

  it("excludes populated primary and confirmation controls", () => {
    const primary: WireRow[] = signup.map((row) =>
      row[0] === "@e:pw" ? [row[0], row[1], row[2]!.replace("s=r", "s=rp")] : row,
    );
    expect(newAccountPasswordTargets(primary, {}, [])).toBeUndefined();
    const confirm: WireRow[] = signup.map((row) =>
      row[0] === "@e:pw2" ? [row[0], row[1], row[2]!.replace("s=r", "s=rp")] : row,
    );
    expect(newAccountPasswordTargets(confirm, {}, [])?.confirms).toEqual([]);
    expect(
      newAccountPasswordTargets(
        confirm,
        {},
        ["@e:pw"],
        () => [],
        () => true,
      ),
    ).toBeUndefined();
  });

  it.each(["|fm=1", ""])(
    "keeps signup selection inside its frame with form metadata %s",
    (form) => {
      const rows: WireRow[] = [
        ["@e:f0d1", "t", `Confirm password|f=password|s=r${form}`],
        ["@e:f0d2", "t", `Email|f=email|n=merchant@fixture.test${form}`],
        ["@e:f0d3", "b", `Sign in|a=submit${form}`],
        ["@e:f1d1", "t", `Email|f=email|n=provider@fixture.test${form}`],
        ["@e:f1d2", "t", `Password|f=password|s=r${form}`],
        ["@e:f1d3", "t", `Confirm password|f=password|s=r${form}`],
        ["@e:f1d4", "b", `Create account|a=submit${form}`],
      ];
      const headings = (row: WireRow) =>
        row[0].startsWith("@e:f1") ? ["Create account"] : ["Sign in"];
      const targets = newAccountPasswordTargets(rows, {}, [], headings);
      expect(targets?.identity?.[0]).toBe("@e:f1d1");
      expect(targets?.confirms.map((row) => row[0])).toEqual(["@e:f1d3"]);
      const continued = newAccountPasswordTargets(rows, {}, ["@e:f1d2"], headings, (row) =>
        row[0].startsWith("@e:f1"),
      );
      expect(continued?.password[0]).toBe("@e:f1d3");
    },
  );

  it.each([
    ["Sign in", "earlier@fixture.test"],
    ["Reset password", "earlier@fixture.test"],
    ["Continue", "earlier@fixture.test"],
    ["Create account", ""],
  ])("skips an earlier ineligible %s form", (submit, login) => {
    const earlier: WireRow[] = [
      ["@e:f0d1", "t", `Email|f=email|n=${login}|fm=1`],
      ["@e:f0d2", "t", "Password|f=password|s=r|fm=1"],
      ["@e:f0d3", "b", `${submit}|a=submit|fm=1`],
    ];
    const later: WireRow[] = [
      ["@e:f0d4", "t", "Email|f=email|n=later@fixture.test|fm=2"],
      ["@e:f0d5", "t", "Password|f=password|s=r|fm=2"],
      ["@e:f0d6", "t", "Confirm password|f=password|s=r|fm=2"],
      ["@e:f0d7", "b", "Create account|a=submit|fm=2"],
    ];
    const rows = [...earlier, ...later];
    expect(newAccountPasswordTargets(rows, {}, [])?.password[0]).toBe("@e:f0d5");
    expect(
      newAccountPasswordTargets(
        rows,
        {},
        ["@e:f0d5"],
        () => [],
        (row) => row[0] === "@e:f0d6",
      )?.password[0],
    ).toBe("@e:f0d6");
  });

  it("skips an ineligible confirmation before an eligible saved-password confirmation", () => {
    const rows: WireRow[] = [
      ["@e:f0d1", "t", "Confirm password|f=password|s=r|fm=1"],
      ["@e:f0d2", "b", "Reset password|a=submit|fm=1"],
      ["@e:f1d1", "t", "Confirm password|f=password|s=r|fm=1"],
      ["@e:f1d2", "b", "Continue|a=submit|fm=1"],
    ];
    const targets = newAccountPasswordTargets(
      rows,
      { email: "ada@fixture.test" },
      [],
      () => [],
      () => true,
    );
    expect(targets?.password[0]).toBe("@e:f1d1");
  });

  it("never fills a change-password form", () => {
    const rows: WireRow[] = [
      ["@e:old", "t", "Current password|f=password|s=r|fm=1"],
      ["@e:new", "t", "New password|f=password|s=r|fm=1"],
      ["@e:again", "t", "Confirm new password|f=password|s=r|fm=1"],
      ["@e:save", "b", "Save|a=submit|fm=1"],
    ];
    expect(newAccountPasswordTargets(rows, {}, [])).toBeUndefined();
  });
});

// squire-1.1.61 trace: Darus /masuk?mode=register (L69161) and Fikra
// /account/signup (L155) ended needs_value on their password fields. Neither
// label says "password", and Darus' buttons are not in English, so the drive
// never treated the field as a new password to invent.
describe("sign-up passwords named by the input type", () => {
  const element = (
    ref: string,
    role: string,
    label: string,
    extra: Partial<DriveSnapshotElement> = {},
  ): DriveSnapshotElement => ({
    ref,
    role,
    label,
    operations: role === "textbox" ? ["fill"] : ["click"],
    frameOrdinal: 0,
    formId: 1,
    ...extra,
  });
  const rowsOf = (elements: DriveSnapshotElement[]): WireRow[] =>
    driveRowsFromSnapshot({
      url: "https://signup.example.test/",
      title: "",
      headings: [],
      text: "",
      fingerprint: "",
      documentEpoch: "",
      elements,
      omittedValues: 0,
      scriptMs: 0,
      wallMs: 0,
    });
  const email = "grunt@example.test";
  // Darus: name and username typed, email still empty, password labelled only
  // by its placeholder, Indonesian submit.
  const darus = rowsOf([
    element("@e:f0d80", "textbox", "Nama Anda", {
      placeholder: "Nama Anda",
      required: true,
      value: "grunt",
    }),
    element("@e:f0d81", "textbox", email, {
      placeholder: email,
      inputType: "email",
      required: true,
    }),
    element("@e:f0d82", "button", "Kirim OTP", { disabled: true }),
    element("@e:f0d83", "textbox", "username", {
      placeholder: "username",
      required: true,
      value: "grunt",
    }),
    element("@e:f0d84", "textbox", "Min. 12 karakter, kuat", {
      placeholder: "Min. 12 karakter, kuat",
      inputType: "password",
      required: true,
      populated: false,
    }),
    element("@e:f0d86", "textbox", "Mis. 5UHRWNL8", { placeholder: "Mis. 5UHRWNL8" }),
    element("@e:f0d87", "button", "Daftar sekarang", { submit: true, disabled: true }),
  ]);

  it("marks a masked field whose words name nothing as the password", () => {
    expect(darus.find((row) => row[0] === "@e:f0d84")?.[2]).toContain("f=password");
    // The masked field is not offered as a place for an emailed code.
    expect(emailCodeCandidates(darus, ["@e:f0d80", "@e:f0d83"]).map((c) => c.ref)).not.toContain(
      "@e:f0d84",
    );
  });

  it("invents the password of a non-English sign-up form, saved under the email fact", () => {
    const targets = newAccountPasswordTargets(darus, { email }, ["@e:f0d80", "@e:f0d83"]);
    expect(targets?.password[0]).toBe("@e:f0d84");
    expect(targets?.login).toBe(email);
    // Without a fact for the empty email field there is no login to save yet.
    expect(newAccountPasswordTargets(darus, {}, ["@e:f0d80", "@e:f0d83"])).toBeUndefined();
  });

  it("invents the password beside a filled email on an English sign-up", () => {
    const fikra = rowsOf([
      element("@e:f0d7", "button", "Create Account with $0.50 free-model credit", {
        submit: true,
      }),
      element("@e:f0d4", "textbox", email, {
        placeholder: email,
        inputType: "email",
        required: true,
        value: email,
      }),
      element("@e:f0d5", "textbox", "••••••••", {
        placeholder: "••••••••",
        inputType: "password",
        required: true,
        populated: false,
      }),
    ]);
    const targets = newAccountPasswordTargets(fikra, {}, ["@e:f0d4"]);
    expect(targets?.password[0]).toBe("@e:f0d5");
    expect(targets?.identity?.[0]).toBe("@e:f0d4");
  });

  it("keeps a masked code field a code and leaves a bare sign-in alone", () => {
    const code = rowsOf([
      element("@e:f0d44", "textbox", "Verification code", { inputType: "password" }),
    ]);
    expect(code[0]?.[2]).toContain("f=otp");
    const signin = rowsOf([
      element("@e:e", "textbox", "Surel", { inputType: "email", value: email }),
      element("@e:p", "textbox", "Kata sandi", { inputType: "password", required: true }),
      element("@e:go", "button", "Masuk", { submit: true }),
    ]);
    expect(newAccountPasswordTargets(signin, { email }, [])).toBeUndefined();
  });

  it.each(["Verification code", "PIN", ""])(
    "offers a masked code with label %j and a meaningful placeholder for inbox verification",
    (label) => {
      const code = rowsOf([
        element("@e:code", "textbox", label, {
          inputType: "password",
          placeholder: "Verification code",
        }),
      ]);
      expect(code[0]?.[2]).toContain("f=otp");
      expect(emailCodeCandidates(code).map((candidate) => candidate.ref)).toEqual(["@e:code"]);
      expect(newAccountPasswordTargets(code, { email }, [])).toBeUndefined();
    },
  );
});

describe("storeInventedLogin", () => {
  it("does not post an invented login after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before password storage");
    controller.abort(reason);
    const storeCredential = vi.fn(async () => ({ reference: "vault://test" }));
    const api = { storeCredential } as unknown as ApiClient;
    await expect(
      withOperatorRequestContext(controller.signal, () =>
        storeInventedLogin(api, {
          sessionId: "test",
          url: "https://example.test/signup",
          login: "ada@example.test",
          password: "new-password",
        }),
      ),
    ).rejects.toBe(reason);
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it("records mutation dispatch before posting an invented login", async () => {
    const events: string[] = [];
    const api = {
      storeCredential: async () => {
        events.push("post");
      },
    } as unknown as ApiClient;
    await withOperatorRequestContext(
      new AbortController().signal,
      () =>
        storeInventedLogin(api, {
          sessionId: "test",
          url: "https://example.test/signup",
          login: "ada@example.test",
          password: "new-password",
        }),
      async (phase) => {
        events.push(phase);
      },
    );
    expect(events).toEqual(["dispatch_attempted", "post"]);
  });

  it("uses independent create-only writes for concurrent attempts", async () => {
    const storeCredential = vi.fn(async () => ({ reference: "vault://test" }));
    const api = { storeCredential } as unknown as ApiClient;
    const login = {
      sessionId: "test",
      url: "https://example.test/signup",
      login: "ada@example.test",
      password: "new-password",
    };
    await Promise.all([storeInventedLogin(api, login), storeInventedLogin(api, login)]);
    const writes = storeCredential.mock.calls as unknown as Array<
      [{ label: string; write_id: string }]
    >;
    expect(writes).toHaveLength(2);
    expect(writes[0]![0].write_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(writes[1]![0].write_id).not.toBe(writes[0]![0].write_id);
    expect(writes[1]![0].label).not.toBe(writes[0]![0].label);
    expect(writes.every(([write]) => write.label.length <= 60)).toBe(true);
  });
});
