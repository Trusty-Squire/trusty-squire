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
  actionDescription,
  buildDriveQuestions,
  buildHandoff,
  buildJevState,
  decideAfterJev,
  driveCandidates,
  gated,
  matchingFactKeys,
  mergeCompactTable,
  mergeFacts,
  nextActionInstructions,
  noProgressDecision,
  observationFingerprint,
  valueCriteria,
  type WireRow,
} from "../operate-drive.js";
import { operateDriveTool } from "../../tools/provision-drive.js";

const EMAIL: WireRow = ["@e:email", "t", "@email|f=email|s=r"];
const NAME: WireRow = ["@e:name", "t", "@first-name|f=first_name"];
const SUBMIT: WireRow = ["@e:go", "b", "@continue"];
const OFFSCREEN: WireRow = ["@e:signup", "b", "@sign-up|v=offscreen|a=signup|f=email"];
const DISABLED: WireRow = ["@e:dec", "b", "@decrease-quantity|s=d|f=quantity"];
const PAYMENT: WireRow = ["@e:pan", "t", "@card-number|f=payment"];
const ROWS: WireRow[] = [EMAIL, NAME, SUBMIT];

function slugFor(row: WireRow, includePayment = false): string {
  const hit = driveCandidates([row, ...ROWS.filter((r) => r[0] !== row[0])], includePayment).find(
    (c) => c.ref === row[0],
  );
  if (hit === undefined) throw new Error(`no slug for ${row[0]}`);
  return hit.slug;
}

describe("operate_drive constants", () => {
  it("keeps the coverage-matrix gate and call budgets as code constants", () => {
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(DRIVE_DEFAULT_MAX_STEPS).toBe(15);
    expect(DRIVE_DEFAULT_MAX_SECONDS).toBe(45);
  });
});

describe("request building", () => {
  it("asks next_action as a Choice over readable slugs plus done and stuck", () => {
    const questions = buildDriveQuestions(ROWS, { email: "a@b.test" }, "sign up");
    const next = questions.next_action;
    expect(next?.type).toBe("choice");
    if (next?.type !== "choice") return;
    const keys = Object.keys(next.criteria);
    expect(keys).toContain(DRIVE_FIXED_DONE);
    expect(keys).toContain(DRIVE_FIXED_STUCK);
    expect(keys.some((key) => key.startsWith("@e:"))).toBe(false);
    expect(JSON.stringify(next.criteria)).not.toMatch(/\bb @/);
    expect(next.instructions).toBe(nextActionInstructions("sign up"));
    expect(next.instructions).toContain("You are driving a browser to: sign up");
    expect(JSON.stringify(next)).not.toContain('"options":[');
  });

  it("describes actions in words and maps slugs back to refs", () => {
    expect(actionDescription(SUBMIT)).toBe('click the button labeled "continue"');
    expect(actionDescription(EMAIL)).toBe("type into the email field");
    const candidates = driveCandidates(ROWS, false);
    expect(candidates.map((c) => c.ref).sort()).toEqual(["@e:email", "@e:go", "@e:name"].sort());
    expect(candidates.every((c) => c.slug.startsWith("k"))).toBe(true);
  });

  it("excludes offscreen, disabled, and payment rows except at the card step", () => {
    const mixed = [...ROWS, OFFSCREEN, DISABLED, PAYMENT];
    expect(driveCandidates(mixed, false).map((c) => c.ref)).toEqual(["@e:email", "@e:name", "@e:go"]);
    expect(driveCandidates(mixed, true).map((c) => c.ref)).toContain("@e:pan");
  });

  it("asks value as a Choice over fact keys, never authored text", () => {
    const facts = { email: "a@b.test", first_name: "Ada" };
    const questions = buildDriveQuestions(ROWS, facts, "sign up");
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
    expect(buildDriveQuestions(ROWS, {}, "sign up").value).toBeUndefined();
  });

  it("asks goal_complete as a Noul", () => {
    const questions = buildDriveQuestions(ROWS, {}, "sign up");
    expect(questions.goal_complete).toEqual({
      type: "noul",
      instructions: "Is the stated goal already complete on this page?",
    });
  });
});

describe("history threading", () => {
  it("puts goal, facts, readable history, and candidate lines in prose state", () => {
    const history = Array.from({ length: 22 }, (_, i) => `click step ${i}`);
    const state = buildJevState(
      "sign up",
      ["email", "first_name"],
      history,
      "https://x.test/form",
      "Create account",
      driveCandidates(ROWS, false),
    );
    expect(state).toContain("Page: https://x.test/form (title: Create account). Goal: sign up.");
    expect(state).toContain("Facts available: email, first_name.");
    expect(state).toContain("Actions already taken, in order:");
    expect(state).toContain("click step 2 -> ");
    expect(state).toContain("click step 21");
    expect(state).not.toContain("click step 0");
    expect(state).not.toContain("@e:");
    expect(state).not.toContain('["@e:email"');
    expect(state).toContain("type into the email field");
    expect(state).toContain('click the button labeled "continue"');
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
    goal: "sign up",
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

  it("returns stuck when Jev picks stuck, not needs_value", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: {
          goal_complete: { noul: 0.02 },
          next_action: { choice: DRIVE_FIXED_STUCK, confidence: 0.7 },
        },
      }),
    ).toEqual({ kind: "stuck", confidence: 0.7 });
  });

  it("returns needs_value naming the field label when a fillable has no matching fact", () => {
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

  it("returns low_confidence with slug options and probabilities", () => {
    const go = slugFor(SUBMIT);
    const decision = decideAfterJev({
      ...base,
      answers: {
        goal_complete: { noul: 0.1 },
        next_action: {
          choice: go,
          confidence: 0.41,
          probabilities: { [go]: 0.41, stuck: 0.3 },
        },
      },
    });
    expect(decision.kind).toBe("low_confidence");
    if (decision.kind !== "low_confidence") return;
    expect(decision.question.options).toEqual(actionCriteria(ROWS));
    expect(Object.keys(decision.question.options ?? {}).some((key) => key.startsWith("@e:"))).toBe(
      false,
    );
    expect(decision.question.probabilities).toEqual({ [go]: 0.41, stuck: 0.3 });
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
      goal: "sign up",
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
