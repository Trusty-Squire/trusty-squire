import { describe, expect, it } from "vitest";
import {
  DRIVE_EMAIL_CODE_QUESTION,
  buildDriveQuestions,
  decideAfterJev,
  emailCodeCandidates,
  isOtpRow,
  type WireRow,
} from "../operate-drive.js";

function choose(choice: string, criteria: Record<string, string>) {
  const keys = Object.keys(criteria);
  return {
    choice,
    confidence: 0.99,
    probabilities: Object.fromEntries(
      keys.map((key) => [key, key === choice ? 0.99 : 0.01 / (keys.length - 1)]),
    ),
  };
}

describe("emailed code judgment", () => {
  const code: WireRow = ["@e:code", "t", "vcode|ph=your code|fm=1|s=r"];
  const rows: WireRow[] = [
    code,
    ["@e:back", "b", "back|fm=1"],
    ["@e:continue", "b", "Continue|fm=1"],
  ];

  it("offers an unrecognized required field and routes a model choice to the inbox", () => {
    expect(isOtpRow(code)).toBe(false);
    const questions = buildDriveQuestions(rows, {}, "complete signup");
    const codeQuestion = questions[DRIVE_EMAIL_CODE_QUESTION];
    expect(codeQuestion?.type).toBe("choice");
    if (codeQuestion?.type !== "choice") return;
    expect(codeQuestion.criteria).toHaveProperty("code_field_1");
    const decision = decideAfterJev({
      answers: { [DRIVE_EMAIL_CODE_QUESTION]: choose("code_field_1", codeQuestion.criteria) },
      rows,
      facts: {},
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "page",
      goal: "complete signup",
    });
    expect(decision).toMatchObject({
      kind: "act",
      action: { kind: "type", target: "@e:code", text: "" },
      special: "inbox",
    });
  });

  it("offers a code field without English labels while excluding unrelated controls", () => {
    const unknown: WireRow = ["@e:unlabeled", "t", "確認番号|ph=番号を入力|s=r"];
    const candidates = emailCodeCandidates([
      ["@e:email", "t", "Correo|n=person@example.test"],
      unknown,
      ["@e:password", "t", "password|f=password"],
    ]);
    expect(candidates.map((candidate) => candidate.ref)).toEqual(["@e:unlabeled"]);
    const question = buildDriveQuestions([unknown], {}, "complete signup")[
      DRIVE_EMAIL_CODE_QUESTION
    ];
    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") return;
    expect(question.criteria).toHaveProperty("code_field_1");
    expect(question.criteria).toHaveProperty("none");
  });
});
