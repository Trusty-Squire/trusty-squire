import { describe, expect, it } from "vitest";
import { buildDriveQuestions, decideAfterJev, type WireRow } from "../operate-drive.js";

// Rows and vote shapes from a recorded account-chooser step (names, emails and
// the app name replaced): the chooser shows the app name as a button above the
// account tiles, and the target vote split between it and the right tile.
const rows: WireRow[] = [
  ["@e:f0d1", "b", "example-app.test"],
  ["@e:f0d2", "l", "Ada Example ada@example.test|f=email"],
  ["@e:f0d3", "l", "Bo Example bo@example.test|f=email"],
  ["@e:f0d4", "l", "Use another account"],
  [
    "@e:f0d5",
    "combobox",
    "Change language English (United States)|a=picker|n=English (United States)",
  ],
  [
    "@e:f0d6",
    "l",
    "Open Google Account Help Center (external, opens in a new window)|u=https://support.example.test/help",
  ],
  [
    "@e:f0d7",
    "l",
    "Privacy Policy (external, opens in a new window)|u=https://example.test/privacy",
  ],
  [
    "@e:f0d8",
    "l",
    "Terms of Service (external, opens in a new window)|u=https://example.test/terms",
  ],
];
const goal = "sign in with the identity already connected to Squire";

const clickQuestion = buildDriveQuestions(rows, {}, goal).CLICK_target;

function clickSlugs(): { app: string; ada: string; bo: string; other: string } {
  const question = clickQuestion;
  if (question?.type !== "choice") throw new Error("no CLICK target question");
  const slugFor = (label: string): string => {
    const entry = Object.entries(question.criteria).find(([, text]) => text.startsWith(label));
    if (entry === undefined) throw new Error(`no slug for ${label}`);
    return entry[0];
  };
  return {
    app: slugFor("example-app.test"),
    ada: slugFor("Ada Example"),
    bo: slugFor("Bo Example"),
    other: slugFor("Use another account"),
  };
}

function decide(
  target: { choice: string; probabilities: Record<string, number>; confidence: number },
  identityEmail: string | null,
) {
  return decideAfterJev({
    answers: {
      operation: {
        choice: "CLICK",
        confidence: 0.73,
        probabilities: {
          CLICK: 0.77,
          INBOX: 0,
          WAIT: 0.01,
          DONE: 0,
          BLOCKED: 0.03,
          NONE_OF_THESE: 0.15,
          GO_BACK: 0.04,
        },
      },
      CLICK_target: {
        ...target,
        // Every other offered control drew no vote, as in the recorded step.
        probabilities: {
          ...Object.fromEntries(
            Object.keys(clickQuestion?.type === "choice" ? clickQuestion.criteria : {}).map(
              (key) => [key, 0],
            ),
          ),
          ...target.probabilities,
        },
      },
    },
    rows,
    facts: {},
    lastFingerprint: null,
    lastActionKey: null,
    fingerprint: "chooser",
    goal,
    identityEmail,
  });
}

describe("account-choice vote and the session identity", () => {
  const slugs = clickSlugs();
  // Recorded split: the right tile .51, the app-name button .32.
  const split = {
    choice: slugs.ada,
    confidence: 0.44,
    probabilities: { [slugs.app]: 0.32, [slugs.ada]: 0.51, [slugs.bo]: 0.09, [slugs.other]: 0.08 },
  };

  it("stops as low_confidence on the recorded split when the identity is unknown", () => {
    expect(decide(split, null)).toMatchObject({ kind: "low_confidence" });
  });

  it("clicks the tile showing the session's email on the same split", () => {
    expect(decide(split, "ADA@example.test")).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:f0d2" },
    });
  });

  it("chooses the session's account over another account tile the vote picked", () => {
    const wrongTile = {
      choice: slugs.bo,
      confidence: 0.5,
      probabilities: { [slugs.app]: 0.1, [slugs.ada]: 0.3, [slugs.bo]: 0.55, [slugs.other]: 0.05 },
    };
    expect(decide(wrongTile, "ada@example.test")).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:f0d2" },
    });
  });

  it("leaves a vote for a control without an email to the ordinary admission", () => {
    const appButton = {
      choice: slugs.app,
      confidence: 0.44,
      probabilities: {
        [slugs.app]: 0.51,
        [slugs.ada]: 0.32,
        [slugs.bo]: 0.09,
        [slugs.other]: 0.08,
      },
    };
    expect(decide(appButton, "ada@example.test")).toMatchObject({ kind: "low_confidence" });
  });

  it("does not pick a tile when no candidate shows the session's email", () => {
    expect(decide(split, "someone@example.test")).toMatchObject({ kind: "low_confidence" });
  });
});
