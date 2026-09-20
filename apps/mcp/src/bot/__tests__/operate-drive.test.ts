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
  DRIVE_MAX_CRITERIA,
  driveTargetSets,
  elementState,
  DRIVE_MAX_JEV_CALLS,
  DRIVE_RULES,
  DRIVE_VALUE_QUESTION,
  goalValueCriteria,
  DRIVE_IDENTICAL_RESNAP_MS,
  DRIVE_INJECT_CARD_HISTORY,
  DRIVE_STALE_LIMIT,
  DRIVE_EXHAUSTED_ACTION_LIMIT,
  pageProgressKey,
  recordDeadAction,
  deadActionReason,
  actionDescription,
  admitsChoice,
  isSuggestionRow,
  buildDriveQuestions,
  buildHandoff,
  buildJevState,
  clickableCandidates,
  decideAfterJev,
  driveCandidates,
  isCandidateRow,
  paymentSubmitControlMissing,
  paymentSubmitDispatched,
  checkoutPastPaymentForm,
  actionHistoryLine,
  scrollDescription,
  fillActionForCandidate,
  fillableCandidates,
  isOtpRow,
  lastActionWasClick,
  lastNonWaitWasClick,
  inboxSpecialPlan,
  pageSuggestsInboxWait,
  inboxVerificationDecision,
  snapshotNeedsSettle,
  pageHasListedWork,
  isSubmitLikeRow,
  DRIVE_EMPTY_SNAPSHOT_WAITS,
  DRIVE_TERMINAL_OPERATIONS,
  isPickerRow,
  matchingFactKeys,
  mergeCompactTable,
  operationsForRow,
  mergeFacts,
  nextActionInstructions,
  observationFingerprint,
  pageTextFromObservation,
  peakedProbabilities,
  requiredFactComboboxAction,
  requiredFactSelectAction,
  requiredFactTypeAction,
  requiredExpiryLongRewriteAction,
  isRequiredRow,
  requiredFillableMissingFact,
  applyReleasedCardFacts,
  ensureGeneratedFacts,
  isExpiryRow,
  isCardholderNameRow,
  selectTargetKey,
  selectTargets,
  selectCandidates,
  typeableCandidates,
  validateChoice,
  validateChoiceReason,
  actionFailureKey,
  filledFormIds,
  inferPagePhase,
  rankDriveCandidates,
  rememberFailedAction,
  rowFormId,
  rowOccluder,
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
    expect(DRIVE_EXHAUSTED_ACTION_LIMIT).toBe(5);
    expect(DRIVE_IDENTICAL_RESNAP_MS).toBe(200);
  });
});

describe("request building", () => {
  it("asks operation plus scoped target heads, never a flat mix of fillables and clickables", () => {
    const questions = buildDriveQuestions(
      ROWS,
      { email: "a@b.test", first_name: "Ada" },
      "sign up",
    );
    const operation = questions.operation;
    expect(operation?.type).toBe("choice");
    if (operation?.type !== "choice") return;
    expect(Object.keys(operation.criteria)).toEqual(
      expect.arrayContaining(["CLICK", "TYPE_TEXT", "DONE"]),
    );
    expect(operation.criteria).not.toHaveProperty("WAIT");
    expect(operation.criteria).not.toHaveProperty("BLOCKED");
    expect(operation.criteria).not.toHaveProperty("SELECT");
    expect(questions.goal_complete).toBeUndefined();
    expect(questions.next_action).toBeUndefined();
    expect(questions.SCROLL_target).toBeUndefined();
    expect(Object.keys(questions).sort()).toEqual([
      "CLICK_target",
      "TYPE_TEXT_target",
      "operation",
    ]);
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions.CLICK_target?.type).toBe("choice");
    if (
      questions.TYPE_TEXT_target?.type !== "choice" ||
      questions.CLICK_target?.type !== "choice"
    ) {
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
    expect(driveCandidates(mixed, false).map((c) => c.ref)).toEqual([
      "@e:email",
      "@e:name",
      "@e:go",
    ]);
    expect(driveCandidates(mixed, true).map((c) => c.ref)).toContain("@e:pan");
  });

  it("offers every offscreen checkout button, localized labels included", () => {
    const pay: WireRow = ["@e:pay", "b", "Pay now$68.00|v=offscreen"];
    const localized: WireRow = ["@e:fr", "b", "Payer maintenant|v=offscreen"];
    const back: WireRow = ["@e:back", "b", "Back to finalize order"];
    const radio: WireRow = ["@e:method", "r", "Pay now|v=offscreen"];
    const checkout = "https://whitejade.xyz/checkouts/cn/token/en-us";
    expect(isCandidateRow(pay, true, checkout)).toBe(true);
    expect(isCandidateRow(localized, true, checkout)).toBe(true);
    expect(isCandidateRow(radio, true, checkout)).toBe(false);
    expect(
      clickableCandidates([pay, localized, back, radio], true, [], checkout).map((c) => c.ref),
    ).toEqual(["@e:pay", "@e:fr", "@e:back"]);
  });

  it("drops an offscreen Buy now off a checkout page", () => {
    const buy: WireRow = ["@e:buy", "b", "Buy now|v=offscreen"];
    const product = "https://whitejade.xyz/products/jade-lamp";
    expect(isCandidateRow(buy, true, product)).toBe(false);
    expect(clickableCandidates([buy], true, [], product)).toEqual([]);
    expect(isCandidateRow(buy, true, "")).toBe(false);
    expect(clickableCandidates([buy], true)).toEqual([]);
    expect(
      clickableCandidates([buy], true, [], "https://whitejade.xyz/checkouts/cn/token").map(
        (c) => c.ref,
      ),
    ).toEqual(["@e:buy"]);
  });

  it("does not report a localized submit button as a missing pay control", () => {
    const checkout = "https://shop.example/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/fr";
    const gate = {
      includePayment: true,
      alreadyCard: true,
      cardRetry: false,
      pageUrl: checkout,
      remainingFills: 0,
      history: [],
    };
    for (const label of ["Payer maintenant", "Subscribe now", "Confirm and pay", "Pay $68.00"]) {
      expect(
        paymentSubmitControlMissing({ ...gate, rows: [["@e:submit", "b", label]] }),
      ).toBeUndefined();
    }
    expect(
      paymentSubmitControlMissing({
        ...gate,
        rows: [
          ["@e:method", "r", "Pay now"],
          ["@e:email", "t", "Email"],
        ],
      }),
    ).toMatch(/the control for this operation is not present \(CLICK pay\/place-order\)/);
  });

  it("reports a missing Pay control when the checkout shows no button at all", () => {
    const link: WireRow = ["@e:back", "l", "Back to finalize order"];
    const pay: WireRow = ["@e:pay", "b", "Pay now$68.00|v=offscreen"];
    const gate = {
      includePayment: true,
      alreadyCard: true,
      cardRetry: false,
      pageUrl: "https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/en-us",
      remainingFills: 0,
      history: [],
    };
    expect(paymentSubmitControlMissing({ ...gate, rows: [link] })).toMatch(
      /the control for this operation is not present \(CLICK pay\/place-order\)\. visible: Back to finalize order/,
    );
    expect(paymentSubmitControlMissing({ ...gate, rows: [link, pay] })).toBeUndefined();
  });

  it("keeps driving a payment stage that offers no substitute to click", () => {
    // Fields only: a picker textbox reports clickable but is a fill, so there
    // is nothing to mistake for Pay and nothing to refuse — a card-fill goal
    // on a bare checkout must still reach its own ending.
    const expiry: WireRow = ["@e:exp", "t", "Expiration date (MM / YY)|f=date"];
    const pan: WireRow = ["@e:pan", "t", "Card number|f=cc-number"];
    expect(
      paymentSubmitControlMissing({
        rows: [pan, expiry],
        includePayment: true,
        alreadyCard: true,
        cardRetry: false,
        pageUrl: "https://checkout.test/checkout",
        remainingFills: 0,
        history: [],
      }),
    ).toBeUndefined();
  });

  it("does not call a dispatched or completed payment stuck", () => {
    const processing: WireRow = ["@e:back", "l", "Back to finalize order"];
    const gate = {
      rows: [processing],
      includePayment: true,
      alreadyCard: true,
      cardRetry: false,
      pageUrl: "https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/en-us",
      remainingFills: 0,
      history: [],
    };
    expect(paymentSubmitControlMissing(gate)).toBeDefined();
    expect(
      paymentSubmitControlMissing({
        ...gate,
        history: [DRIVE_INJECT_CARD_HISTORY, 'click the button labeled "Pay now$68.00"'],
      }),
    ).toBeUndefined();
    expect(
      paymentSubmitControlMissing({
        ...gate,
        pageUrl: "https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/thank-you",
      }),
    ).toBeUndefined();
  });

  it("does not call a host-submitted payment stuck on the processor step", () => {
    const processing = "https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/processing";
    expect(checkoutPastPaymentForm(processing)).toBe(true);
    expect(
      checkoutPastPaymentForm("https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/en-us"),
    ).toBe(false);
    expect(
      paymentSubmitControlMissing({
        rows: [["@e:back", "l", "Back to finalize order"]],
        includePayment: true,
        alreadyCard: true,
        cardRetry: false,
        pageUrl: processing,
        remainingFills: 0,
        history: [],
      }),
    ).toBeUndefined();
  });

  it("ignores a pay click that predates the card release", () => {
    expect(
      paymentSubmitDispatched([
        'click the button labeled "Buy now"',
        DRIVE_INJECT_CARD_HISTORY,
        "type into the Name on card field",
      ]),
    ).toBe(false);
    expect(paymentSubmitDispatched(['click the button labeled "Buy now"'])).toBe(false);
    expect(
      paymentSubmitDispatched([
        DRIVE_INJECT_CARD_HISTORY,
        'click the button labeled "Place order"',
      ]),
    ).toBe(true);
  });

  it("does not latch a payment-method radio click as a dispatched payment", () => {
    const radio: WireRow = ["@e:method", "r", "Buy now, pay later"];
    const line = actionHistoryLine({ kind: "click", target: "@e:method" }, radio, [radio]);
    expect(line).toBe('click the radio labeled "Buy now, pay later"');
    expect(paymentSubmitDispatched([DRIVE_INJECT_CARD_HISTORY, line])).toBe(false);
  });

  it("does not treat a scroll onto Pay now as a dispatched payment", () => {
    const pay: WireRow = ["@e:pay", "b", "Pay now$68.00|v=offscreen"];
    const scrolled = actionHistoryLine({ kind: "scroll", direction: "down" }, pay, [pay]);
    const clicked = actionHistoryLine({ kind: "click", target: "@e:pay" }, pay, [pay]);
    expect(scrolled).toBe(scrollDescription(pay, [pay]));
    expect(paymentSubmitDispatched([DRIVE_INJECT_CARD_HISTORY, scrolled])).toBe(false);
    expect(paymentSubmitDispatched([DRIVE_INJECT_CARD_HISTORY, clicked])).toBe(true);
    expect(
      paymentSubmitControlMissing({
        rows: [["@e:back", "l", "Back to finalize order"]],
        includePayment: true,
        alreadyCard: true,
        cardRetry: false,
        pageUrl: "https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/en-us",
        remainingFills: 0,
        history: [DRIVE_INJECT_CARD_HISTORY, scrolled],
      }),
    ).toBeDefined();
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
    expect(Object.keys(withPage.SELECT_target.criteria).some((key) => key.includes("oregon"))).toBe(
      true,
    );
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
      pageTextFromObservation({ semantic: { title: "HN" } }, ["first story", "control", ""]),
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

describe("validate_choice", () => {
  it("rejects a choice that is not offered, not argmax, or badly normalized", () => {
    const criteria = { CLICK: "click", DONE: "done" };
    expect(validateChoice(criteria, valid("CLICK", criteria))).toBe(true);
    expect(
      validateChoice(criteria, { choice: "SCROLL", confidence: 0.9, probabilities: { CLICK: 1 } }),
    ).toBe(false);
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
    expect(
      validateChoiceReason(criteria, {
        choice: "SCROLL",
        confidence: 0.9,
        probabilities: { CLICK: 1 },
      }),
    ).toBe("choice_not_offered");
    expect(
      admitsChoice(criteria, { choice: "SCROLL", confidence: 0.9, probabilities: { CLICK: 1 } }),
    ).toEqual({ kind: "invalid_answer", reason: "choice_not_offered", confidence: 0.9 });
    expect(
      admitsChoice(
        criteria,
        {
          choice: "CLICK",
          confidence: 0.26,
          probabilities: peakedProbabilities(Object.keys(criteria), "CLICK", 0.91),
        },
        { reversible: true },
      ),
    ).toEqual({ ok: true });
    expect(
      admitsChoice(
        criteria,
        {
          choice: "DONE",
          confidence: 0.2,
          probabilities: peakedProbabilities(Object.keys(criteria), "DONE", 0.91),
        },
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
    const nav: WireRow[] = [
      ["@e:home", "l", "Home"],
      ["@e:models", "l", "Models"],
    ];
    const navQuestions = buildDriveQuestions(nav, {}, "sign up");
    const navOps = navQuestions.operation?.type === "choice" ? navQuestions.operation.criteria : {};
    expect(navOps).toHaveProperty("BLOCKED");
    expect(
      decideAfterJev({
        ...base,
        rows: nav,
        facts: {},
        answers: { operation: valid("BLOCKED", navOps, 0.7) },
      }),
    ).toEqual({ kind: "stuck", confidence: 0.7 });
  });

  it("returns wait when Jev picks WAIT", () => {
    const nav: WireRow[] = [
      ["@e:home", "l", "Home"],
      ["@e:models", "l", "Models"],
    ];
    const navQuestions = buildDriveQuestions(nav, {}, "sign up");
    const navOps = navQuestions.operation?.type === "choice" ? navQuestions.operation.criteria : {};
    expect(navOps).toHaveProperty("WAIT");
    expect(
      decideAfterJev({
        ...base,
        rows: nav,
        facts: {},
        answers: { operation: valid("WAIT", navOps, 0.8) },
      }),
    ).toEqual({ kind: "wait", confidence: 0.8 });
  });

  it("returns needs_value naming the field label when a required fillable has no matching fact", () => {
    const missingFacts = { first_name: "Ada" };
    expect(requiredFillableMissingFact(ROWS, missingFacts)?.ref).toBe("@e:email");
  });

  it("defers a card expiry control only while a card is in play", () => {
    const expiry: WireRow = ["@e:exp", "t", "Expiration date (MM / YY)|s=r"];
    expect(isExpiryRow(expiry)).toBe(true);
    // With a card, the control is the card path's business and is filled after
    // release, so reporting it missing would halt the purchase early.
    expect(
      requiredFillableMissingFact([expiry, PAYMENT, EMAIL], {
        email: "a@b.test",
        card_ref: "card-1",
      })?.ref,
    ).toBeUndefined();
    // Without a card there is no release to wait for. A trial signup that asks
    // for one must still be told which field it needs.
    expect(requiredFillableMissingFact([expiry, PAYMENT], {})?.ref).toBe("@e:exp");
  });

  it("defers a name-on-card control only while a card is in play", () => {
    const cardName: WireRow = ["@e:ncard", "t", "Name on card|s=r"];
    expect(isCardholderNameRow(cardName)).toBe(true);
    expect(
      requiredFillableMissingFact([cardName, EMAIL], { email: "a@b.test", card_ref: "card-1" })
        ?.ref,
    ).toBeUndefined();
    // "Name on card" matches no ordinary alias, so a no-card drive can only
    // fill it if the host is told the field's name and resumes with a fact.
    expect(requiredFillableMissingFact([cardName], {})?.ref).toBe("@e:ncard");
    expect(requiredFillableMissingFact([cardName], { name_on_card: "Ada" })?.ref).toBeUndefined();
  });

  it("fills a cardholder-name control from the shipping name when the drive has no card", () => {
    const cardholder: WireRow = ["@e:ch", "t", "Cardholder name|s=r"];
    const rows = [cardholder, EMAIL];
    const facts = ensureGeneratedFacts(rows, {
      first_name: "Ada",
      last_name: "Lovelace",
      email: "a@b.test",
    });
    expect(isCardholderNameRow(cardholder)).toBe(true);
    expect(facts.name).toBe("Ada Lovelace");
    // A provisioning drive that meets an inline cardholder control resolves it
    // through the ordinary name alias and carries on.
    expect(matchingFactKeys(facts, cardholder)).toEqual(["name"]);
    expect(fillableCandidates(rows, facts, false).map((row) => row.ref)).toContain("@e:ch");
    expect(requiredFillableMissingFact(rows, facts)?.ref).toBeUndefined();
  });

  it("still gives a cardholder-name control the released card name on a payment drive", () => {
    const cardholder: WireRow = ["@e:ch", "t", "Cardholder name|s=r"];
    const rows = [cardholder, PAYMENT];
    const shipping = ensureGeneratedFacts(rows, {
      first_name: "Ada",
      last_name: "Lovelace",
      card_ref: "card-1",
    });
    const released = applyReleasedCardFacts(shipping, {
      exp_month: "12",
      exp_year: "2030",
      name: "A L Byron",
    });
    expect(matchingFactKeys(released, cardholder)).toEqual(["card_name"]);
    expect(released.card_name).toBe("A L Byron");
  });

  it("does not offer name-on-card as fillable until the card is released", () => {
    const cardName: WireRow = ["@e:ncard", "t", "Name on card|s=r"];
    const facts = { email: "a@b.test", card_ref: "card-1" };
    expect(fillableCandidates([cardName, EMAIL], facts, true).map((row) => row.ref)).toEqual([
      "@e:email",
    ]);
    const released = applyReleasedCardFacts(facts, {
      exp_month: "12",
      exp_year: "2030",
      name: "A L Byron",
    });
    expect(fillableCandidates([cardName, EMAIL], released, true).map((row) => row.ref)).toEqual([
      "@e:ncard",
      "@e:email",
    ]);
  });

  it("types the released cardholder name into name-on-card, never the shipping name", () => {
    const cardName: WireRow = ["@e:ncard", "t", "Name on card|s=r"];
    const fullName: WireRow = ["@e:full", "t", "Full name|s=r"];
    // ensureGeneratedFacts has already synthesized the shipping name by the
    // time the card is released, many steps into the drive.
    const shipping = ensureGeneratedFacts([fullName], {
      first_name: "Ada",
      last_name: "Lovelace",
      card_ref: "card-1",
    });
    expect(shipping.name).toBe("Ada Lovelace");
    const facts = applyReleasedCardFacts(shipping, {
      exp_month: "12",
      exp_year: "2030",
      name: "A L Byron",
    });
    expect(matchingFactKeys(facts, cardName)).toEqual(["card_name"]);
    expect(facts.card_name).toBe("A L Byron");
    expect(matchingFactKeys(facts, fullName)).toEqual(["name"]);
    expect(facts.name).toBe("Ada Lovelace");
  });

  it("counts a fact-backed select as an outstanding fill but an unmatched search box as none", () => {
    const filledEmail: WireRow = ["@e:email", "t", "Email|f=email|s=r|n=a@b.test"];
    const search: WireRow = ["@e:q", "t", "Search|f=search"];
    const facts = { email: "a@b.test", state: "NY", card_ref: "card-1" };
    const rows = [filledEmail, STATE, search, PAYMENT];
    // This is the set the inject_card gate waits on. The required State
    // dropdown is in it, so the card is not released before it is resolved.
    const fills = fillableCandidates(rows, facts, true, ["@e:email"]);
    expect(fills.map((candidate) => candidate.ref)).toEqual(["@e:state"]);
    // The search row has no fact and never will, so it is absent — gating on
    // a set that re-admits it (typeableCandidates does) would deadlock the
    // release, because such a row only leaves once something types into it.
    expect(typeableCandidates(rows, facts, true, ["@e:email"]).map((row) => row.ref)).toEqual([
      "@e:q",
    ]);
    const resolved = fillableCandidates(rows, facts, true, ["@e:email", "@e:state"]);
    expect(resolved).toEqual([]);
  });

  it("does not treat a Shopify geo-default state as already filled", () => {
    const country: WireRow = ["@e:country", "s", "Country/Region|f=state|s=r|a=picker|n=US"];
    const florida: WireRow = ["@e:state", "s", "State|f=state|s=r|a=picker|n=FL"];
    const facts = { state: "NY", country: "US", zip: "10001" };
    expect(matchingFactKeys(facts, country)).toEqual(["country"]);
    expect(matchingFactKeys(facts, florida)).toEqual(["state"]);
    expect(fillableCandidates([country, florida], facts, false).map((row) => row.ref)).toEqual([
      "@e:state",
    ]);
    expect(requiredFactSelectAction([country, florida], facts)).toEqual({
      target: "@e:state",
      text: "NY",
    });
  });

  it("drops a state select once its current value matches the fact", () => {
    const newYork: WireRow = ["@e:state", "s", "State|f=state|s=r|a=picker|n=NY"];
    const facts = { state: "NY", country: "US" };
    expect(fillableCandidates([newYork], facts, false)).toEqual([]);
    expect(requiredFactSelectAction([newYork], facts)).toBeUndefined();
  });

  it("does not treat an offscreen checkout phone as already filled", () => {
    const phone: WireRow = ["@e:phone", "t", "Phone (optional)|f=phone|v=offscreen"];
    const checkout = "https://whitejade.xyz/checkouts/cn/hWNH2exU82n2ocbEQWhd9HjG/en-us";
    const facts = { phone: "2125550100", card_ref: "card-1" };
    expect(driveCandidates([phone], true).map((row) => row.ref)).toEqual([]);
    expect(isRequiredRow(phone)).toBe(false);
    expect(fillableCandidates([phone], facts, true, [], checkout).map((row) => row.ref)).toEqual([
      "@e:phone",
    ]);
    expect(requiredFactTypeAction([phone], facts, [], checkout)).toEqual({
      target: "@e:phone",
      text: "2125550100",
    });
  });

  it("holds the card for an optional offscreen phone until the fact is typed", () => {
    const email: WireRow = ["@e:email", "t", "Email|f=email|s=r|n=a@b.test"];
    const state: WireRow = ["@e:state", "s", "State|f=state|s=r|a=picker|n=NY"];
    const phone: WireRow = ["@e:phone", "t", "Phone (optional)|f=phone|v=offscreen"];
    const rows = [email, state, phone];
    const facts = { email: "a@b.test", state: "NY", phone: "2125550100", card_ref: "card-1" };
    const checkout = "https://shop.example/checkout";
    // The gate waits on this set. Releasing the card while a delivery field is
    // still pending means the address is edited afterwards, which re-costs the
    // order and remounts the card frames.
    expect(fillableCandidates(rows, facts, true, [], checkout).map((row) => row.ref)).toEqual([
      "@e:phone",
    ]);
    expect(requiredFactTypeAction(rows, facts, [], checkout)).toEqual({
      target: "@e:phone",
      text: "2125550100",
    });
    // Once typed the row leaves the set and the card may be released.
    expect(fillableCandidates(rows, facts, true, ["@e:phone"], checkout)).toEqual([]);
  });

  it("leaves a country picker on its geo default alone when no country fact exists", () => {
    const country: WireRow = ["@e:country", "s", "Country/Region|f=state|s=r|a=picker|n=US"];
    const facts = { state: "NY", zip: "10001", card_ref: "card-1" };
    // Shopify serializes Country/Region as f=state; the picker must not take
    // the state fact, and it is not a missing value either — the merchant's
    // default is already correct, so the drive keeps moving.
    expect(matchingFactKeys(facts, country)).toEqual([]);
    expect(requiredFillableMissingFact([country], facts)?.ref).toBeUndefined();
    expect(requiredFactSelectAction([country], facts)).toBeUndefined();
  });

  it("still reports a required empty control with no matching fact", () => {
    const empty: WireRow = ["@e:country", "s", "Country/Region|f=state|s=r|a=picker"];
    const facts = { state: "NY", card_ref: "card-1" };
    expect(requiredFillableMissingFact([empty], facts)?.ref).toBe("@e:country");
  });

  it("reports a required dropdown sitting on a placeholder sentinel", () => {
    // `<select required><option value="0">Choose a delivery window</option>…`
    // serializes as a non-empty current value, but nothing is chosen. It is
    // not a fill either (no fact matches), so the model is never offered it —
    // needs_value is the only thing that keeps the card gate shut until the
    // host answers.
    const window: WireRow = ["@e:win", "s", "Delivery window|s=r|n=0"];
    const facts = { state: "NY", card_ref: "card-1" };
    expect(matchingFactKeys(facts, window)).toEqual([]);
    expect(fillableCandidates([window], facts, true)).toEqual([]);
    expect(requiredFillableMissingFact([window], facts)?.ref).toBe("@e:win");
  });

  it("gives a country picker the country fact when one is supplied", () => {
    const country: WireRow = ["@e:country", "s", "Country/Region|f=state|s=r|a=picker|n=US"];
    const facts = { state: "NY", country: "Canada" };
    expect(matchingFactKeys(facts, country)).toEqual(["country"]);
    expect(requiredFactSelectAction([country], facts)).toEqual({
      target: "@e:country",
      text: "Canada",
    });
  });

  it("reads an unusually worded card expiry, but not another document's", () => {
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    // "Expires end" is the UK-common card wording.
    const expiresEnd: WireRow = ["@e:exp", "t", "Expires end|f=date|s=r"];
    expect(isExpiryRow(expiresEnd)).toBe(true);
    expect(matchingFactKeys(facts, expiresEnd)).toEqual(["card_expiry"]);
    for (const label of ["Driver's license expiration", "Passport expiry", "Permit expires"]) {
      const other: WireRow = ["@e:other", "t", `${label}|f=date|s=r`];
      expect(isExpiryRow(other)).toBe(false);
      expect(matchingFactKeys(facts, other)).toEqual([]);
    }
  });

  it("drops a typed field once its current value matches the fact", () => {
    const phone: WireRow = ["@e:phone", "t", "Phone (optional)|f=phone|n=2125550100"];
    const facts = { phone: "2125550100" };
    expect(fillableCandidates([phone], facts, false)).toEqual([]);
    expect(requiredFactTypeAction([phone], facts)).toBeUndefined();
  });

  it("never writes the state fact into a country picker that has no country fact", () => {
    const country: WireRow = ["@e:country", "s", "Country/Region|f=state|s=r|a=picker|n=US"];
    const florida: WireRow = ["@e:state", "s", "State|f=state|s=r|a=picker|n=FL"];
    // Shopify serializes Country/Region as f=state, so without the guard the
    // state alias family hands the picker "NY".
    const facts = { state: "NY", zip: "10001" };
    expect(matchingFactKeys(facts, country)).toEqual([]);
    expect(requiredFactSelectAction([country, florida], facts)).toEqual({
      target: "@e:state",
      text: "NY",
    });
  });

  it("applies each outstanding fact-backed select in turn as the page updates", () => {
    const country: WireRow = ["@e:country", "s", "Country/Region|f=state|s=r|a=picker|n=US"];
    const florida: WireRow = ["@e:state", "s", "State|f=state|s=r|a=picker|n=FL"];
    const facts = { state: "NY", country: "CA", zip: "10001" };
    // The country picker is resolved from the country fact, the state picker
    // from the state fact — neither borrows the other's value.
    expect(requiredFactSelectAction([country, florida], facts)).toEqual({
      target: "@e:country",
      text: "CA",
    });
    expect(requiredFactSelectAction([country, florida], facts, ["@e:country"])).toEqual({
      target: "@e:state",
      text: "NY",
    });
    const settled: WireRow[] = [
      ["@e:country", "s", "Country/Region|f=state|s=r|a=picker|n=CA"],
      ["@e:state", "s", "State|f=state|s=r|a=picker|n=NY"],
    ];
    expect(requiredFactSelectAction(settled, facts)).toBeUndefined();
  });

  it("copies released card public fields so expiry can be typed after inject", () => {
    expect(
      applyReleasedCardFacts(
        { email: "a@b.test" },
        { exp_month: "12", exp_year: "2030", name: "Ada" },
      ),
    ).toEqual({
      email: "a@b.test",
      exp_month: "12",
      exp_year: "2030",
      exp_year_short: "30",
      card_name: "Ada",
      card_expiry: "12/30",
      card_expiry_long: "12/2030",
    });
  });

  it("rebuilds every card-derived fact from the card actually in play", () => {
    const declined = applyReleasedCardFacts(
      { email: "a@b.test", card_ref: "card-A" },
      { exp_month: "12", exp_year: "2030", name: "A L Byron" },
    );
    expect(declined.card_expiry).toBe("12/30");
    // The host retries with a second card; drive.facts survives the retry, so
    // the first card's values must not be typed beside the second card's PAN.
    const retried = applyReleasedCardFacts(declined, {
      exp_month: "3",
      exp_year: "2027",
      name: "Ada Lovelace",
    });
    expect(retried.card_expiry).toBe("03/27");
    expect(retried.card_expiry_long).toBe("03/2027");
    expect(retried.exp_month).toBe("3");
    expect(retried.exp_year).toBe("2027");
    expect(retried.exp_year_short).toBe("27");
    expect(retried.card_name).toBe("Ada Lovelace");
    expect(retried.email).toBe("a@b.test");
  });

  it("clears a card-derived fact the newly released card cannot supply", () => {
    const first = applyReleasedCardFacts(
      { card_ref: "card-A" },
      { exp_month: "12", exp_year: "2030", name: "A L Byron" },
    );
    expect(first.card_name).toBe("A L Byron");
    const blankName = applyReleasedCardFacts(first, {
      exp_month: "12",
      exp_year: "2030",
      name: "   ",
    });
    expect(blankName.card_name).toBeUndefined();
  });

  it("sizes a combined expiry write from the control's stated format, not its width", () => {
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    const valueFor = (row: WireRow): string | undefined => facts[matchingFactKeys(facts, row)[0]!];
    // Placeholder, pattern, or label that names MM/YYYY vs MM/YY is the signal.
    expect(valueFor(["@e:l", "t", "Expiration date|f=date|ph=MM/YYYY|w=7"])).toBe("12/2030");
    expect(valueFor(["@e:p", "t", "Expiration date|f=date|pt=\\d{2}/\\d{4}"])).toBe("12/2030");
    expect(valueFor(["@e:s", "t", "Expiration date (MM / YY)|f=date|w=9"])).toBe("12/30");
    expect(valueFor(["@e:u", "t", "Expiration date (MM / YY)|f=date"])).toBe("12/30");
    // A label that names four digits wins even on a short maxlength.
    expect(valueFor(["@e:x", "t", "Expiration date (MM/YYYY)|f=date|w=5"])).toBe("12/2030");
  });

  it("writes the two-digit expiry when the control states no year length", () => {
    // maxlength 7 fits both "MM/YYYY" and "MM / YY". Mapping the width to a
    // format is what sent "12/2030" into a two-digit mask, which reformatted
    // it to "12 / 20" and submitted an expiry that is already past.
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    const valueFor = (row: WireRow): string | undefined => facts[matchingFactKeys(facts, row)[0]!];
    expect(valueFor(["@e:m", "t", "Expiration date (MM / YY)|f=date|w=7"])).toBe("12/30");
    expect(valueFor(["@e:m2", "t", "Expiration date|f=date|w=7"])).toBe("12/30");
    expect(valueFor(["@e:m3", "t", "Expiration date|f=date|w=8"])).toBe("12/30");
    expect(valueFor(["@e:m9", "t", "Expiration date|f=date|w=9"])).toBe("12/30");
  });

  it("rewrites a rejected or truncated two-digit expiry with the four-digit year", () => {
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    const emptyAfter: WireRow = ["@e:exp", "t", "Expiration date|f=date|s=r"];
    expect(requiredExpiryLongRewriteAction([emptyAfter], facts, ["@e:exp"])).toEqual({
      target: "@e:exp",
      text: "12/2030",
    });
    const truncated: WireRow = ["@e:exp", "t", "Expiration date|f=date|s=r|n=12/2"];
    expect(requiredExpiryLongRewriteAction([truncated], facts, ["@e:exp"])).toEqual({
      target: "@e:exp",
      text: "12/2030",
    });
    const invalid: WireRow = ["@e:exp", "t", "Expiration date|f=date|s=ri|n=12/30"];
    expect(requiredExpiryLongRewriteAction([invalid], facts, ["@e:exp"])).toEqual({
      target: "@e:exp",
      text: "12/2030",
    });
    const accepted: WireRow = ["@e:exp", "t", "Expiration date (MM / YY)|f=date|s=r|n=12/30"];
    expect(requiredExpiryLongRewriteAction([accepted], facts, ["@e:exp"])).toBeUndefined();
    expect(requiredExpiryLongRewriteAction([emptyAfter], facts, [])).toBeUndefined();
  });

  it("keeps a caller-supplied card fact rather than discarding it silently", () => {
    const supplied = {
      card_ref: "card-1",
      exp_month: "01",
      exp_year: "1999",
      exp_year_short: "99",
      card_name: "Ada",
      card_expiry: "01/99",
      card_expiry_long: "01/1999",
    };
    expect(mergeFacts({ email: "a@b.test" }, supplied)).toEqual({
      email: "a@b.test",
      ...supplied,
    });
  });

  it("lets the released card overwrite whatever the caller supplied", () => {
    const facts = mergeFacts(
      { email: "a@b.test" },
      { card_ref: "card-1", exp_month: "01", exp_year: "1999", card_name: "Stale" },
    );
    const released = applyReleasedCardFacts(facts, {
      exp_month: "12",
      exp_year: "2030",
      name: "Ada Lovelace",
    });
    // The release rebuilds the whole card-derived set, so a caller value can
    // never be the thing typed beside the released card's PAN.
    expect(released.exp_month).toBe("12");
    expect(released.exp_year).toBe("2030");
    expect(released.card_name).toBe("Ada Lovelace");
    expect(released.card_expiry).toBe("12/30");
    expect(released.card_expiry_long).toBe("12/2030");
    expect(released.email).toBe("a@b.test");
  });

  it("widens a vaulted two-digit year for the controls that ask for four", () => {
    // card-release-approval accepts YY or YYYY and stores it verbatim, so a
    // card saved as "30" is a released state the drive really sees.
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "30", name: "Ada" },
    );
    expect(facts.exp_year).toBe("2030");
    expect(facts.exp_year_short).toBe("30");
    expect(facts.card_expiry).toBe("12/30");
    expect(facts.card_expiry_long).toBe("12/2030");
    const valueFor = (row: WireRow): string | undefined => facts[matchingFactKeys(facts, row)[0]!];
    expect(valueFor(["@e:y", "t", "Expiration year|f=date|w=4"])).toBe("2030");
    expect(valueFor(["@e:y2", "t", "Expiration year|f=date|w=2"])).toBe("30");
    expect(valueFor(["@e:c", "t", "Expiration date|f=date|w=9"])).toBe("12/30");
  });

  it("writes the two-digit combined expiry when the control states no year length", () => {
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    const valueFor = (row: WireRow): string | undefined => facts[matchingFactKeys(facts, row)[0]!];
    expect(valueFor(["@e:c", "t", "Expiration date (MM / YY)|f=date"])).toBe("12/30");
    expect(valueFor(["@e:c5", "t", "Expiration date|f=date|w=5"])).toBe("12/30");
    expect(valueFor(["@e:c8", "t", "Expiration date|f=date|w=8"])).toBe("12/30");
  });

  it("sizes the year write from the control's declared width, not its label", () => {
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    const valueFor = (row: WireRow): string | undefined => facts[matchingFactKeys(facts, row)[0]!];
    // A maxlength=2 input silently keeps "20" out of "2030" and the card is
    // declined with nothing to read anywhere in the drive.
    expect(valueFor(["@e:y2", "t", "Expiration year|f=date|w=2"])).toBe("30");
    expect(valueFor(["@e:y4", "t", "Expiration year|f=date|w=4"])).toBe("2030");
    // How the merchant spelled the label decides nothing: the same wording
    // resolves either way once the control declares its own width.
    expect(valueFor(["@e:yy", "t", "Expiration year (YY)|f=date|w=4"])).toBe("2030");
    expect(valueFor(["@e:yyyy", "t", "Expiration year (YYYY)|f=date|w=2"])).toBe("30");
    // No declared width is no signal, so the card's own spelling is written.
    expect(valueFor(["@e:y", "t", "Expiration year|f=date"])).toBe("2030");
  });

  it("leaves a non-card expiry on a card page to the ordinary aliases", () => {
    const pan: WireRow = ["@e:pan", "t", "Card number|f=payment"];
    const licence: WireRow = ["@e:dl", "t", "Driver's license expiration|f=date|s=r"];
    const passport: WireRow = ["@e:pp", "t", "Passport expiry|f=date|s=r"];
    const cardExpiry: WireRow = ["@e:exp", "t", "Expiration date (MM / YY)|f=date|s=r"];
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    // A sibling PAN row does not make every expiry on the page a card expiry.
    expect(isExpiryRow(licence)).toBe(false);
    expect(isExpiryRow(passport)).toBe(false);
    expect(isExpiryRow(cardExpiry)).toBe(true);
    expect(matchingFactKeys(facts, licence)).toEqual([]);
    expect(matchingFactKeys(facts, passport)).toEqual([]);
    expect(matchingFactKeys(facts, cardExpiry)).toEqual(["card_expiry"]);
    // Only the card control is offered the card value, and the licence field
    // is still surfaced as a missing required fact rather than silently filled.
    expect(
      fillableCandidates([pan, licence, passport, cardExpiry], facts, true).map((row) => row.ref),
    ).toEqual(["@e:exp"]);
    expect(requiredFillableMissingFact([pan, licence, cardExpiry], facts)?.ref).toBe("@e:dl");
  });

  it("keeps released card values out of the goal-value criteria", () => {
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1", merchant: "fixture.test" },
      { exp_month: "12", exp_year: "2030", name: "A L Byron" },
    );
    const criteria = goalValueCriteria("Buy one item", facts);
    // A site-search or promo row must never be offered the card expiry or the
    // cardholder name as a phrase to type.
    expect(Object.values(criteria)).not.toContain("12/30");
    expect(Object.values(criteria)).not.toContain("A L Byron");
    expect(Object.values(criteria)).not.toContain("2030");
    expect(Object.keys(criteria)).not.toContain("card_expiry");
    expect(Object.keys(criteria)).not.toContain("card_name");
    expect(Object.keys(criteria)).not.toContain("exp_month");
    expect(Object.keys(criteria)).not.toContain("exp_year");
    expect(Object.keys(criteria)).not.toContain("exp_year_short");
    // Ordinary facts still reach it.
    expect(Object.values(criteria)).toContain("fixture.test");
  });

  it("reads a plain Expiration date / Expiry date label as the card expiry", () => {
    // Braintree, Adyen, BigCommerce and Squarespace all label it this way.
    for (const label of ["Expiration date", "Expiry date", "Expiration date (MM / YY)"]) {
      const expiry: WireRow = ["@e:exp", "t", `${label}|f=date|s=r`];
      const facts = applyReleasedCardFacts(
        { card_ref: "card-1" },
        { exp_month: "12", exp_year: "2030", name: "Ada" },
      );
      expect(isExpiryRow(expiry)).toBe(true);
      expect(matchingFactKeys(facts, expiry)).toEqual(["card_expiry"]);
      expect(
        fillableCandidates([expiry, PAYMENT], facts, true).map((candidate) => candidate.ref),
      ).toEqual(["@e:exp"]);
    }
  });

  it("leaves a passport expiry with no card on the page as an ordinary fillable", () => {
    const passport: WireRow = ["@e:pp", "t", "Passport expiry|f=date|s=r"];
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    expect(isExpiryRow(passport)).toBe(false);
    expect(matchingFactKeys(facts, passport)).toEqual([]);
    // Not a deferred payment control, so it stays a reportable required field.
    expect(requiredFillableMissingFact([passport], { card_ref: "card-1" })?.ref).toBe("@e:pp");
  });

  it("gives the card expiry control the card value even when a travel date fact exists", () => {
    const cardExpiry: WireRow = ["@e:exp", "t", "Expiration date (MM / YY)|f=date|s=r"];
    const departure: WireRow = ["@e:dep", "t", "Departure date|f=date"];
    const facts = applyReleasedCardFacts(
      { date: "2026-12-01", card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    expect(Object.keys(facts).indexOf("date")).toBeLessThan(
      Object.keys(facts).indexOf("card_expiry"),
    );
    expect(matchingFactKeys(facts, cardExpiry)).toEqual(["card_expiry"]);
    expect(matchingFactKeys(facts, departure)).toEqual(["date"]);
  });

  it("sends split month and year controls their own released card fields", () => {
    const month: WireRow = ["@e:m", "t", "Expiration month|f=date"];
    const year: WireRow = ["@e:y", "t", "Expiration year|f=date"];
    const facts = applyReleasedCardFacts(
      { card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    expect(matchingFactKeys(facts, month)).toEqual(["exp_month"]);
    expect(matchingFactKeys(facts, year)).toEqual(["exp_year"]);
  });

  it("offers the released expiry only to the card expiry control, never to a delivery date", () => {
    const expiry: WireRow = ["@e:exp", "t", "Expiration date (MM / YY)|s=r"];
    const deliveryDate: WireRow = ["@e:when", "t", "Delivery date"];
    const rows = [expiry, deliveryDate, PAYMENT];
    const facts = applyReleasedCardFacts(
      { email: "a@b.test", card_ref: "card-1" },
      { exp_month: "12", exp_year: "2030", name: "Ada" },
    );
    expect(matchingFactKeys(facts, expiry)).toEqual(["card_expiry"]);
    expect(matchingFactKeys(facts, deliveryDate)).toEqual([]);
    expect(fillableCandidates(rows, facts, true).map((candidate) => candidate.ref)).toEqual([
      "@e:exp",
    ]);
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
    const fourOpKeys = ["CLICK", "TYPE_TEXT", "WAIT", "DONE"];
    const fourOpQuestions = {
      ...questions,
      operation: {
        type: "choice" as const,
        instructions: nextActionInstructions("sign up"),
        criteria: {
          CLICK: "click a visible control",
          TYPE_TEXT: "type a provided fact into a field",
          WAIT: "wait only when the needed control is absent or disabled, or submitted results are still loading",
          DONE: "the goal is already complete on visible evidence; stop",
        },
      },
    };
    expect(
      decideAfterJev({
        ...base,
        questions: fourOpQuestions,
        answers: {
          operation: {
            choice: "CLICK",
            confidence: 0.26,
            probabilities: peakedProbabilities(fourOpKeys, "CLICK", 0.26),
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
    const ops =
      paymentQuestions.operation?.type === "choice" ? paymentQuestions.operation.criteria : {};
    const clicks =
      paymentQuestions.CLICK_target?.type === "choice"
        ? paymentQuestions.CLICK_target.criteria
        : {};
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
            confidence: 0.55,
            probabilities: peakedProbabilities(Object.keys(ops), "CLICK", 0.55),
          },
          CLICK_target: {
            choice: paySlug,
            confidence: 0.55,
            probabilities: peakedProbabilities(Object.keys(clicks), paySlug, 0.55),
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
    const otpOp = otpQuestions.operation?.type === "choice" ? otpQuestions.operation.criteria : {};
    const otpTargets =
      otpQuestions.TYPE_TEXT_target?.type === "choice"
        ? otpQuestions.TYPE_TEXT_target.criteria
        : {};
    const otpSlug = Object.keys(otpTargets).find((key) =>
      otpTargets[key]?.includes("verification"),
    );
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
    const operation =
      questionsWithState.operation?.type === "choice" ? questionsWithState.operation.criteria : {};
    const selectCriteria =
      questionsWithState.SELECT_target?.type === "choice"
        ? questionsWithState.SELECT_target.criteria
        : {};
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
    expect(fillActionForCandidate(address, { address: "1 Market St" }, "address", 1)).toMatchObject(
      {
        action: { kind: "select", target: "@e:addr", text: "1 Market St" },
      },
    );
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
    const missing = requiredFillableMissingFact(ROWS, { first_name: "Ada" });
    expect(missing?.ref).toBe("@e:email");
    expect(missing ? missing.row : undefined).toBe(EMAIL);
  });

  it("treats a click as the last action for the email-check fallback", () => {
    expect(
      lastActionWasClick([
        { action: "click", target: "@e:go", confidence: 0.9, url: "https://x.test" },
      ]),
    ).toBe(true);
    expect(
      lastActionWasClick([
        { action: "type", target: "@e:email", confidence: 0.9, url: "https://x.test" },
      ]),
    ).toBe(false);
  });

  it("treats waits after a click as still post-submit", () => {
    expect(
      lastNonWaitWasClick([
        { action: "click", target: "@e:go", confidence: 0.9, url: "https://x.test" },
        { action: "wait", target: "WAIT", confidence: 1, url: "https://x.test" },
      ]),
    ).toBe(true);
    expect(
      lastNonWaitWasClick([
        { action: "type", target: "@e:email", confidence: 0.9, url: "https://x.test" },
        { action: "wait", target: "WAIT", confidence: 1, url: "https://x.test" },
      ]),
    ).toBe(false);
  });

  it("settles an empty snapshot or a fully disabled form surface", () => {
    expect(DRIVE_EMPTY_SNAPSHOT_WAITS).toBe(3);
    expect(DRIVE_TERMINAL_OPERATIONS).toEqual(["DONE", "BLOCKED"]);
    expect(snapshotNeedsSettle([])).toBe(true);
    expect(snapshotNeedsSettle(ROWS)).toBe(false);
    const disabledForm: WireRow[] = [
      ["@e:email", "t", "Email|f=email|s=d"],
      ["@e:go", "b", "Register|s=d"],
      ["@e:g", "b", "Register with Google"],
      ["@e:terms", "l", "Terms of Service"],
    ];
    expect(snapshotNeedsSettle(disabledForm)).toBe(true);
    expect(
      snapshotNeedsSettle([
        ["@e:home", "l", "Home"],
        ["@e:login", "b", "Go to login"],
      ]),
    ).toBe(false);
    expect(
      snapshotNeedsSettle([
        ["@e:role", "combobox", "Founder/CTO|a=picker|n=Founder/CTO"],
        ["@e:cb", "c", "checkbox|s=u"],
        ["@e:next", "b", "Next|s=d"],
      ]),
    ).toBe(false);
    const inFlight: WireRow[] = [
      ["@e:email", "t", "Email|f=email|n=a@b.test"],
      ["@e:go", "b", "Creating your account|s=d"],
    ];
    expect(snapshotNeedsSettle(inFlight, 0)).toBe(true);
    expect(snapshotNeedsSettle(inFlight, 1)).toBe(false);
    expect(snapshotNeedsSettle(inFlight)).toBe(false);
    const fireworksInFlight: WireRow[] = [
      ["@e:email", "t", "Email|f=email|s=d|n=a@b.test"],
      ["@e:pw", "t", "Password|f=password"],
      ["@e:slide", "b", "Next slide"],
      ["@e:go", "b", "Create Account|s=d"],
    ];
    expect(isSubmitLikeRow(fireworksInFlight[2]!)).toBe(false);
    expect(snapshotNeedsSettle(fireworksInFlight, 0)).toBe(true);
    expect(pageHasListedWork(fireworksInFlight, 0, 0)).toBe(false);
  });

  it("omits BLOCKED while a listed fill or enabled submit remains", () => {
    expect(pageHasListedWork(ROWS, 1, 0)).toBe(true);
    expect(pageHasListedWork([["@e:go", "b", "Get started now"]], 0, 0)).toBe(true);
    expect(
      pageHasListedWork(
        [
          ["@e:home", "l", "Home"],
          ["@e:models", "l", "Models"],
        ],
        0,
        0,
      ),
    ).toBe(false);
    const welcome: WireRow[] = [
      ["@e:logo", "l", "Meilisearch logo Meilisearch|f=search"],
      ["@e:role", "combobox", "Founder/CTO|a=picker|n=Founder/CTO"],
      ["@e:reasons", "b", "Select reasons for using Meilisearch"],
      ["@e:cb", "c", "checkbox|s=u"],
      ["@e:next", "b", "Next|s=d"],
    ];
    expect(pageHasListedWork(welcome, 0, 0)).toBe(true);
    const welcomeSets = driveTargetSets(welcome, {}, false);
    expect(welcomeSets.operations).toContain("CLICK");
    expect(welcomeSets.operations).not.toContain("WAIT");
    expect(welcomeSets.operations).not.toContain("BLOCKED");
    expect(welcomeSets.CLICK.map((c) => c.ref)).not.toContain("@e:logo");
    expect(welcomeSets.CLICK.map((c) => c.ref)).not.toContain("@e:next");
    expect(welcomeSets.CLICK.map((c) => c.ref)).toContain("@e:cb");
    const checkedWelcome = welcome.map((row) =>
      row[0] === "@e:cb" ? (["@e:cb", "c", "checkbox|s=c"] as WireRow) : row,
    );
    expect(driveTargetSets(checkedWelcome, {}, false).CLICK.map((c) => c.ref)).not.toContain(
      "@e:cb",
    );
    const openReasons: WireRow[] = [
      ["@e:reasons", "t", "Select reasons...|a=picker"],
      ["@e:kw", "l", "Keyword Search|f=search|q=1/8"],
      ["@e:other", "l", "Other|q=8/8"],
    ];
    const openClicks = driveTargetSets(openReasons, {}, false).CLICK.map((c) => c.ref);
    expect(openClicks).not.toContain("@e:reasons");
    expect(openClicks).toEqual(expect.arrayContaining(["@e:kw", "@e:other"]));
    const signup = driveTargetSets(ROWS, { email: "a@b.test" }, false);
    expect(signup.operations).toContain("TYPE_TEXT");
    expect(signup.operations).not.toContain("WAIT");
    expect(signup.operations).not.toContain("BLOCKED");
    const nav = driveTargetSets(
      [
        ["@e:home", "l", "Home"],
        ["@e:models", "l", "Models"],
      ],
      {},
      false,
    );
    expect(nav.operations).toContain("WAIT");
    expect(nav.operations).toContain("BLOCKED");
  });

  it("keeps a non-DONE answer when every listed control is suppressed", () => {
    // A stalled form: consent already ticked, submit disabled while the server
    // validates. Both rows are withheld from CLICK, so offering DONE alone
    // would force a false "complete" on an unfinished signup.
    const stalled: WireRow[] = [
      ["@e:cb", "c", "I agree to the terms|s=c"],
      ["@e:go", "b", "Create account|s=d"],
    ];
    const sets = driveTargetSets(stalled, {}, false);
    expect(sets.CLICK).toEqual([]);
    expect(sets.operations).toContain("WAIT");
    expect(sets.operations).toContain("BLOCKED");
  });

  it("plans an inbox read after submit even when no OTP field is listed", () => {
    const otp: WireRow = ["@e:code", "t", "@verification-code|f=otp"];
    expect(inboxSpecialPlan(ROWS, "stuck", true, 0)).toBeUndefined();
    expect(inboxSpecialPlan(ROWS, "wait", true, 0)).toBeUndefined();
    expect(inboxSpecialPlan([["@e:login", "b", "Go to login"]], "stuck", true, 0)).toBeUndefined();
    expect(
      inboxSpecialPlan(
        [
          ["@e:hint", "l", "Check your email"],
          ["@e:login", "b", "Go to login"],
        ],
        "stuck",
        true,
        0,
      ),
    ).toEqual({ kind: "link" });
    expect(
      inboxSpecialPlan(
        [
          ["@e:email", "t", "Email address|f=email|s=rd|n=a@b.test"],
          ["@e:pw", "t", "Password|f=password|s=rd"],
          ["@e:go", "b", "Continue|s=d"],
          ["@e:gmail", "l", "Gmail Open Gmail"],
        ],
        "stuck",
        true,
        0,
      ),
    ).toEqual({ kind: "link" });
    expect(
      pageSuggestsInboxWait(
        [
          ["@e:logo", "l", "Meilisearch logo"],
          ["@e:fb", "b", "Send feedback"],
        ],
        "https://cloud.meilisearch.com/teams",
      ),
    ).toBe(false);
    expect(
      pageSuggestsInboxWait(
        [["@e:hint", "l", "Check your email"]],
        "https://app.example.test/signup",
      ),
    ).toBe(true);
    expect(pageSuggestsInboxWait([], "https://app.currencyapi.com/email/verify")).toBe(true);
    expect(inboxSpecialPlan([...ROWS, otp], "stuck", true, 0)).toEqual({
      kind: "otp",
      target: "@e:code",
    });
    expect(inboxSpecialPlan(ROWS, "stuck", true, 1)).toBeUndefined();
    expect(inboxSpecialPlan(ROWS, "stuck", false, 0)).toBeUndefined();
    expect(inboxSpecialPlan(ROWS, "act", true, 0)).toBeUndefined();
    expect(
      inboxSpecialPlan(
        [
          ["@e:role", "combobox", "Founder/CTO|a=picker|n=Founder/CTO"],
          ["@e:cb", "c", "checkbox|s=u"],
          ["@e:next", "b", "Next|s=d"],
        ],
        "stuck",
        true,
        0,
      ),
    ).toBeUndefined();
  });

  it("follows a verify link and retries an empty inbox instead of asking for a code", () => {
    expect(
      inboxVerificationDecision({ found: true, code: null, link: "https://x.test/v" }, "link"),
    ).toBe("goto_link");
    expect(inboxVerificationDecision({ found: false, code: null, link: null }, "link")).toBe(
      "retry",
    );
    expect(inboxVerificationDecision({ found: true, code: "123456", link: null }, "otp")).toBe(
      "type_code",
    );
    expect(inboxVerificationDecision({ found: true, code: "123456", link: null }, "link")).toBe(
      "needs_code",
    );
  });
});

describe("handoff shape", () => {
  it("always includes status, trajectory, done/remaining, and counters", () => {
    const handoff = buildHandoff({
      status: "budget",
      sessionId: "sess-1",
      trajectory: [{ action: "click", target: "@e:go", confidence: 0.9, url: "https://x.test/a" }],
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
    expect(matchingFactKeys({ last_name: "Lovelace", first_name: "Ada" }, last)).toEqual([
      "last_name",
    ]);
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

  it("omits a click that just came back stale so the overlay can be chosen", () => {
    const signUp: WireRow = ["@e:go", "b", "Sign Up"];
    const accept: WireRow = ["@e:ok", "b", "Accept All"];
    const page: WireRow[] = [EMAIL, signUp, accept];
    expect(clickableCandidates(page, false).map((c) => c.ref)).toEqual(["@e:go", "@e:ok"]);
    expect(clickableCandidates(page, false, ["@e:go"]).map((c) => c.ref)).toEqual(["@e:ok"]);
  });

  it("treats a no-op action as exhausted on the same progress key", () => {
    const filled: WireRow[] = [
      ["@e:email", "t", "Email|f=email|n=a@b.test"],
      ["@e:go", "b", "Sign Up"],
      ["@e:ok", "b", "Accept All"],
      ["@e:ad", "l", "Own Your AI: Control your models"],
    ];
    const key = pageProgressKey("https://api-ninjas.com/register", filled, ["@e:email"]);
    expect(
      pageProgressKey("https://api-ninjas.com/register", filled, ["@e:email", "@e:pw"]),
    ).not.toBe(key);
    expect(
      pageProgressKey(
        "https://api-ninjas.com/register",
        [...filled, ["@e:ad2", "l", "A different marketing line"]],
        ["@e:email"],
      ),
    ).toBe(key);
    expect(
      pageProgressKey(
        "https://api-ninjas.com/register",
        filled.filter((row) => row[0] !== "@e:ok"),
        ["@e:email"],
      ),
    ).not.toBe(key);
    const drive = {
      exhaustedProgressKey: null as string | null,
      exhaustedActionKeys: [] as string[],
    };
    expect(recordDeadAction(drive, key, "@e:go")).toBe("continue");
    expect(drive.exhaustedActionKeys).toEqual(["@e:go"]);
    expect(recordDeadAction(drive, key, "@e:go")).toBe("continue");
    expect(drive.exhaustedActionKeys).toEqual(["@e:go"]);
    expect(recordDeadAction(drive, key, "WAIT")).toBe("continue");
    expect(recordDeadAction(drive, key, "@e:ok")).toBe("continue");
    expect(recordDeadAction(drive, key, "@e:x")).toBe("continue");
    expect(recordDeadAction(drive, key, "@e:y")).toBe("stop");
    expect(deadActionReason(drive.exhaustedActionKeys, "https://api-ninjas.com/register")).toBe(
      "no change after @e:go, WAIT, @e:ok, @e:x, @e:y on https://api-ninjas.com/register",
    );
    const sets = driveTargetSets(
      filled,
      { email: "a@b.test" },
      false,
      ["@e:email"],
      "https://api-ninjas.com/register",
      new Map(),
      (text) => text,
      ["@e:go", "WAIT"],
    );
    expect(sets.CLICK.map((c) => c.ref)).toEqual(["@e:ok", "@e:ad"]);
    expect(sets.operations).not.toContain("WAIT");
  });

  it("keeps acted markers and committed field state in the progress fingerprint", () => {
    const acted: WireRow = ["@e:state", "s", "@state|w=acted"];
    const before = observationFingerprint("https://x.test", [acted]);
    const afterFill = observationFingerprint(
      "https://x.test",
      [acted],
      ["filled:@e:state", "sel:state=California"],
    );
    expect(before).toContain("w=acted");
    expect(afterFill).not.toBe(before);
  });

  it("offers a search field for TYPE_TEXT even without a query fact, then needs_value", () => {
    const search: WireRow = ["@e:q", "t", "@search-wikipedia|f=search"];
    const goal = "Open the Wikipedia article for Zurich";
    const questions = buildDriveQuestions([search, SUBMIT], {}, goal);
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions[DRIVE_VALUE_QUESTION]?.type).toBe("choice");
    expect(typeableCandidates([search], {}, false).map((c) => c.ref)).toEqual(["@e:q"]);
    const ops = questions.operation?.type === "choice" ? questions.operation.criteria : {};
    const types =
      questions.TYPE_TEXT_target?.type === "choice" ? questions.TYPE_TEXT_target.criteria : {};
    const values =
      questions[DRIVE_VALUE_QUESTION]?.type === "choice"
        ? questions[DRIVE_VALUE_QUESTION].criteria
        : {};
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
    expect(
      typeableCandidates([search], { query: "Zurich weather" }, false).map((c) => c.ref),
    ).toEqual(["@e:q"]);
    expect(clickableCandidates([trip], false).map((c) => c.ref)).toEqual(["@e:trip"]);
    const questions = buildDriveQuestions(
      [search, trip],
      { query: "Zurich weather" },
      "Search DuckDuckGo",
    );
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions.CLICK_target?.type).toBe("choice");
  });

  it("matches origin and destination facts from where-from / where-to labels", () => {
    const from: WireRow = ["@e:from", "t", "@where-from|f=origin"];
    const to: WireRow = ["@e:to", "t", "@where-to|f=destination"];
    const facts = { origin: "Zurich", destination: "London" };
    expect(matchingFactKeys(facts, from)).toEqual(["origin"]);
    expect(matchingFactKeys(facts, to)).toEqual(["destination"]);
    expect(typeableCandidates([from, to], facts, false).map((c) => c.ref)).toEqual([
      "@e:from",
      "@e:to",
    ]);
  });

  it("offers CLICK Open on fillable pickers and keeps TYPE_TEXT", () => {
    const departure: WireRow = ["@e:dep", "t", "Departure|f=date"];
    const from: WireRow = ["@e:from", "t", "Where from?|f=origin"];
    const facts = { origin: "Zurich", date: "2026-09-20" };
    expect(isPickerRow(departure)).toBe(true);
    expect(isPickerRow(from)).toBe(true);
    expect(isPickerRow(EMAIL)).toBe(false);
    expect(operationsForRow(departure)).toEqual(["TYPE_TEXT", "CLICK"]);
    expect(operationsForRow(EMAIL)).toEqual(["TYPE_TEXT"]);
    expect(actionDescription(departure, [departure], "CLICK")).toBe("Open Departure");
    expect(actionDescription(departure)).toBe("type into the Departure field");
    expect(clickableCandidates([departure, from, EMAIL, SUBMIT], false).map((c) => c.ref)).toEqual([
      "@e:dep",
      "@e:from",
      "@e:go",
    ]);
    expect(
      typeableCandidates([departure, from, EMAIL], { ...facts, email: "a@b.test" }, false).map(
        (c) => c.ref,
      ),
    ).toEqual(["@e:dep", "@e:from", "@e:email"]);
    const questions = buildDriveQuestions(
      [departure, from, EMAIL, SUBMIT],
      { ...facts, email: "a@b.test" },
      "one-way Zurich to London",
    );
    expect(questions.TYPE_TEXT_target?.type).toBe("choice");
    expect(questions.CLICK_target?.type).toBe("choice");
    if (
      questions.CLICK_target?.type !== "choice" ||
      questions.TYPE_TEXT_target?.type !== "choice"
    ) {
      return;
    }
    expect(Object.values(questions.CLICK_target.criteria)).toEqual(
      expect.arrayContaining(["Open Departure", "Open Where from?", "continue"]),
    );
    expect(Object.values(questions.CLICK_target.criteria)).not.toContain("Open email");
    expect(Object.values(questions.TYPE_TEXT_target.criteria)).toEqual(
      expect.arrayContaining(["Departure", "Where from?", "email"]),
    );
  });

  it("maps a Departure field to the date fact, not origin", () => {
    const departure: WireRow = ["@e:dep", "t", "Departure"];
    const facts = { origin: "Zurich", destination: "London", date: "2026-09-20" };
    expect(matchingFactKeys(facts, departure)).toEqual(["date"]);
    expect(typeableCandidates([departure], facts, false).map((c) => c.ref)).toEqual(["@e:dep"]);
  });

  it("opens a fact-backed combobox but yields unassociated option clicks to the model", () => {
    const trip: WireRow = [
      "@e:trip",
      "combobox",
      "Change ticket type. Round trip|a=picker|n=Round trip",
    ];
    const cabin: WireRow = [
      "@e:cabin",
      "combobox",
      "Change seating class. Economy|a=picker|n=Economy",
    ];
    const oneWay: WireRow = ["@e:ow", "b", "One way"];
    const facts = { ticket_type: "One way", cabin: "Economy" };
    expect(matchingFactKeys(facts, trip)).toEqual(["ticket_type"]);
    expect(matchingFactKeys(facts, cabin)).toEqual(["cabin"]);
    expect(requiredFactComboboxAction([trip, cabin], facts)).toEqual({ target: "@e:trip" });
    expect(requiredFactComboboxAction([trip, cabin, oneWay], facts)).toBeUndefined();
    expect(requiredFactComboboxAction([cabin], facts)).toBeUndefined();
    expect(requiredFactComboboxAction([trip], facts, ["@e:trip"])).toBeUndefined();
  });

  it("yields when another Country menu or an unrelated button offers the fact", () => {
    const shipping: WireRow = ["@e:shipping", "combobox", "Shipping Country|n=United States"];
    const billing: WireRow = ["@e:billing", "combobox", "Billing Country|n=United States"];
    const facts = { country: "Canada" };
    for (const role of ["b", "l"]) {
      const canada: WireRow = ["@e:canada", role, "Canada"];
      expect(requiredFactComboboxAction([shipping, billing, canada], facts)).toBeUndefined();
    }
  });

  it("assigns a page-supplied select option from a goal phrase without a matching fact", () => {
    const trip: WireRow = ["@e:trip", "s", "@trip-type"];
    const pageOptions = new Map<string, readonly string[]>([
      ["@e:trip", ["Round trip", "One way", "Multi-city"]],
    ]);
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
    const selects =
      questions.SELECT_target?.type === "choice" ? questions.SELECT_target.criteria : {};
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
    expect(Object.values(goalValueCriteria(goal, {}))).toEqual(
      expect.arrayContaining(["Ada", "Lovelace"]),
    );
    expect(requiredFillableMissingFact([email, SUBMIT], {})?.ref).toBe("@e:email");
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
    expect(
      operateDriveTool.inputSchema.parse({ url: "https://x.test/signup", goal: "sign up" }),
    ).toMatchObject({
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
});

describe("select option key collisions", () => {
  it("offers and executes distinct options with the same truncated slug", () => {
    const options = [
      "International shipping delivery within 10 days",
      "International shipping delivery within 15 days",
    ];
    const pageOptions = new Map([[STATE[0], options]]);
    const targets = selectTargets(selectCandidates([STATE], {}, false), {}, pageOptions);
    expect(targets.slice(1).map((target) => target.option)).toEqual(options);
    expect(new Set(targets.map((target) => target.slug)).size).toBe(3);
    const questions = buildDriveQuestions(
      [STATE],
      {},
      "choose shipping",
      false,
      [],
      "",
      pageOptions,
    );
    const operation = questions.operation;
    const select = questions.SELECT_target;
    if (operation?.type !== "choice" || select?.type !== "choice")
      throw new Error("missing choices");
    for (const target of targets.slice(1)) {
      const decision = decideAfterJev({
        rows: [STATE],
        facts: {},
        goal: "choose shipping",
        lastFingerprint: null,
        lastActionKey: null,
        fingerprint: "fp",
        pageOptions,
        answers: {
          operation: valid("SELECT", operation.criteria),
          SELECT_target: valid(target.slug, select.criteria),
        },
      });
      expect(decision).toMatchObject({
        kind: "act",
        action: { kind: "select", target: STATE[0], text: target.option },
      });
    }
  });
});

describe("drive outbound choice budgets", () => {
  it("reserves a usable search value when earlier click targets consume the budget", () => {
    const search: WireRow = ["@e:search", "t", "@search|f=query"];
    const rows: WireRow[] = [
      ...Array.from({ length: 123 }, (_, i): WireRow => [`@e:link${i}`, "l", `@link-${i}`]),
      search,
    ];
    const sets = driveTargetSets(rows, {}, false);
    expect(sets.CLICK).toHaveLength(123);
    const questions = buildDriveQuestions(rows, {}, "widgets", false, [], "", new Map(), sets);
    expect(
      Object.values(questions).reduce(
        (n, q) => n + (q.type === "choice" ? Object.keys(q.criteria).length : 0),
        0,
      ),
    ).toBe(DRIVE_MAX_CRITERIA);
    const clickQuestion = questions.CLICK_target;
    expect(clickQuestion?.type).toBe("choice");
    if (clickQuestion?.type !== "choice") throw new Error("missing click choices");
    const clickCount = Object.keys(clickQuestion.criteria).length;
    expect(clickCount).toBeGreaterThan(0);
    expect(clickCount).toBeLessThan(123);
    const valueQuestion = questions[DRIVE_VALUE_QUESTION];
    const operation = questions.operation;
    const target = questions.TYPE_TEXT_target;
    if (
      valueQuestion?.type !== "choice" ||
      operation?.type !== "choice" ||
      target?.type !== "choice"
    )
      throw new Error("missing search choices");
    expect(valueQuestion.criteria).toHaveProperty(DRIVE_FIXED_NONE);
    const usable = Object.entries(valueQuestion.criteria).find(
      ([key, value]) => key !== DRIVE_FIXED_NONE && value === "widgets",
    );
    expect(usable).toBeDefined();
    expect(
      decideAfterJev({
        rows,
        facts: {},
        goal: "widgets",
        fingerprint: "page",
        lastFingerprint: null,
        lastActionKey: null,
        sets,
        questions,
        answers: {
          operation: valid("TYPE_TEXT", operation.criteria),
          TYPE_TEXT_target: valid(sets.TYPE_TEXT[0]!.slug, target.criteria),
          [DRIVE_VALUE_QUESTION]: valid(usable![0], valueQuestion.criteria),
        },
      }),
    ).toMatchObject({ kind: "act", action: { kind: "type", target: search[0], text: "widgets" } });
  });

  it("elides large dropdowns within the batch budget and executes an offered option", () => {
    const options = Array.from({ length: 200 }, (_, i) => `Region ${i}`);
    const pageOptions = new Map([["state", options]]);
    const sets = driveTargetSets([STATE], {}, false, [], "", pageOptions);
    const questions = buildDriveQuestions(
      [STATE],
      {},
      "choose region",
      false,
      [],
      "",
      pageOptions,
      sets,
    );
    const total = Object.values(questions).reduce(
      (n, q) => n + (q.type === "choice" ? Object.keys(q.criteria).length : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(DRIVE_MAX_CRITERIA);
    expect(sets.SELECT.length).toBeLessThan(options.length);
    expect(elementState(sets.SELECT[0]!)).toMatchObject({ options_elided: true });
    const candidate = sets.SELECT.at(-1)!;
    expect(candidate.option).toBeDefined();
    const answers = Object.fromEntries(
      Object.entries(questions).flatMap(([name, q]) =>
        q.type === "choice"
          ? [[name, valid(name === "operation" ? "SELECT" : candidate.slug, q.criteria)]]
          : [],
      ),
    );
    expect(
      decideAfterJev({
        rows: [STATE],
        facts: {},
        goal: "choose region",
        fingerprint: "a",
        lastFingerprint: null,
        lastActionKey: null,
        sets,
        questions,
        answers,
      }),
    ).toMatchObject({ kind: "act", action: { kind: "select", text: candidate.option } });
  });

  it("includes goal-value choices in the batch budget and validates the offered subset", () => {
    const row: WireRow = ["@e:search", "t", "@search|f=query"];
    const facts = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`item_${i}`, `phrase ${i}`]),
    );
    const sets = driveTargetSets([row, STATE], facts, false);
    const questions = buildDriveQuestions(
      [row, STATE],
      facts,
      "search for widgets",
      false,
      [],
      "",
      new Map(),
      sets,
    );
    expect(
      Object.values(questions).reduce(
        (n, q) => n + (q.type === "choice" ? Object.keys(q.criteria).length : 0),
        0,
      ),
    ).toBeLessThanOrEqual(DRIVE_MAX_CRITERIA);
    const valueQuestion = questions[DRIVE_VALUE_QUESTION];
    expect(valueQuestion?.type).toBe("choice");
    if (valueQuestion?.type !== "choice") throw new Error("missing value choices");
    expect(valueQuestion.criteria).toHaveProperty(DRIVE_FIXED_NONE);
    const valueKey = Object.keys(valueQuestion.criteria).find((key) => key !== DRIVE_FIXED_NONE)!;
    const answers = Object.fromEntries(
      Object.entries(questions).flatMap(([name, q]) =>
        q.type === "choice"
          ? [
              [
                name,
                valid(
                  name === "operation"
                    ? "TYPE_TEXT"
                    : name === "TYPE_TEXT_target"
                      ? sets.TYPE_TEXT[0]!.slug
                      : name === DRIVE_VALUE_QUESTION
                        ? valueKey
                        : Object.keys(q.criteria)[0]!,
                  q.criteria,
                ),
              ],
            ]
          : [],
      ),
    );
    expect(
      decideAfterJev({
        rows: [row, STATE],
        facts,
        goal: "search for widgets",
        fingerprint: "a",
        lastFingerprint: null,
        lastActionKey: null,
        sets,
        questions,
        answers,
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "type", text: valueQuestion.criteria[valueKey] },
    });
  });
});

describe("drive aim ranking", () => {
  const formEmail: WireRow = ["@e:email", "t", "Email|f=email|fm=1"];
  const formSubmit: WireRow = ["@e:go", "b", "Create account|fm=1"];
  const otherSubmit: WireRow = ["@e:news", "b", "Create account|fm=2"];
  const accept: WireRow = ["@e:ok", "b", "Accept All"];
  const covered: WireRow = ["@e:go", "b", "Sign Up|oc=@e:ok"];

  function candidate(row: WireRow): DriveCandidate {
    return {
      ref: row[0],
      role: row[1],
      slug: row[0].replace("@e:", ""),
      description: row[2] ?? row[0],
      row,
    };
  }

  it("reads form membership and cover facts from the wire row", () => {
    expect(rowFormId(formEmail)).toBe("1");
    expect(rowOccluder(covered)).toBe("@e:ok");
    expect(filledFormIds([formEmail, formSubmit], ["@e:email"])).toEqual(new Set(["1"]));
  });

  it("infers page phase from the URL path and headings, never a hostname", () => {
    expect(inferPagePhase("https://example.test/register")).toBe("signup");
    expect(inferPagePhase("https://example.test/users/sign_in")).toBe("login");
    expect(inferPagePhase("https://example.test/email/verify")).toBe("verify");
    expect(inferPagePhase("https://example.test/welcome")).toBe("onboarding");
    expect(inferPagePhase("https://example.test/settings/api-keys")).toBe("keys");
    expect(inferPagePhase("https://example.test/checkouts/cn/token")).toBe("checkout");
    expect(inferPagePhase("https://example.test/app", ["Create an API key"])).toBe("keys");
    expect(inferPagePhase("https://example.test/app", ["Check your email"])).toBe("verify");
    expect(inferPagePhase("https://example.test/app")).toBe("unknown");
  });

  it("prefers the submit of the form just filled over a same-label control on another form", () => {
    const ranked = rankDriveCandidates([candidate(otherSubmit), candidate(formSubmit)], {
      rows: [formEmail, formSubmit, otherSubmit],
      filledRefs: ["@e:email"],
      pageUrl: "https://example.test/register",
    });
    expect(ranked.map((entry) => entry.ref)).toEqual(["@e:go", "@e:news"]);
  });

  it("offers the covering control ahead of the covered target", () => {
    const ranked = rankDriveCandidates([candidate(covered), candidate(accept)], {
      rows: [covered, accept],
      pageUrl: "https://example.test/register",
    });
    expect(ranked.map((entry) => entry.ref)).toEqual(["@e:ok", "@e:go"]);
  });

  it("downweights a remounted control whose role and label already failed", () => {
    const first: WireRow = ["@e:old", "b", "Log in"];
    const remount: WireRow = ["@e:new", "b", "Log in"];
    const create: WireRow = ["@e:join", "b", "Create account"];
    const drive = { failedActionKeys: [] as string[] };
    rememberFailedAction(drive, [first], "@e:old");
    expect(drive.failedActionKeys).toEqual([actionFailureKey(first)]);
    const ranked = rankDriveCandidates([candidate(remount), candidate(create)], {
      rows: [remount, create],
      pageUrl: "https://example.test/login",
      failedKeys: drive.failedActionKeys,
      goal: "Sign up using the email/password form and reach the API key page",
    });
    expect(ranked.map((entry) => entry.ref)).toEqual(["@e:join", "@e:new"]);
  });

  it("keeps document order when no form, cover, failure, or phase signal applies", () => {
    const one: WireRow = ["@e:a", "b", "Alpha"];
    const two: WireRow = ["@e:b", "b", "Beta"];
    expect(
      rankDriveCandidates([candidate(one), candidate(two)], {
        rows: [one, two],
        pageUrl: "https://example.test/app",
      }).map((entry) => entry.ref),
    ).toEqual(["@e:a", "@e:b"]);
  });

  it("ranks Create account ahead of Log in on a login URL when the goal is a signup", () => {
    const login: WireRow = ["@e:in", "b", "Log in"];
    const join: WireRow = ["@e:join", "b", "Create account"];
    const sets = driveTargetSets(
      [login, join],
      {},
      false,
      [],
      "https://example.test/login",
      new Map(),
      (text) => text,
      [],
      { goal: "Sign up using the email/password form" },
    );
    expect(sets.CLICK.map((entry) => entry.ref)).toEqual(["@e:join", "@e:in"]);
  });
});
