import { describe, expect, it } from "vitest";
import {
  buildDriveQuestions,
  decideAfterJev,
  peakedProbabilities,
  requiredFactTypeAction,
  type WireRow,
} from "../operate-drive.js";

describe("in-product drive recovery", () => {
  it("keeps an available list entry visible instead of auto-filling its search filter", () => {
    const rows: WireRow[] = [
      ["@e:search", "t", "Search by project name|ph=Search by project name"],
      ["@e:create", "b", "Create project"],
      ["@e:entry", "l", "default|u=https://app.example.test/dashboard/projects/default"],
    ];
    const url = "https://app.example.test/dashboard";
    const facts = { query: "Squire" };

    expect(requiredFactTypeAction(rows, facts, [], url, "reach the API key page")).toBeUndefined();
    expect(requiredFactTypeAction(rows, facts, [], url, "search for the project")).toEqual({
      target: "@e:search",
      text: "Squire",
    });
  });

  it("dismisses a covering offer through its skip control when no other rows are exposed", () => {
    const rows: WireRow[] = [
      ["@e:offer", "b", "Get Promotional Credit"],
      ["@e:skip", "b", "Skip for now"],
    ];
    const goal = "reach the API key page";
    const questions = buildDriveQuestions(rows, {}, goal);
    const criteria = questions.operation;
    if (criteria?.type !== "choice") throw new Error("missing operation choices");
    const choice = "NONE_OF_THESE";

    expect(
      decideAfterJev({
        answers: {
          operation: {
            choice,
            confidence: 0.9,
            probabilities: peakedProbabilities(Object.keys(criteria.criteria), choice, 0.9),
          },
        },
        rows,
        facts: {},
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "overlay",
        goal,
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:skip" },
      actionKey: "@e:skip",
    });
  });
});
