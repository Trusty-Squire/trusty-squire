import { describe, expect, it } from "vitest";
import { OAUTH_PROVIDERS } from "../oauth-providers.js";
import {
  backOnlyDecision,
  buildDriveQuestions,
  decideAfterJev,
  driveTargetSets,
  shouldInspectSubmitResponse,
  signinContinuationDecision,
} from "../operate-drive.js";
import type { WireRow } from "../operate-drive.js";

const provider = Object.keys(OAUTH_PROVIDERS)[0]!;
const providerLabel = OAUTH_PROVIDERS[provider as keyof typeof OAUTH_PROVIDERS].label;

function answer(choice: string, criteria: Record<string, string>) {
  return {
    type: "choice" as const,
    choice,
    confidence: 0.95,
    probabilities: Object.fromEntries(
      Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
    ),
  };
}

describe("named identity sign-in", () => {
  it("chooses the requested provider before email and enterprise sign-in", () => {
    const rows: WireRow[] = [
      ["@e:email", "t", "Email|f=email"],
      ["@e:sso", "l", "Use SSO"],
      ["@e:provider", "b", `Sign up with ${providerLabel}`],
      ["@e:continue", "b", "Continue"],
    ];
    const facts = { email: "person" };
    const goal = `Sign up for this service with ${providerLabel}`;
    const sets = driveTargetSets(rows, facts, false, [], "", new Map(), (text) => text, [], {
      goal,
    });
    const questions = buildDriveQuestions(rows, facts, goal, false, [], "", new Map(), sets);
    const operation = questions.operation;
    const target = questions.TYPE_TEXT_target;
    expect(operation?.type).toBe("choice");
    expect(target?.type).toBe("choice");
    if (operation?.type !== "choice" || target?.type !== "choice") return;
    const chosen = sets.TYPE_TEXT.find((candidate) => candidate.ref === "@e:email")!;
    expect(
      decideAfterJev({
        rows,
        facts,
        goal,
        pageUrl: "",
        fingerprint: "initial",
        lastFingerprint: null,
        lastActionKey: null,
        sets,
        questions,
        answers: {
          operation: answer("TYPE_TEXT", operation.criteria),
          TYPE_TEXT_target: answer(chosen.slug, target.criteria),
        },
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "oauth_login", target: "@e:provider", provider },
    });
  });

  it("backs out of a page reached by a click whose only control returns to sign-in", () => {
    expect(backOnlyDecision([["@e:back", "l", "Back to login"]], "click")).toEqual({
      kind: "go_back",
      confidence: 1,
    });
    expect(backOnlyDecision([["@e:back", "l", "Back to login"]], undefined)).toBeUndefined();
    expect(
      backOnlyDecision(
        [
          ["@e:back", "l", "Back to login"],
          ["@e:other", "b", "Continue"],
        ],
        "click",
      ),
    ).toBeUndefined();
  });

  it("takes the ordinary continue step before an enterprise detour when the provider is not yet offered", () => {
    const rows: WireRow[] = [
      ["@e:continue", "b", "Continue"],
      ["@e:sso", "l", "Use SSO"],
    ];
    const sets = driveTargetSets(rows, {}, false);
    expect(signinContinuationDecision(`Sign up with ${providerLabel}`, sets.CLICK)).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:continue" },
    });
  });

  it("does not treat an OAuth click as an ordinary form submission", () => {
    const row: WireRow = ["@e:provider", "b", `Sign up with ${providerLabel}`];
    expect(
      shouldInspectSubmitResponse(
        { kind: "oauth_login", target: row[0], provider: provider as keyof typeof OAUTH_PROVIDERS },
        row,
      ),
    ).toBe(false);
    expect(shouldInspectSubmitResponse({ kind: "click", target: row[0] }, row)).toBe(true);
  });
});
