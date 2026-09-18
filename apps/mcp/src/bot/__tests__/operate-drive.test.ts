// operate_drive unit tests: request building (Choice over refs + done/stuck,
// value Choice over facts, Noul), history threading, the 0.6 confidence gate,
// each stop reason, the handoff shape, and resume-answer execution. No browser.

import { describe, expect, it } from "vitest";
import {
  DRIVE_CONFIDENCE_THRESHOLD,
  DRIVE_DEFAULT_MAX_STEPS,
  DRIVE_DEFAULT_MAX_SECONDS,
  DRIVE_FIXED_DONE,
  DRIVE_FIXED_STUCK,
  actionCriteria,
  buildDriveQuestions,
  buildHandoff,
  buildJevState,
  decideAfterJev,
  gated,
  matchingFactKeys,
  mergeCompactTable,
  mergeFacts,
  noProgressDecision,
  observationFingerprint,
  valueCriteria,
  type WireRow,
} from "../operate-drive.js";
import { operateDriveTool } from "../../tools/provision-drive.js";

const EMAIL: WireRow = ["@e:email", "t", "@email|f=email|s=r"];
const NAME: WireRow = ["@e:name", "t", "@first-name|f=first_name"];
const SUBMIT: WireRow = ["@e:go", "b", "@continue"];
const ROWS: WireRow[] = [EMAIL, NAME, SUBMIT];

describe("operate_drive constants", () => {
  it("keeps the coverage-matrix gate and call budgets as code constants", () => {
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(DRIVE_DEFAULT_MAX_STEPS).toBe(15);
    expect(DRIVE_DEFAULT_MAX_SECONDS).toBe(45);
  });
});

describe("request building", () => {
  it("asks next_action as a Choice over observed refs plus done and stuck", () => {
    const questions = buildDriveQuestions(ROWS, { email: "a@b.test" });
    const next = questions.next_action;
    expect(next?.type).toBe("choice");
    if (next?.type !== "choice") return;
    expect(Object.keys(next.criteria)).toEqual([
      "@e:email",
      "@e:name",
      "@e:go",
      DRIVE_FIXED_DONE,
      DRIVE_FIXED_STUCK,
    ]);
    expect(JSON.stringify(next)).not.toContain('"options":[');
  });

  it("asks value as a Choice over fact keys, never authored text", () => {
    const facts = { email: "a@b.test", first_name: "Ada" };
    const questions = buildDriveQuestions(ROWS, facts);
    const value = questions.value;
    expect(value?.type).toBe("choice");
    if (value?.type !== "choice") return;
    expect(valueCriteria(facts)).toEqual({
      email: "the provided email value",
      first_name: "the provided first_name value",
    });
    expect(Object.keys(value.criteria).sort()).toEqual(["email", "first_name"]);
  });

  it("omits the value question when there are no facts", () => {
    expect(buildDriveQuestions(ROWS, {}).value).toBeUndefined();
  });

  it("asks goal_complete as a Noul", () => {
    const questions = buildDriveQuestions(ROWS, {});
    expect(questions.goal_complete).toEqual({
      type: "noul",
      instructions: "Is the stated goal already complete on this page?",
    });
  });
});

describe("history threading", () => {
  it("puts the goal, fact keys, last 20 history lines, and compact rows in state", () => {
    const history = Array.from({ length: 22 }, (_, i) => `click @e:${i} conf=0.90 -> https://x.test/${i}`);
    const state = buildJevState(
      "sign up",
      ["email", "first_name"],
      history,
      "https://x.test/form",
      "form",
      ROWS,
    );
    expect(state.startsWith("goal: sign up\nfacts: email, first_name\nhistory:\n")).toBe(true);
    expect(state).not.toContain("click @e:0 ");
    expect(state).toContain("click @e:2 ");
    expect(state).toContain("click @e:21 ");
    expect(state).toContain('["@e:email","t","@email|f=email|s=r"]');
    expect(state).toContain("https://x.test/form stage=form");
  });
});

describe("confidence gate", () => {
  it("admits answers at or above 0.6 and refuses below", () => {
    expect(gated({ confidence: 0.65 })).toBe(true);
    expect(gated({ confidence: 0.6 })).toBe(true);
    expect(gated({ confidence: 0.41 })).toBe(false);
    expect(gated({ noul: 0.26 })).toBe(false);
    expect(gated(undefined)).toBe(false);
  });
});

describe("decideAfterJev stop reasons", () => {
  const base = {
    rows: ROWS,
    facts: { email: "a@b.test", first_name: "Ada" },
    lastFingerprint: null as string | null,
    lastActionKey: null as string | null,
    fingerprint: "fp1",
  };

  it("completes when goal_complete noul clears the gate", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: {
          goal_complete: { noul: 0.91 },
          next_action: { choice: DRIVE_FIXED_DONE, confidence: 0.9 },
        },
      }),
    ).toMatchObject({ kind: "complete" });
  });

  it("returns needs_value when Jev picks stuck", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: {
          goal_complete: { noul: 0.02 },
          next_action: { choice: DRIVE_FIXED_STUCK, confidence: 0.7 },
        },
      }),
    ).toEqual({ kind: "stuck", field: "email", confidence: 0.7 });
  });

  it("returns needs_value when a fillable field has no matching fact", () => {
    expect(
      decideAfterJev({
        ...base,
        facts: { first_name: "Ada" },
        answers: {
          goal_complete: { noul: 0.01 },
          next_action: { choice: "@e:email", confidence: 0.9 },
          value: { choice: "first_name", confidence: 0.9 },
        },
      }),
    ).toEqual({ kind: "needs_value", field: "email" });
  });

  it("returns low_confidence with the question, options, and probabilities", () => {
    const decision = decideAfterJev({
      ...base,
      answers: {
        goal_complete: { noul: 0.1 },
        next_action: {
          choice: "@e:go",
          confidence: 0.41,
          probabilities: { "@e:go": 0.41, stuck: 0.3 },
        },
      },
    });
    expect(decision.kind).toBe("low_confidence");
    if (decision.kind !== "low_confidence") return;
    expect(decision.question.options).toEqual(actionCriteria(ROWS));
    expect(decision.question.probabilities).toEqual({ "@e:go": 0.41, stuck: 0.3 });
  });

  it("returns no_progress when the same fingerprint and action are chosen twice", () => {
    expect(
      decideAfterJev({
        ...base,
        lastFingerprint: "fp1",
        lastActionKey: "@e:go",
        answers: {
          goal_complete: { noul: 0.01 },
          next_action: { choice: "@e:go", confidence: 0.9 },
        },
      }),
    ).toEqual({ kind: "no_progress" });
  });

  it("types a matching fact and never authors a value", () => {
    const decision = decideAfterJev({
      ...base,
      answers: {
        goal_complete: { noul: 0.01 },
        next_action: { choice: "@e:email", confidence: 0.99 },
        value: { choice: "email", confidence: 0.99 },
      },
    });
    expect(decision).toEqual({
      kind: "act",
      action: { kind: "type", target: "@e:email", text: "a@b.test" },
      actionKey: "@e:email",
      confidence: 0.99,
    });
  });

  it("reads the inbox for a fillable verification field instead of requiring an otp fact", () => {
    const otp: WireRow = ["@e:code", "t", "@verification-code|f=otp"];
    expect(
      decideAfterJev({
        ...base,
        rows: [...ROWS, otp],
        answers: {
          goal_complete: { noul: 0.01 },
          next_action: { choice: "@e:code", confidence: 0.88 },
        },
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "type", target: "@e:code" },
      special: "inbox",
    });
  });
});

describe("handoff shape", () => {
  it("always includes status, trajectory, done/remaining, and counters", () => {
    const handoff = buildHandoff({
      status: "budget",
      sessionId: "sess-1",
      trajectory: [
        { action: "click", target: "@e:go", confidence: 0.9, url: "https://x.test/a" },
      ],
      goal: "sign up",
      steps: 15,
      seconds: 45,
      jevCalls: 4,
      question: { question: "Which control?", options: { "@e:go": "continue" } },
    });
    expect(handoff).toMatchObject({
      status: "budget",
      session_id: "sess-1",
      question: "Which control?",
      options: { "@e:go": "continue" },
      done: "click @e:go",
      remaining: "sign up",
      steps: 15,
      seconds: 45,
      jev_calls: 4,
    });
    expect(handoff.trajectory).toHaveLength(1);
  });
});

describe("resume answer", () => {
  it("treats a previous handoff option key as the next action", () => {
    const decision = decideAfterJev({
      rows: ROWS,
      facts: { email: "a@b.test" },
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "resume",
      answers: {
        next_action: { choice: "@e:go", confidence: 1 },
        goal_complete: { noul: 0 },
      },
    });
    expect(decision).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:go" },
      actionKey: "@e:go",
    });
  });
});

describe("facts, fingerprint, compact merge", () => {
  it("merges added facts on resume", () => {
    expect(mergeFacts({ email: "old@x.test" }, { email: "new@x.test", company: "Acme" })).toEqual({
      email: "new@x.test",
      company: "Acme",
    });
  });

  it("matches email facts onto an email field", () => {
    expect(matchingFactKeys({ email: "a@b.test", first_name: "Ada" }, EMAIL)).toEqual(["email"]);
  });

  it("treats an unchanged map plus the same action as no progress", () => {
    const fp = observationFingerprint("https://x.test", ROWS);
    expect(
      noProgressDecision({
        fingerprint: fp,
        lastFingerprint: fp,
        actionKey: "@e:go",
        lastActionKey: "@e:go",
      }),
    ).toBe(true);
  });

  it("merges a compact delta into the retained full map", () => {
    const merged = mergeCompactTable(ROWS, {
      delta: true,
      removed: ["@e:name"],
      safe_table: [["@e:email", "t", "@email|f=email|w=acted"]],
    });
    expect(merged.map((row) => row[0])).toEqual(["@e:email", "@e:go"]);
    expect(merged[0]?.[2]).toContain("w=acted");
  });
});

describe("operate_drive tool schema", () => {
  it("requires a goal and exactly one of session_id or url", () => {
    expect(operateDriveTool.name).toBe("operate_drive");
    expect(operateDriveTool.inputSchema.parse({ url: "https://x.test/signup", goal: "sign up" })).toMatchObject({
      url: "https://x.test/signup",
      goal: "sign up",
    });
    expect(
      operateDriveTool.inputSchema.parse({
        session_id: "sess",
        goal: "sign up",
        answer: "@e:go",
        facts: { email: "a@b.test" },
      }),
    ).toMatchObject({ answer: "@e:go" });
    expect(operateDriveTool.inputSchema.safeParse({ goal: "sign up" }).success).toBe(false);
    expect(
      operateDriveTool.inputSchema.safeParse({
        session_id: "sess",
        url: "https://x.test",
        goal: "sign up",
      }).success,
    ).toBe(false);
  });

  it("steers agents to reach for it on signup and checkout goals", () => {
    expect(operateDriveTool.description).toContain("prefer it over calling operate_click");
    expect(operateDriveTool.description).toContain("signup, checkout");
  });
});
