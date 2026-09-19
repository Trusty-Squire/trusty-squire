// operate_drive unit tests: two-head operation + per-op target, structured
// state, validate_choice, no confidence gates, each stop reason, the
// handoff shape, and resume-answer execution. No browser.

import { describe, expect, it } from "vitest";
import {
  DRIVE_CONFIDENCE_THRESHOLD,
  DRIVE_DEFAULT_MAX_STEPS,
  DRIVE_DEFAULT_MAX_SECONDS,
  DRIVE_FIXED_NONE,
  DRIVE_MAX_CANDIDATES,
  DRIVE_MAX_JEV_CALLS,
  DRIVE_RULES,
  DRIVE_VALUE_QUESTION,
  goalValueCriteria,
  DRIVE_IDENTICAL_RESNAP_MS,
  DRIVE_STALE_LIMIT,
  actionDescription,
  admitsChoice,
  isSuggestionRow,
  buildDriveQuestions,
  buildFillQuestions,
  buildHandoff,
  buildJevState,
  clickableCandidates,
  decideAfterJev,
  decideFills,
  driveCandidates,
  fillActionForCandidate,
  fillQuestionName,
  fillableCandidates,
  gated,
  isOtpRow,
  lastActionWasClick,
  matchingFactKeys,
  mergeCompactTable,
  mergeFacts,
  nextActionInstructions,
  noProgressDecision,
  observationFingerprint,
  pageTextFromObservation,
  peakedProbabilities,
  requiredFillableMissingFact,
  selectTargetKey,
  typeableCandidates,
  validateChoice,
  validateChoiceReason,
  type DriveCandidate,
  type WireRow,
} from "../operate-drive.js";
import { operateDriveTool } from "../../tools/provision-drive.js";
import type { JevAnswer } from "../jev-client.js";

const EMAIL: WireRow = ["@e:email", "t", "@email|f=email|s=r"];
const NAME: WireRow = ["@e:name", "t", "@first-name|f=first_name"];
const SUBMIT: WireRow = ["@e:go", "b", "@continue"];
const OFFSCREEN: WireRow = ["@e:signup", "b", "@sign-up|v=offscreen|a=signup|f=email"];
const DISABLED: WireRow = ["@e:dec", "b", "@decrease-quantity|s=d|f=quantity"];
const PAYMENT: WireRow = ["@e:pan", "t", "@card-number|f=payment"];
const STATE: WireRow = ["@e:state", "s", "@state|s=r|f=state"];
const ROWS: WireRow[] = [EMAIL, NAME, SUBMIT];

function slugFor(row: WireRow, includePayment = false): string {
  const hit = driveCandidates([row, ...ROWS.filter((r) => r[0] !== row[0])], includePayment).find(
    (c) => c.ref === row[0],
  );
  if (hit === undefined) throw new Error(`no slug for ${row[0]}`);
  return hit.slug;
}

function valid(choice: string, criteria: Record<string, string>, confidence = 0.91): JevAnswer {
  return {
    choice,
    confidence,
    probabilities: peakedProbabilities(Object.keys(criteria), choice, Math.min(confidence, 0.91)),
  };
}

describe("operate_drive constants", () => {
  it("keeps the coverage-matrix gate and two-head budgets as code constants", () => {
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(DRIVE_DEFAULT_MAX_STEPS).toBe(60);
    expect(DRIVE_DEFAULT_MAX_SECONDS).toBe(45);
    expect(DRIVE_MAX_JEV_CALLS).toBe(120);
    expect(DRIVE_MAX_CANDIDATES).toBe(250);
    expect(DRIVE_STALE_LIMIT).toBe(3);
    expect(DRIVE_IDENTICAL_RESNAP_MS).toBe(200);
  });
});

describe("request building", () => {
  it("asks operation plus scoped target heads, never a flat mix of fillables and clickables", () => {
    const questions = buildDriveQuestions(ROWS, { email: "a@b.test", first_name: "Ada" }, "sign up");
    const operation = questions.operation;
    expect(operation?.type).toBe("choice");
    if (operation?.type !== "choice") return;
    expect(Object.keys(operation.criteria)).toEqual(
      expect.arrayContaining(["CLICK", "TYPE_TEXT", "WAIT", "DONE", "BLOCKED"]),
    );
    expect(operation.criteria).not.toHaveProperty("SELECT");
    expect(questions.goal_complete).toBeUndefined();
    expect(questions.next_action).toBeUndefined();
    expect(questions.SCROLL_target).toBeUndefined();
    expect(Object.keys(questions).sort()).toEqual(["CLICK_target", "TYPE_TEXT_target", "operation"]);
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions.CLICK_target?.type).toBe("choice");
    if (questions.TYPE_TEXT_target?.type !== "choice" || questions.CLICK_target?.type !== "choice") {
      return;
    }
    expect(Object.keys(questions.TYPE_TEXT_target.criteria)).toContain(slugFor(EMAIL));
    expect(Object.keys(questions.TYPE_TEXT_target.criteria)).not.toContain(slugFor(SUBMIT));
    expect(Object.keys(questions.CLICK_target.criteria)).toContain(slugFor(SUBMIT));
    expect(Object.keys(questions.CLICK_target.criteria)).not.toContain(slugFor(EMAIL));
    expect(questions.CLICK_target.criteria[slugFor(SUBMIT)]).toBe("continue");
    expect(questions.TYPE_TEXT_target.criteria[slugFor(EMAIL)]).toBe("email");
    expect(JSON.stringify(questions)).not.toContain('"options":[');
    expect(operation.instructions).toBe(nextActionInstructions("sign up"));
  });

  it("describes actions in words and maps slugs back to refs", () => {
    expect(actionDescription(SUBMIT)).toBe('click the button labeled "continue"');
    expect(actionDescription(EMAIL)).toBe("type into the email field");
    const candidates = driveCandidates(ROWS, false);
    expect(candidates.map((c) => c.ref).sort()).toEqual(["@e:email", "@e:go", "@e:name"].sort());
    expect(candidates.every((c) => c.slug.startsWith("k"))).toBe(true);
  });

  it("labels list-ordinal suggestion rows as the suggestion for the typed search field", () => {
    const search: WireRow = ["@e:q", "t", "Search Wikipedia|a=search|f=search"];
    const suggestion: WireRow = ["@e:z1", "l", "Zürich, largest city in Switzerland|f=city|q=1/6"];
    const other: WireRow = ["@e:z2", "l", "Zürich, canton of Switzerland|f=city|q=2/6"];
    const go: WireRow = ["@e:go", "b", "Search|a=search"];
    const donate: WireRow = ["@e:d", "l", "Donate|q=1/2"];
    const page = [search, suggestion, other, go];
    expect(isSuggestionRow(suggestion, page)).toBe(true);
    expect(isSuggestionRow(donate, [...page, donate])).toBe(false);
    expect(isSuggestionRow(suggestion, [suggestion, go])).toBe(false);
    expect(actionDescription(suggestion, page)).toBe(
      'click the suggestion "Zürich, largest city in Switzerland" for the Search Wikipedia field',
    );
    expect(actionDescription(go, page)).toBe('click the button labeled "Search"');
    expect(actionDescription(donate, [...page, donate])).toBe('click the link labeled "Donate"');
    const click = clickableCandidates(page, false).find((c) => c.ref === "@e:z1");
    expect(click?.description).toBe(
      'click the suggestion "Zürich, largest city in Switzerland" for the Search Wikipedia field',
    );
  });

  it("excludes offscreen, disabled, and payment rows except at the card step", () => {
    const mixed = [...ROWS, OFFSCREEN, DISABLED, PAYMENT];
    expect(driveCandidates(mixed, false).map((c) => c.ref)).toEqual(["@e:email", "@e:name", "@e:go"]);
    expect(driveCandidates(mixed, true).map((c) => c.ref)).toContain("@e:pan");
  });

  it("puts SELECT option keys on the SELECT_target head", () => {
    const facts = { state: "California" };
    const questions = buildDriveQuestions([STATE, SUBMIT], facts, "pick a state");
    expect(questions.SELECT_target?.type).toBe("choice");
    if (questions.SELECT_target?.type !== "choice") return;
    const keys = Object.keys(questions.SELECT_target.criteria);
    expect(keys.some((key) => key.includes(":"))).toBe(true);
    expect(keys).toContain(selectTargetKey(slugFor(STATE), "California"));
    const withPage = buildDriveQuestions(
      [STATE, SUBMIT],
      {},
      "pick a state",
      false,
      [],
      "",
      new Map([["state", ["Oregon", "California"]]]),
    );
    expect(withPage.SELECT_target?.type).toBe("choice");
    if (withPage.SELECT_target?.type !== "choice") return;
    expect(Object.keys(withPage.SELECT_target.criteria).some((key) => key.includes("oregon"))).toBe(true);
  });

  it("omits empty target heads", () => {
    const questions = buildDriveQuestions([SUBMIT], {}, "just click");
    expect(questions.TYPE_TEXT_target).toBeUndefined();
    expect(questions.SELECT_target).toBeUndefined();
    expect(questions.CLICK_target?.type).toBe("choice");
  });
});

describe("page text from observation", () => {
  it("joins title, headings, and blocker prose", () => {
    expect(
      pageTextFromObservation({
        semantic: {
          title: "Create account",
          headings: ["Sign up", ""],
          blockers: [{ text: "Confirm you are human" }],
        },
      }),
    ).toBe("Create account\nSign up\nConfirm you are human");
    expect(
      pageTextFromObservation(
        { semantic: { title: "HN" } },
        ["first story", "control", ""],
      ),
    ).toBe("HN\nfirst story");
    expect(
      pageTextFromObservation({
        semantic: { title: "Zurich", headings: ["Zürich"] },
        dom: "<a href='/wiki/Zurich'>long article markup</a>".repeat(40),
      }),
    ).toBe("Zurich\nZürich");
  });
});

describe("history threading", () => {
  it("puts goal, facts, recent actions, and element operations in structured state", () => {
    const history = Array.from({ length: 22 }, (_, i) => `click step ${i}`);
    const state = buildJevState(
      "sign up",
      ["email", "first_name"],
      history,
      "https://x.test/form",
      "Create account",
      driveCandidates(ROWS, false),
    );
    expect(state.page).toEqual({
      url: "https://x.test/form",
      title: "Create account",
      text: "",
    });
    expect(state.instructions.goal).toBe("sign up");
    expect(state.instructions.rules).toEqual(DRIVE_RULES);
    expect(state.facts).toEqual(["email", "first_name"]);
    expect(state.recent_actions[0]).toBe("click step 2");
    expect(state.recent_actions.at(-1)).toBe("click step 21");
    expect(state.recent_actions).not.toContain("click step 0");
    expect(JSON.stringify(state.elements)).not.toContain("@e:");
    expect(state.elements.some((element) => element.description === "email")).toBe(true);
    expect(state.elements.some((element) => element.operations.includes("CLICK"))).toBe(true);
  });
});

describe("confidence gate and validate_choice", () => {
  it("admits answers at or above 0.6 and refuses below", () => {
    expect(gated({ confidence: 0.65 })).toBe(true);
    expect(gated({ confidence: 0.6 })).toBe(true);
    expect(gated({ confidence: 0.41 })).toBe(false);
    expect(gated({ noul: 0.26 })).toBe(false);
    expect(gated(undefined)).toBe(false);
  });

  it("rejects a choice that is not offered, not argmax, or badly normalized", () => {
    const criteria = { CLICK: "click", DONE: "done" };
    expect(validateChoice(criteria, valid("CLICK", criteria))).toBe(true);
    expect(validateChoice(criteria, { choice: "SCROLL", confidence: 0.9, probabilities: { CLICK: 1 } })).toBe(
      false,
    );
    expect(
      validateChoice(criteria, {
        choice: "CLICK",
        confidence: 0.9,
        probabilities: { CLICK: 0.4, DONE: 0.6 },
      }),
    ).toBe(false);
    expect(
      validateChoice(criteria, {
        choice: "CLICK",
        confidence: 0.9,
        probabilities: { CLICK: 0.5, DONE: 0.4 },
      }),
    ).toBe(false);
    expect(validateChoiceReason(criteria, { choice: "SCROLL", confidence: 0.9, probabilities: { CLICK: 1 } })).toBe(
      "choice_not_offered",
    );
    expect(
      admitsChoice(criteria, { choice: "SCROLL", confidence: 0.9, probabilities: { CLICK: 1 } }),
    ).toEqual({ kind: "invalid_answer", reason: "choice_not_offered", confidence: 0.9 });
    expect(
      admitsChoice(
        criteria,
        { choice: "CLICK", confidence: 0.26, probabilities: peakedProbabilities(Object.keys(criteria), "CLICK", 0.91) },
        { reversible: true },
      ),
    ).toEqual({ ok: true });
    expect(
      admitsChoice(
        criteria,
        { choice: "DONE", confidence: 0.2, probabilities: peakedProbabilities(Object.keys(criteria), "DONE", 0.91) },
        { hard: true },
      ),
    ).toEqual({ ok: true });
  });
});

describe("decideAfterJev stop reasons", () => {
  const facts = { email: "a@b.test", first_name: "Ada" };
  const questions = buildDriveQuestions(ROWS, facts, "sign up");
  const operationCriteriaMap =
    questions.operation?.type === "choice" ? questions.operation.criteria : {};
  const typeCriteria =
    questions.TYPE_TEXT_target?.type === "choice" ? questions.TYPE_TEXT_target.criteria : {};
  const clickCriteria =
    questions.CLICK_target?.type === "choice" ? questions.CLICK_target.criteria : {};
  const base = {
    rows: ROWS,
    facts,
    lastFingerprint: null as string | null,
    lastActionKey: null as string | null,
    fingerprint: "fp1",
    goal: "sign up",
  };

  it("completes when operation is a valid gated DONE", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: { operation: valid("DONE", operationCriteriaMap, 0.91) },
      }),
    ).toMatchObject({ kind: "complete" });
  });

  it("returns stuck when Jev picks BLOCKED, not needs_value", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: { operation: valid("BLOCKED", operationCriteriaMap, 0.7) },
      }),
    ).toEqual({ kind: "stuck", confidence: 0.7 });
  });

  it("returns wait when Jev picks WAIT", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: { operation: valid("WAIT", operationCriteriaMap, 0.8) },
      }),
    ).toEqual({ kind: "wait", confidence: 0.8 });
  });

  it("returns needs_value naming the field label when a required fillable has no matching fact", () => {
    const missingFacts = { first_name: "Ada" };
    expect(requiredFillableMissingFact(ROWS, missingFacts, false)?.ref).toBe("@e:email");
  });

  it("acts on a validated reversible pick with no confidence floor", () => {
    const go = slugFor(SUBMIT);
    expect(
      decideAfterJev({
        ...base,
        answers: {
          operation: {
            choice: "CLICK",
            confidence: 0.41,
            probabilities: peakedProbabilities(Object.keys(operationCriteriaMap), "CLICK", 0.41),
          },
          CLICK_target: valid(go, clickCriteria),
        },
      }),
    ).toMatchObject({ kind: "act", action: { kind: "click", target: "@e:go" }, confidence: 0.41 });
  });

  it("acts on a validated reversible pick below 0.3 and completes a validated DONE with no floor", () => {
    const go = slugFor(SUBMIT);
    expect(
      decideAfterJev({
        ...base,
        answers: {
          operation: {
            choice: "CLICK",
            confidence: 0.26,
            probabilities: peakedProbabilities(Object.keys(operationCriteriaMap), "CLICK", 0.26),
          },
          CLICK_target: valid(go, clickCriteria),
        },
      }),
    ).toMatchObject({ kind: "act", action: { kind: "click", target: "@e:go" }, confidence: 0.26 });
    expect(
      decideAfterJev({
        ...base,
        answers: {
          operation: {
            choice: "DONE",
            confidence: 0.41,
            probabilities: peakedProbabilities(Object.keys(operationCriteriaMap), "DONE", 0.41),
          },
          CLICK_target: valid(go, clickCriteria),
        },
      }),
    ).toMatchObject({ kind: "complete", confidence: 0.41 });
    expect(
      decideAfterJev({
        ...base,
        answers: {
          operation: {
            choice: "DONE",
            confidence: 0.41,
            probabilities: peakedProbabilities(Object.keys(operationCriteriaMap), "DONE", 0.41),
          },
        },
      }),
    ).toMatchObject({ kind: "complete", confidence: 0.41 });
  });

  it("reports invalid_answer with the validation reason instead of low_confidence", () => {
    expect(
      decideAfterJev({
        ...base,
        answers: {
          operation: {
            choice: "SCROLL",
            confidence: 0.91,
            probabilities: peakedProbabilities(["CLICK", "DONE"], "CLICK", 0.91),
          },
        },
      }),
    ).toMatchObject({ kind: "invalid_answer", reason: "choice_not_offered", confidence: 0.91 });
  });

  it("acts on a validated payment click with no confidence floor", () => {
    const pay: WireRow = ["@e:pay", "b", "@pay-now|f=payment"];
    const paymentRows: WireRow[] = [pay];
    const paymentQuestions = buildDriveQuestions(paymentRows, { card_ref: "card-1" }, "pay", true);
    const ops = paymentQuestions.operation?.type === "choice" ? paymentQuestions.operation.criteria : {};
    const clicks = paymentQuestions.CLICK_target?.type === "choice" ? paymentQuestions.CLICK_target.criteria : {};
    const paySlug = Object.keys(clicks)[0];
    expect(paySlug).toBeDefined();
    if (paySlug === undefined) return;
    expect(
      decideAfterJev({
        rows: paymentRows,
        facts: { card_ref: "card-1" },
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "fp1",
        goal: "pay",
        cardRef: "card-1",
        answers: {
          operation: {
            choice: "CLICK",
            confidence: 0.45,
            probabilities: peakedProbabilities(Object.keys(ops), "CLICK", 0.45),
          },
          CLICK_target: {
            choice: paySlug,
            confidence: 0.45,
            probabilities: peakedProbabilities(Object.keys(clicks), paySlug, 0.45),
          },
        },
      }).kind,
    ).toBe("act");
  });

  it("repeats a same-ref click so three-strike can wait for in-place widgets", () => {
    expect(
      decideAfterJev({
        ...base,
        lastFingerprint: "fp1",
        lastActionKey: "@e:go",
        answers: {
          operation: valid("CLICK", operationCriteriaMap),
          CLICK_target: valid(slugFor(SUBMIT), clickCriteria),
        },
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:go" },
      actionKey: "@e:go",
    });
  });

  it("types a matching fact and never authors a value", () => {
    const decision = decideAfterJev({
      ...base,
      answers: {
        operation: valid("TYPE_TEXT", operationCriteriaMap, 0.99),
        TYPE_TEXT_target: valid(slugFor(EMAIL), typeCriteria, 0.99),
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
    const withOtp = [...ROWS, otp];
    const otpQuestions = buildDriveQuestions(withOtp, facts, "sign up");
    const otpOp =
      otpQuestions.operation?.type === "choice" ? otpQuestions.operation.criteria : {};
    const otpTargets =
      otpQuestions.TYPE_TEXT_target?.type === "choice" ? otpQuestions.TYPE_TEXT_target.criteria : {};
    const otpSlug = Object.keys(otpTargets).find((key) => otpTargets[key]?.includes("verification"));
    expect(otpSlug).toBeDefined();
    expect(
      decideAfterJev({
        ...base,
        rows: withOtp,
        answers: {
          operation: valid("TYPE_TEXT", otpOp),
          TYPE_TEXT_target: valid(otpSlug!, otpTargets),
        },
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "type", target: "@e:code" },
      special: "inbox",
    });
  });

  it("ignores an unused target head so it cannot cause an action", () => {
    const decision = decideAfterJev({
      ...base,
      answers: {
        operation: valid("TYPE_TEXT", operationCriteriaMap, 0.99),
        TYPE_TEXT_target: valid(slugFor(EMAIL), typeCriteria, 0.99),
        CLICK_target: valid(slugFor(SUBMIT), clickCriteria, 0.99),
      },
    });
    expect(decision).toMatchObject({
      kind: "act",
      action: { kind: "type", target: "@e:email" },
    });
  });

  it("emits a select action for a long option label, not a type", () => {
    const factsWithState = { ...facts, state: "California" };
    const questionsWithState = buildDriveQuestions([STATE, SUBMIT], factsWithState, "pick a state");
    const operation = questionsWithState.operation?.type === "choice" ? questionsWithState.operation.criteria : {};
    const selectCriteria =
      questionsWithState.SELECT_target?.type === "choice" ? questionsWithState.SELECT_target.criteria : {};
    const optionKey = Object.keys(selectCriteria).find((key) => key.includes(":"));
    expect(optionKey).toBeDefined();
    const decision = decideAfterJev({
      rows: [STATE, SUBMIT],
      facts: factsWithState,
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "fp1",
      goal: "pick a state",
      answers: {
        operation: valid("SELECT", operation, 0.91),
        SELECT_target: valid(optionKey!, selectCriteria, 0.91),
      },
    });
    expect(decision).toMatchObject({
      kind: "act",
      action: { kind: "select", target: "@e:state", text: "California" },
    });
  });
});

describe("form-fill assignment helpers", () => {
  const facts = { email: "a@b.test", first_name: "Ada" };

  it("fills every gated value answer in DOM order and skips none", () => {
    const fillables = fillableCandidates(ROWS, facts, false);
    const decided = decideFills({
      answers: {
        [fillQuestionName(slugFor(EMAIL))]: { choice: "email", confidence: 0.99 },
        [fillQuestionName(slugFor(NAME))]: { choice: DRIVE_FIXED_NONE, confidence: 0.8 },
      },
      candidates: fillables,
      facts,
    });
    expect(decided.actions).toEqual([
      {
        kind: "act",
        action: { kind: "type", target: "@e:email", text: "a@b.test" },
        actionKey: "@e:email",
        confidence: 0.99,
      },
    ]);
  });

  it("selects option text on select-like rows instead of typing it", () => {
    const address: DriveCandidate = {
      ref: "@e:addr",
      role: "s",
      slug: "kaddress",
      description: "choose an option in the address field",
      row: ["@e:addr", "s", "@address|s=r|f=address"],
    };
    const country: DriveCandidate = {
      ref: "@e:co",
      role: "s",
      slug: "kcountry",
      description: "choose an option in the country field",
      row: ["@e:co", "s", "@country-region|s=r|f=region"],
    };
    expect(fillActionForCandidate(address, { address: "1 Market St" }, "address", 1)).toMatchObject({
      action: { kind: "select", target: "@e:addr", text: "1 Market St" },
    });
    expect(fillActionForCandidate(country, { country: "US" }, "country", 1)).toMatchObject({
      action: { kind: "select", target: "@e:co", text: "US" },
    });
  });

  it("treats only OTP-shaped labels and fields as verification rows", () => {
    expect(isOtpRow(["@e:code", "t", "@verification-code|f=otp"])).toBe(true);
    expect(isOtpRow(["@e:otp", "t", "@one-time-code"])).toBe(true);
    expect(isOtpRow(["@e:pin", "t", "@authenticator"])).toBe(true);
    expect(isOtpRow(["@e:q", "t", "@search|f=search"])).toBe(false);
    expect(isOtpRow(["@e:co", "s", "@country|f=country"])).toBe(false);
    expect(isOtpRow(["@e:go", "b", "@verify-email|a=submit"])).toBe(false);
    expect(isOtpRow(["@e:zip", "t", "@postal-code|f=zip"])).toBe(false);
  });

  it("names a required fillable with no matching fact as needs_value", () => {
    const missing = requiredFillableMissingFact(ROWS, { first_name: "Ada" }, false);
    expect(missing?.ref).toBe("@e:email");
    expect(missing ? missing.row : undefined).toBe(EMAIL);
  });

  it("treats a click as the last action for the email-check fallback", () => {
    expect(lastActionWasClick([{ action: "click", target: "@e:go", confidence: 0.9, url: "https://x.test" }])).toBe(
      true,
    );
    expect(lastActionWasClick([{ action: "type", target: "@e:email", confidence: 0.9, url: "https://x.test" }])).toBe(
      false,
    );
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
      question: { question: "Which control?", options: { CLICK: "click a visible control" } },
    });
    expect(handoff).toMatchObject({
      status: "budget",
      session_id: "sess-1",
      question: "Which control?",
      options: { CLICK: "click a visible control" },
      done: "click @e:go",
      remaining: "sign up",
      steps: 15,
      seconds: 45,
      jev_calls: 4,
    });
    expect(handoff.trajectory).toHaveLength(1);
  });

  it("includes confidence and the validation reason on a refusal handoff", () => {
    expect(
      buildHandoff({
        status: "invalid_answer",
        trajectory: [],
        goal: "open Zurich",
        steps: 1,
        seconds: 3,
        jevCalls: 2,
        question: { question: "Which operation?", options: { CLICK: "click" } },
        confidence: 0.88,
        reason: "choice_not_offered",
      }),
    ).toMatchObject({
      status: "invalid_answer",
      confidence: 0.88,
      reason: "choice_not_offered",
    });
  });
});

describe("resume answer", () => {
  it("treats a previous handoff option key as the next action", () => {
    const questions = buildDriveQuestions(ROWS, { email: "a@b.test" }, "sign up");
    const operationCriteriaMap =
      questions.operation?.type === "choice" ? questions.operation.criteria : {};
    const clickCriteria =
      questions.CLICK_target?.type === "choice" ? questions.CLICK_target.criteria : {};
    const decision = decideAfterJev({
      rows: ROWS,
      facts: { email: "a@b.test" },
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "resume",
      goal: "sign up",
      answers: {
        operation: valid("CLICK", operationCriteriaMap, 1),
        CLICK_target: valid(slugFor(SUBMIT), clickCriteria, 1),
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

  it("matches last_name onto a last-name label even when f=name", () => {
    const last: WireRow = ["@e:ln", "t", "@last-name|f=name|s=r"];
    expect(matchingFactKeys({ last_name: "Lovelace", first_name: "Ada" }, last)).toEqual(["last_name"]);
  });

  it("matches a query fact onto a search field", () => {
    const search: WireRow = ["@e:q", "t", "@search|s=r"];
    expect(matchingFactKeys({ query: "Zurich weather" }, search)).toEqual(["query"]);
  });

  it("includes offscreen fillable rows on a checkout URL only", () => {
    const last: WireRow = ["@e:ln", "t", "@last-name|v=offscreen|s=r"];
    const newsletter: WireRow = ["@e:em", "t", "@email|v=offscreen|s=r|a=signup|f=email"];
    expect(
      fillableCandidates([last, SUBMIT], { last_name: "Lovelace" }, false).map((c) => c.ref),
    ).toEqual(["@e:ln"]);
    expect(
      fillableCandidates(
        [last, SUBMIT],
        { last_name: "Lovelace" },
        false,
        [],
        "https://whitejade.xyz/checkouts/cn/token/en-us",
      ).map((c) => c.ref),
    ).toEqual(["@e:ln"]);
    expect(
      fillableCandidates(
        [newsletter, SUBMIT],
        { email: "a@b.test" },
        false,
        [],
        "https://whitejade.xyz/products/the-glow-serum",
      ).map((c) => c.ref),
    ).toEqual([]);
    expect(driveCandidates([last, SUBMIT], false).map((c) => c.ref)).toEqual(["@e:go"]);
  });

  it("keeps a disabled continue/submit in the clickable set", () => {
    const cont: WireRow = ["@e:go", "b", "@continue|s=d"];
    expect(clickableCandidates([EMAIL, cont], false).map((c) => c.ref)).toEqual(["@e:go"]);
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

  it("keeps acted markers and committed field state in the progress fingerprint", () => {
    const acted: WireRow = ["@e:state", "s", "@state|w=acted"];
    const before = observationFingerprint("https://x.test", [acted]);
    const afterFill = observationFingerprint("https://x.test", [acted], ["filled:@e:state", "sel:state=California"]);
    expect(before).toContain("w=acted");
    expect(afterFill).not.toBe(before);
    expect(
      noProgressDecision({
        fingerprint: afterFill,
        lastFingerprint: before,
        actionKey: "@e:state",
        lastActionKey: "@e:state",
      }),
    ).toBe(false);
  });

  it("offers a search field for TYPE_TEXT even without a query fact, then needs_value", () => {
    const search: WireRow = ["@e:q", "t", "@search-wikipedia|f=search"];
    const goal = "Open the Wikipedia article for Zurich";
    const questions = buildDriveQuestions([search, SUBMIT], {}, goal);
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions[DRIVE_VALUE_QUESTION]?.type).toBe("choice");
    expect(typeableCandidates([search], {}, false).map((c) => c.ref)).toEqual(["@e:q"]);
    const ops = questions.operation?.type === "choice" ? questions.operation.criteria : {};
    const types = questions.TYPE_TEXT_target?.type === "choice" ? questions.TYPE_TEXT_target.criteria : {};
    const values = questions[DRIVE_VALUE_QUESTION]?.type === "choice" ? questions[DRIVE_VALUE_QUESTION].criteria : {};
    const searchSlug = Object.keys(types)[0];
    expect(searchSlug).toBeDefined();
    if (searchSlug === undefined) return;
    const zurich = Object.entries(values).find(([, text]) => text === "Zurich")?.[0];
    expect(zurich).toBeDefined();
    if (zurich === undefined) return;
    expect(
      decideAfterJev({
        rows: [search, SUBMIT],
        facts: {},
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "fp1",
        goal,
        answers: {
          operation: valid("TYPE_TEXT", ops, 0.91),
          TYPE_TEXT_target: valid(searchSlug, types, 0.91),
          [DRIVE_VALUE_QUESTION]: valid(zurich, values, 0.91),
        },
      }),
    ).toEqual({
      kind: "act",
      action: { kind: "type", target: "@e:q", text: "Zurich" },
      actionKey: "@e:q",
      confidence: 0.91,
    });
    expect(
      decideAfterJev({
        rows: [search, SUBMIT],
        facts: {},
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "fp1",
        goal,
        answers: {
          operation: valid("TYPE_TEXT", ops, 0.91),
          TYPE_TEXT_target: valid(searchSlug, types, 0.91),
          [DRIVE_VALUE_QUESTION]: valid(DRIVE_FIXED_NONE, values, 0.91),
        },
      }),
    ).toEqual({ kind: "needs_value", field: "search-wikipedia" });
  });

  it("offers a fillable search combobox for TYPE_TEXT and a click-only combobox for CLICK", () => {
    const search: WireRow = ["@e:q", "t", "@search-with-duck|f=search"];
    const trip: WireRow = ["@e:trip", "combobox", "@round-trip"];
    expect(typeableCandidates([search], { query: "Zurich weather" }, false).map((c) => c.ref)).toEqual([
      "@e:q",
    ]);
    expect(clickableCandidates([trip], false).map((c) => c.ref)).toEqual(["@e:trip"]);
    const questions = buildDriveQuestions([search, trip], { query: "Zurich weather" }, "Search DuckDuckGo");
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions.CLICK_target?.type).toBe("choice");
  });

  it("matches origin and destination facts from where-from / where-to labels", () => {
    const from: WireRow = ["@e:from", "t", "@where-from|f=origin"];
    const to: WireRow = ["@e:to", "t", "@where-to|f=destination"];
    const facts = { origin: "Zurich", destination: "London" };
    expect(matchingFactKeys(facts, from)).toEqual(["origin"]);
    expect(matchingFactKeys(facts, to)).toEqual(["destination"]);
    expect(typeableCandidates([from, to], facts, false).map((c) => c.ref)).toEqual(["@e:from", "@e:to"]);
  });

  it("assigns a page-supplied select option from a goal phrase without a matching fact", () => {
    const trip: WireRow = ["@e:trip", "s", "@trip-type"];
    const pageOptions = new Map<string, readonly string[]>([["@e:trip", ["Round trip", "One way", "Multi-city"]]]);
    const questions = buildDriveQuestions(
      [trip],
      {},
      "Find one-way flights from Zurich to London",
      false,
      [],
      "",
      pageOptions,
    );
    const ops = questions.operation?.type === "choice" ? questions.operation.criteria : {};
    const selects = questions.SELECT_target?.type === "choice" ? questions.SELECT_target.criteria : {};
    const tripSlug = Object.keys(selects).find((key) => selects[key] === "trip-type");
    expect(tripSlug).toBeDefined();
    if (tripSlug === undefined) return;
    expect(
      decideAfterJev({
        rows: [trip],
        facts: {},
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "fp1",
        goal: "Find one-way flights from Zurich to London",
        pageOptions,
        answers: {
          operation: valid("SELECT", ops),
          SELECT_target: valid(tripSlug, selects),
        },
      }),
    ).toEqual({
      kind: "act",
      action: { kind: "select", target: "@e:trip", text: "One way" },
      actionKey: "@e:trip",
      confidence: 0.91,
    });
  });

  it("never assigns a goal phrase into an identity field", () => {
    const email: WireRow = ["@e:email", "t", "@email|f=email|s=r"];
    const goal = "Sign up as Ada Lovelace using ada@example.test";
    const questions = buildDriveQuestions([email, SUBMIT], {}, goal);
    expect(questions[DRIVE_VALUE_QUESTION]).toBeUndefined();
    expect(Object.values(goalValueCriteria(goal, {}))).toEqual(expect.arrayContaining(["Ada", "Lovelace"]));
    expect(requiredFillableMissingFact([email, SUBMIT], {}, false)?.ref).toBe("@e:email");
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
