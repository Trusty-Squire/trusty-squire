import { describe, expect, it } from "vitest";
import {
  buildDriveQuestions,
  decideAfterJev,
  peakedProbabilities,
  type WireRow,
} from "../operate-drive.js";

const rows: WireRow[] = [
  ["@e:later", "b", "稍后再说"],
  ["@e:offer", "b", "领取优惠"],
];
const goal = "reach the API key page";

function answer(choice: string, choices: readonly string[], confidence = 0.9) {
  return {
    choice,
    confidence,
    probabilities: peakedProbabilities(choices, choice, confidence),
  };
}

function decide(
  operation: string,
  blockedByLayer: number,
  clickTarget?: string,
  dismissTarget?: string,
  visibleRows: readonly WireRow[] = rows,
) {
  const questions = buildDriveQuestions(visibleRows, {}, goal);
  const operationChoices = questions.operation;
  const clickChoices = questions.CLICK_target;
  if (operationChoices?.type !== "choice" || clickChoices?.type !== "choice") {
    throw new Error("missing choices");
  }
  return decideAfterJev({
    answers: {
      operation: answer(operation, Object.keys(operationChoices.criteria), 0.39),
      blocked_by_layer: { noul: blockedByLayer },
      ...(clickTarget === undefined
        ? {}
        : { CLICK_target: answer(clickTarget, Object.keys(clickChoices.criteria)) }),
      ...(dismissTarget === undefined
        ? {}
        : { layer_dismiss_target: answer(dismissTarget, Object.keys(clickChoices.criteria)) }),
    },
    rows: visibleRows,
    facts: {},
    lastFingerprint: null,
    lastActionKey: null,
    fingerprint: "layer",
    goal,
  });
}

const laterChoice = Object.entries(
  (buildDriveQuestions(rows, {}, goal).CLICK_target as { criteria: Record<string, string> }).criteria,
).find(([, label]) => label === "稍后再说")?.[0];
if (laterChoice === undefined) throw new Error("missing dismiss control");

describe("drive covering-layer dismissal", () => {
  it("uses the model's layer control even when operation chose GO_BACK", () => {
    expect(decide("GO_BACK", 0.71, laterChoice)).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:later" },
      actionKey: "@e:later",
    });
  });

  it("asks which visible control dismisses the layer when CLICK has no target", () => {
    const first = decide("BLOCKED", 0.9);
    expect(first).toMatchObject({ kind: "invalid_answer", reason: "layer_dismiss_target_missing" });
    if (first.kind !== "invalid_answer") throw new Error("expected a question");
    expect(Object.values(first.question.options ?? {})).toContain("稍后再说");
    expect(decide("BLOCKED", 0.9, undefined, laterChoice)).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:later" },
    });
  });

  it("excludes payment and purchase controls from the dismiss question", () => {
    const paymentRows: WireRow[] = [
      ...rows,
      ["@e:pay", "b", "Pay now|f=payment"],
      ["@e:buy", "b", "Buy now"],
    ];
    const first = decide("GO_BACK", 0.8, undefined, undefined, paymentRows);
    expect(first.kind).toBe("invalid_answer");
    if (first.kind !== "invalid_answer") throw new Error("expected a question");
    expect(Object.values(first.question.options ?? {})).toEqual(["稍后再说", "领取优惠"]);
  });

  it("keeps GO_BACK below the layer threshold", () => {
    expect(decide("GO_BACK", 0.2, laterChoice)).toMatchObject({ kind: "go_back" });
  });
});
