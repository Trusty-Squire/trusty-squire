import { describe, expect, it } from "vitest";
import {
  buildDriveQuestions,
  decideAfterJev,
  DRIVE_FIXED_NONE,
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
    expect(Object.keys(questions).filter((key) => key.startsWith("onboarding_"))).toEqual([
      "onboarding_gate",
      "onboarding_choice",
    ]);
    if (questions.onboarding_choice?.type !== "choice") return;
    expect(questions.onboarding_choice.instructions).toContain("no payment");
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
  });

  it("falls through to the ordinary decision when a gate judgment has no safe choice", () => {
    const ordinaryRows: WireRow[] = [
      ["@e:settings", "b", "Open settings|fm=1"],
      ["@e:reports", "b", "View reports|fm=1"],
    ];
    const ordinaryUrl = "/dashboard";
    const sets = driveTargetSets(
      ordinaryRows,
      {},
      false,
      [],
      ordinaryUrl,
      new Map(),
      (text) => text,
      [],
      { goal },
    );
    const questions = buildDriveQuestions(
      ordinaryRows,
      {},
      goal,
      false,
      [],
      ordinaryUrl,
      new Map(),
      sets,
    );
    const onboarding = questions.onboarding_choice;
    const operation = questions.operation;
    const click = questions.CLICK_target;
    expect(onboarding?.type).toBe("choice");
    expect(operation?.type).toBe("choice");
    expect(click?.type).toBe("choice");
    if (onboarding?.type !== "choice" || operation?.type !== "choice" || click?.type !== "choice") {
      return;
    }
    const settings = sets.CLICK.find((candidate) => candidate.ref === "@e:settings");
    expect(settings).toBeDefined();
    if (settings === undefined) return;

    expect(
      decideAfterJev({
        answers: {
          onboarding_gate: { noul: 0.95 },
          onboarding_choice: {
            choice: DRIVE_FIXED_NONE,
            confidence: 0.9,
            probabilities: peakedProbabilities(Object.keys(onboarding.criteria), DRIVE_FIXED_NONE),
          },
          operation: {
            choice: "CLICK",
            confidence: 0.9,
            probabilities: peakedProbabilities(Object.keys(operation.criteria), "CLICK"),
          },
          CLICK_target: {
            choice: settings.slug,
            confidence: 0.9,
            probabilities: peakedProbabilities(Object.keys(click.criteria), settings.slug),
          },
        },
        rows: ordinaryRows,
        facts: {},
        goal,
        pageUrl: ordinaryUrl,
        sets,
        questions,
        fingerprint: "dashboard",
        lastFingerprint: null,
        lastActionKey: null,
      }),
    ).toMatchObject({ kind: "act", action: { kind: "click", target: "@e:settings" } });
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
