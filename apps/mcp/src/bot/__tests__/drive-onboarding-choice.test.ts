import { describe, expect, it } from "vitest";
import {
  buildDriveQuestions,
  decideAfterJev,
  driveTargetSets,
  peakedProbabilities,
  type WireRow,
} from "../operate-drive.js";

const rows: WireRow[] = [
  ["@e:free", "b", "Personal use. Free access under Starter plan limits. Continue for free|fm=1"],
  ["@e:trial", "b", "Business use. Three week trial, then a paid plan. Start trial|fm=1"],
  ["@e:contact", "l", "Speak with sales|u=/contact|fm=1"],
];
const pageUrl = "/account/setup";
const goal = "Create an API key";

describe("drive onboarding choices", () => {
  it("asks whether a plan choice gates the product, then takes the free option", () => {
    const sets = driveTargetSets(rows, {}, false, [], pageUrl, new Map(), (text) => text, [], {
      goal,
    });
    expect(sets.CLICK.map((candidate) => candidate.ref)).not.toContain("@e:free");

    const questions = buildDriveQuestions(rows, {}, goal, false, [], pageUrl, new Map(), sets);
    expect(questions.onboarding_gate?.type).toBe("noul");
    expect(questions.onboarding_choice?.type).toBe("choice");
    if (questions.onboarding_choice?.type !== "choice") return;
    const freeChoice = Object.keys(questions.onboarding_choice.criteria).find((key) =>
      questions.onboarding_choice?.type === "choice"
        ? questions.onboarding_choice.criteria[key]?.includes("Free access")
        : false,
    );
    expect(freeChoice).toBeDefined();
    if (freeChoice === undefined) return;

    expect(
      decideAfterJev({
        answers: {
          onboarding_gate: { noul: 0.96 },
          onboarding_choice: {
            choice: freeChoice,
            confidence: 0.95,
            probabilities: peakedProbabilities(
              Object.keys(questions.onboarding_choice.criteria),
              freeChoice,
            ),
          },
          [`onboarding_safe_${freeChoice}`]: { noul: 0.94 },
          operation: { choice: "NONE_OF_THESE", confidence: 0.8 },
        },
        rows,
        facts: {},
        goal,
        pageUrl,
        sets,
        questions,
        fingerprint: "setup",
        lastFingerprint: null,
        lastActionKey: null,
      }),
    ).toMatchObject({ kind: "act", action: { kind: "click", target: "@e:free" } });

    const trialChoice = Object.keys(questions.onboarding_choice.criteria).find((key) =>
      questions.onboarding_choice?.type === "choice"
        ? questions.onboarding_choice.criteria[key]?.includes("Three week trial")
        : false,
    );
    expect(trialChoice).toBeDefined();
    if (trialChoice === undefined) return;
    expect(
      decideAfterJev({
        answers: {
          onboarding_gate: { noul: 0.96 },
          onboarding_choice: {
            choice: trialChoice,
            confidence: 0.95,
            probabilities: peakedProbabilities(
              Object.keys(questions.onboarding_choice.criteria),
              trialChoice,
            ),
          },
          [`onboarding_safe_${trialChoice}`]: { noul: 0.03 },
          operation: { choice: "CLICK", confidence: 0.8 },
          CLICK_target: { choice: trialChoice, confidence: 0.8 },
        },
        rows,
        facts: {},
        goal,
        pageUrl,
        sets,
        questions,
        fingerprint: "setup",
        lastFingerprint: null,
        lastActionKey: null,
      }).kind,
    ).toBe("none_of_these");
  });

  it("does not offer an existing payment action as an onboarding option", () => {
    const paymentRows: WireRow[] = [
      rows[0]!,
      ["@e:pay", "b", "Select paid account and enter card details|a=payment|fm=1"],
    ];
    const question = buildDriveQuestions(
      paymentRows,
      {},
      goal,
      false,
      [],
      pageUrl,
    ).onboarding_choice;
    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") return;
    expect(Object.values(question.criteria).join(" ")).not.toContain("card details");
  });
});
