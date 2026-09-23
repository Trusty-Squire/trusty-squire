import { describe, expect, it } from "vitest";
import {
  buildDriveQuestions,
  decideAfterJev,
  driveTargetSets,
  peakedProbabilities,
  requiredFillableMissingFact,
  type WireRow,
} from "../operate-drive.js";

const goal =
  "Create a new app named Squire Corpus Prod. Get its production API keys. Only work inside the new app.";
const facts = { desired_title: "Squire Corpus Prod", preferred_handle: "squire-corpus-prod" };
function answer(criteria: Record<string, string>, choice: string) {
  return {
    choice,
    confidence: 0.95,
    probabilities: peakedProbabilities(Object.keys(criteria), choice),
  };
}
function choiceCriteria(question: ReturnType<typeof buildDriveQuestions>[string] | undefined) {
  return question?.type === "choice" ? question.criteria : {};
}

describe("goal values and target scope", () => {
  it("offers each create form field a model choice over supplied values and types the chosen value", () => {
    const rows: WireRow[] = [
      ["@e:1", "t", "My iOS App|ph=My iOS App|s=r"],
      ["@e:2", "t", "my-ios-app|ph=my-ios-app"],
      ["@e:3", "t", "textbox"],
      ["@e:4", "l", "Product|u=https://example.test/dashboard"],
      ["@e:5", "l", "Cancel|u=https://example.test/settings"],
      ["@e:6", "b", "Create app"],
    ];
    const pageUrl = "https://example.test/apps/new";
    const sets = driveTargetSets(rows, facts, false, [], pageUrl, new Map(), (text) => text, [], {
      goal,
    });
    const questions = buildDriveQuestions(rows, facts, goal, false, [], pageUrl, new Map(), sets);
    const fieldQuestion = questions.form_value_1;
    expect(fieldQuestion?.type).toBe("choice");
    if (fieldQuestion?.type !== "choice") return;
    expect(fieldQuestion.criteria.desired_title).toContain("Squire Corpus Prod");
    expect(questions.form_value_2?.type).toBe("choice");
    expect(requiredFillableMissingFact(rows, {}, [], pageUrl, goal)?.ref).toBe("@e:1");
    const target = sets.TYPE_TEXT.find((candidate) => candidate.ref === "@e:1");
    expect(target).toBeDefined();
    const decision = decideAfterJev({
      answers: {
        operation: answer(choiceCriteria(questions.operation), "TYPE_TEXT"),
        TYPE_TEXT_target: answer(choiceCriteria(questions.TYPE_TEXT_target), target!.slug),
        form_value_1: answer(fieldQuestion.criteria, "desired_title"),
      },
      rows,
      facts,
      goal,
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "form",
      pageUrl,
      sets,
      questions,
    });
    expect(decision).toMatchObject({
      kind: "act",
      action: { kind: "type", target: "@e:1", text: "Squire Corpus Prod" },
    });
    const filledRefs = ["@e:1", "@e:2", "@e:3"];
    const submitted = buildDriveQuestions(rows, facts, goal, false, filledRefs, pageUrl);
    const submitSets = driveTargetSets(
      rows,
      facts,
      false,
      filledRefs,
      pageUrl,
      new Map(),
      (text) => text,
      [],
      { goal },
    );
    const submit = submitSets.CLICK.find((candidate) => candidate.ref === "@e:6");
    expect(submit).toBeDefined();
    expect(
      decideAfterJev({
        answers: {
          operation: answer(choiceCriteria(submitted.operation), "CLICK"),
          CLICK_target: answer(choiceCriteria(submitted.CLICK_target), submit!.slug),
        },
        rows,
        facts,
        goal,
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "filled-form",
        filledRefs,
        pageUrl,
        sets: submitSets,
        questions: submitted,
      }),
    ).toMatchObject({ kind: "act", action: { kind: "click", target: "@e:6" } });
  });
});
