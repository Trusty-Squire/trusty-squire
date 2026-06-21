// F3 T5 — the unified planExecuteWithRetry loop. Covers the four
// behaviours the rework rests on:
//   1. REGRESSION (IRON RULE): a post-submit validation error still
//      triggers a re-plan — the path that used to be a standalone
//      block and is now folded into the loop.
//   2. a planned selector that resolves to the WRONG element re-plans
//      (Tension 4 — the verify attribute-match).
//   3. a reveal-only plan (two-stage chooser) re-plans the now-
//      visible form.
//   4. an OAuth-only page returns oauth_required before planning.
//
// planExecuteWithRetry is private — reflected here, the same
// break-the-encapsulation pattern as captcha-short-circuit.test.ts.

import { describe, expect, it, vi } from "vitest";

// Hermeticity: planExecuteWithRetry resolves OAuth candidates from the
// bot's real Chrome-profile login marker (loggedInProviders reads
// CHROME_PROFILE_DIR, frozen at module load). On an operator machine
// that has run `mcp login`, that marker is non-empty and reroutes these
// tests down the OAuth-first path — so the OAuth-only + two-stage-reveal
// cases depend on the host's profile. Pin it to "no sessions" so the
// suite is deterministic everywhere (matches a clean CI checkout).
vi.mock("../login-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../login-state.js")>();
  return { ...actual, loggedInProviders: () => [] };
});

import { planSimpleEmailOnlySignup, resolvePlannedFillValue, SignupAgent } from "../agent.js";
import type {
  BrowserController,
  BrowserState,
  CaptchaSolveResult,
  InteractiveElement,
} from "../browser.js";
import type { LLMClient, LLMResponse } from "../llm-client.js";

function mk(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "input",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

const fillPlan = (sel: string, submit: string): string =>
  JSON.stringify({
    actions: [{ kind: "fill", selector: sel, value_kind: "email", reason: "email" }],
    submit_selector: submit,
    confidence: "high",
  });

describe("planSimpleEmailOnlySignup", () => {
  it("plans a one-field magic-link form without an LLM", () => {
    const plan = planSimpleEmailOnlySignup([
      mk({ tag: "input", type: "email", labelText: "E-mail", selector: "#email" }),
      mk({ tag: "button", type: "submit", visibleText: "Send me a magic link", selector: "#submit" }),
    ]);
    expect(plan).toMatchObject({
      actions: [{ kind: "fill", selector: "#email", value_kind: "email" }],
      submit_selector: "#submit",
      confidence: "high",
    });
  });

  it("does not bypass the planner for multi-field/password forms", () => {
    expect(
      planSimpleEmailOnlySignup([
        mk({ tag: "input", type: "email", labelText: "E-mail", selector: "#email" }),
        mk({ tag: "input", type: "password", labelText: "Password", selector: "#password" }),
        mk({ tag: "button", type: "submit", visibleText: "Sign up", selector: "#submit" }),
      ]),
    ).toBeNull();
  });

  it("does not fill an email-only sign-in form that exposes a separate signup link", () => {
    expect(
      planSimpleEmailOnlySignup([
        mk({ tag: "input", type: "email", labelText: "Email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Continue", selector: "#continue" }),
        mk({ tag: "a", visibleText: "Sign up", selector: "#signup" }),
      ]),
    ).toBeNull();
  });
});

const clickPlan = (sel: string): string =>
  JSON.stringify({
    actions: [{ kind: "click", selector: sel, reason: "reveal the email form" }],
    submit_selector: sel,
    confidence: "high",
  });

const checkPlan = (checkSel: string, submit: string): string =>
  JSON.stringify({
    actions: [{ kind: "check", selector: checkSel, reason: "required signup checkbox" }],
    submit_selector: submit,
    confidence: "high",
  });

// LLM stub that replays a queue of plan replies (last reply sticks).
class QueueLLM implements LLMClient {
  readonly name = "queue";
  public calls = 0;
  constructor(private readonly replies: string[]) {}
  async createMessage(): Promise<LLMResponse> {
    const r = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return { text: r ?? "{}", backend: this.name };
  }
}

// Browser stub: inventory + extractText are per-call queues so a test
// can model the page changing between loop iterations. inspectSelector
// defaults to "resolves cleanly"; tests override it to model a miss.
class FakeBrowser {
  public inventoryQueue: InteractiveElement[][] = [[]];
  public extractTextValues: string[] = [""];
  public inspectSelectorImpl: (sel: string) => {
    count: number;
    tag: string | null;
    id: string | null;
    name: string | null;
  } = () => ({ count: 1, tag: null, id: null, name: null });
  private invCalls = 0;
  private textCalls = 0;

  get channel(): string | null {
    return null;
  }
  async prewarm(): Promise<void> {}
  async goto(): Promise<void> {}
  async wait(): Promise<void> {}
  async waitForFormReady(): Promise<void> {}
  async dismissConsentBanner(): Promise<string | null> { return null; }
  public typed: Array<{ selector: string; value: string }> = [];
  async type(selector: string, value: string): Promise<void> {
    this.typed.push({ selector, value });
  }
  public checked: string[] = [];
  async check(selector: string): Promise<void> {
    this.checked.push(selector);
  }
  public clicked: string[] = [];
  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
  }
  public clickSubmitImpl: () => void = () => {};
  public submitted: string[] = [];
  async clickSubmit(selector?: string): Promise<void> {
    if (selector) this.submitted.push(selector);
    this.clickSubmitImpl();
  }
  async checkRequiredSignupChoiceBoxes(): Promise<string[]> {
    return [];
  }
  async checkRequiredAgreementBoxes(): Promise<string[]> {
    return [];
  }
  async selectOption(): Promise<void> {}
  async solveVisibleCaptcha(): Promise<CaptchaSolveResult> {
    return { found: false };
  }
  async detectCaptchaVariant() {
    return { variant: "unknown", challengeRendered: false };
  }
  async getState(): Promise<BrowserState> {
    return { url: "https://x.test/signup", title: "Sign up", html: "", screenshot: "" };
  }
  async extractText(): Promise<string> {
    const i = Math.min(this.textCalls, this.extractTextValues.length - 1);
    this.textCalls += 1;
    return this.extractTextValues[i] ?? "";
  }
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    const i = Math.min(this.invCalls, this.inventoryQueue.length - 1);
    this.invCalls += 1;
    return this.inventoryQueue[i] ?? [];
  }
  async inspectSelector(
    selector: string,
  ): Promise<{ count: number; tag: string | null; id: string | null; name: string | null }> {
    return this.inspectSelectorImpl(selector);
  }
}

interface Outcome {
  kind: string;
  reason?: string;
}

function isController(_v: unknown): _v is BrowserController {
  return true;
}

async function runLoop(
  browser: FakeBrowser,
  llm: QueueLLM,
  taskOver: Record<string, unknown> = {},
): Promise<{ outcome: Outcome; steps: string[] }> {
  const asController: unknown = browser;
  if (!isController(asController)) throw new Error("unreachable");
  const agent = new SignupAgent(asController, llm);
  const steps: string[] = [];
  const fillValues = {
    email: "bot@inbox.test",
    password: "Pw-test-12345",
    name: "Test Bot",
    username: "testbot12",
    company: "Trusty Squire",
    phone: "6502530000",
    literal: "",
  };
  const fn = (
    agent as unknown as {
      planExecuteWithRetry: (
        t: { service: string; email: string },
        fv: typeof fillValues,
        s: string[],
      ) => Promise<Outcome>;
    }
  ).planExecuteWithRetry.bind(agent);
  const outcome = await fn(
    { service: "Test", email: "bot@inbox.test", ...taskOver },
    fillValues,
    steps,
  );
  return { outcome, steps };
}

describe("planExecuteWithRetry", () => {
  it("REGRESSION: a post-submit validation error re-plans (IRON RULE)", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    // First submit shows a validation error; the re-plan's submit is clean.
    browser.extractTextValues = ["Email is required", ""];
    const llm = new QueueLLM([fillPlan("#email", "#go"), fillPlan("#email", "#go")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(steps.some((s) => /validation errors? — re-planning/i.test(s))).toBe(true);
    expect(llm.calls).toBe(2); // re-planned once
  });

  it("re-plans when a planned selector resolves to the wrong element", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", id: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    browser.inspectSelectorImpl = (sel) => ({
      count: 1,
      tag: sel === "#go" ? "button" : "input",
      id: sel.startsWith("#") ? sel.slice(1) : null,
      name: null,
    });
    // #email resolves, but to an element whose id != the inventory's
    // on the first plan (a recycled node); the re-plan resolves clean.
    let emailInspects = 0;
    browser.inspectSelectorImpl = (sel) => {
      if (sel === "#email") {
        emailInspects += 1;
        return emailInspects <= 1
          ? { count: 1, tag: "input", id: "stale-other", name: null }
          : { count: 1, tag: "input", id: "email", name: null };
      }
      return { count: 1, tag: "button", id: null, name: null };
    };
    const llm = new QueueLLM([fillPlan("#email", "#go"), fillPlan("#email", "#go")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(steps.some((s) => /did not verify/i.test(s))).toBe(true);
  });

  it("re-plans the now-visible form after a reveal-only (two-stage) plan", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      // Stage 1: a chooser — only a "sign up with email" button.
      [mk({ tag: "button", visibleText: "Sign up with email", selector: "#emailBtn" })],
      // Stage 2: the revealed form.
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    const llm = new QueueLLM([clickPlan("#emailBtn"), fillPlan("#email", "#go")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(steps.some((s) => /only revealed the page/i.test(s))).toBe(true);
  });

  it("submits after a check-only field edit instead of treating it as reveal-only", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "checkbox", labelText: "I sell software", selector: "#software" }),
        mk({ tag: "button", type: "submit", visibleText: "Continue", selector: "#continue" }),
      ],
    ];
    const llm = new QueueLLM([checkPlan("#software", "#continue")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(browser.checked).toEqual(["#software"]);
    expect(browser.submitted).toEqual(["#continue"]);
    expect(steps.some((s) => /only revealed the page/i.test(s))).toBe(false);
  });

  it("fills password confirmation with the generated password even if the planner emits literal", () => {
    const value = resolvePlannedFillValue(
      {
        kind: "fill",
        selector: "#passwordVerification",
        value_kind: "literal",
        literal: "same as password",
        reason: "confirm password",
      },
      {
        email: "bot@inbox.test",
        password: "Pw-test-12345",
        name: "Test Bot",
        username: "testbot12",
        company: "Trusty Squire",
        phone: "6502530000",
        literal: "",
      },
      mk({
        tag: "input",
        type: "password",
        id: "passwordVerification",
        name: "passwordVerification",
        placeholder: "Enter your password again",
        selector: "#passwordVerification",
      }),
      {
        firstName: "Test",
        lastName: "Bot",
        displayName: "Test Bot",
        username: "testbot12",
      },
    );

    expect(value).toBe("Pw-test-12345");
  });

  it("returns oauth_required when the page has only OAuth buttons", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" }),
        mk({ tag: "button", visibleText: "Continue with GitHub", selector: "#h" }),
      ],
    ];
    const llm = new QueueLLM([fillPlan("#x", "#x")]);

    const { outcome } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("oauth_required");
    expect(llm.calls).toBe(0); // detected before any planner call
  });

  it("F14: fails planning_failed when the planner re-picks the same click selector after no-progress", async () => {
    const browser = new FakeBrowser();
    // Page never advances — inventory stays the same on every call,
    // and the only click target is a footer "Email" link that doesn't
    // navigate (the Railway pattern that motivated F14).
    browser.inventoryQueue = [
      [mk({ tag: "a", visibleText: "Email", selector: "#footer-email" })],
    ];
    // First plan clicks the dead link (no fill → progress-replan).
    // Second plan picks the SAME dead link — F14 should fail it.
    const llm = new QueueLLM([
      clickPlan("#footer-email"),
      clickPlan("#footer-email"),
    ]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("planning_failed");
    expect(outcome.reason ?? "").toMatch(/stuck/i);
    expect(outcome.reason ?? "").toContain("#footer-email");
    // Hint should have warned the planner before the second pick.
    expect(steps.some((s) => /only revealed the page/i.test(s))).toBe(true);
    expect(llm.calls).toBe(2);
  });

  it("F14: allows a NEW click selector even after a prior no-progress click", async () => {
    const browser = new FakeBrowser();
    // Inventory advances on round 2 to reveal the actual form (the
    // legitimate exploration case — bot picked a dead link, then a
    // working one).
    browser.inventoryQueue = [
      [
        mk({ tag: "a", visibleText: "Email", selector: "#dead-link" }),
        mk({ tag: "button", visibleText: "Continue with email", selector: "#real-cta" }),
      ],
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create", selector: "#go" }),
      ],
    ];
    // Round 1: dead-link click (no progress). Round 2: NEW click on
    // the real CTA — F14 must not reject this. Round 3: fill the
    // revealed form.
    const llm = new QueueLLM([
      clickPlan("#dead-link"),
      clickPlan("#real-cta"),
      fillPlan("#email", "#go"),
    ]);

    const { outcome } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(llm.calls).toBe(3);
  });

  it("F14: does NOT bail when the page changed between two clicks of the same selector (kinde unique-value retry)", async () => {
    const browser = new FakeBrowser();
    // kinde's post-OAuth register form: clicking "Next" with a colliding
    // (globally-unique) domain value does not advance the page; the bot
    // edits the field, the page re-renders (a new input/validation
    // element appears), and the planner RE-CLICKS the same "Next". That
    // re-click is legitimate progress, not a loop — the false-bail this
    // guards against ended the kinde run at terminal_round 3.
    browser.inventoryQueue = [
      // Round 1: the "Next" affordance + a text field whose value
      // collided — clicking Next does not advance.
      [
        mk({ tag: "input", type: "text", selector: "#domain" }),
        mk({ tag: "a", visibleText: "Next", selector: "#next" }),
      ],
      // Round 2: page CHANGED — a validation message element appeared
      // after the edit (inventory differs) → real progress. Same #next
      // is re-clicked.
      [
        mk({ tag: "input", type: "text", selector: "#domain" }),
        mk({ tag: "span", visibleText: "domain available", selector: "#domain-ok" }),
        mk({ tag: "a", visibleText: "Next", selector: "#next" }),
      ],
      // Round 3: the revealed form to fill + submit.
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create", selector: "#go" }),
      ],
    ];
    const llm = new QueueLLM([
      clickPlan("#next"), // r1: no advance → records #next as no-progress
      clickPlan("#next"), // r2: page changed → must NOT bail on the re-click
      fillPlan("#email", "#go"), // r3: submit
    ]);

    const { outcome } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(llm.calls).toBe(3);
  });

  it("F14: does NOT bail when a check/select was issued between two same-selector clicks", async () => {
    const browser = new FakeBrowser();
    // Inventory holds steady (no element add/remove), but the planner
    // ticks a required agreement box between the two "Next" clicks — a
    // field edit IS progress, so the re-click must not be judged a loop.
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "checkbox", selector: "#tos" }),
        mk({ tag: "button", visibleText: "Next", selector: "#next" }),
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create", selector: "#go" }),
      ],
    ];
    const checkThenClick = JSON.stringify({
      actions: [
        { kind: "check", selector: "#tos", reason: "accept terms" },
        { kind: "click", selector: "#next", reason: "advance" },
      ],
      submit_selector: "#next",
      confidence: "high",
    });
    const llm = new QueueLLM([
      clickPlan("#next"), // r1: no advance → records #next
      checkThenClick, // r2: check = progress → clears #next from no-progress
      fillPlan("#email", "#go"), // r3: submit
    ]);

    const { outcome } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(llm.calls).toBe(3);
  });

  it("F14: STILL bails on a true loop — same selector re-clicked with no intervening progress", async () => {
    const browser = new FakeBrowser();
    // Page never changes and no field is edited between the two identical
    // dead-link clicks — a genuine planner loop that must still bail.
    // (Same shape as the canonical F14 case so the page enters the
    // planner rather than short-circuiting to oauth_required.)
    browser.inventoryQueue = [
      [mk({ tag: "a", visibleText: "Email", selector: "#footer-email" })],
    ];
    const llm = new QueueLLM([
      clickPlan("#footer-email"),
      clickPlan("#footer-email"),
    ]);

    const { outcome } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("planning_failed");
    expect(outcome.reason ?? "").toMatch(/stuck/i);
    expect(outcome.reason ?? "").toContain("#footer-email");
    expect(llm.calls).toBe(2);
  });

  it("bails clean on repeated empty plans instead of spinning (Axiom 0-action loop)", async () => {
    const browser = new FakeBrowser();
    // Only a sign-up button, no fields — the page never reveals a form.
    browser.inventoryQueue = [
      [mk({ tag: "button", visibleText: "Sign up", selector: "#signup" })],
    ];
    const emptyPlan = JSON.stringify({
      actions: [],
      submit_selector: "#signup",
      confidence: "medium",
    });
    const llm = new QueueLLM([emptyPlan]);

    const { outcome } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("planning_failed");
    expect(outcome.reason ?? "").toMatch(/no fillable form/i);
    // Bails on the 2nd empty plan — does not spin to the progress cap.
    expect(llm.calls).toBe(2);
  });

  it("re-plans when a check action targets a non-checkbox (SendPulse TOS link)", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "a", visibleText: "Terms of Service", selector: "#toslink" }),
        mk({ tag: "input", type: "checkbox", labelText: "I agree", selector: "#agree" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    const withCheck = (checkSel: string): string =>
      JSON.stringify({
        actions: [
          { kind: "fill", selector: "#email", value_kind: "email", reason: "email" },
          { kind: "check", selector: checkSel, reason: "agree to TOS" },
        ],
        submit_selector: "#go",
        confidence: "high",
      });
    // Plan 1 picks the <a> link; the re-plan picks the real checkbox.
    const llm = new QueueLLM([withCheck("#toslink"), withCheck("#agree")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(steps.some((s) => /not a checkbox/i.test(s))).toBe(true);
  });

  // 0.8.2-rc.6 — Upstream-blip carve-out. The free-tier proxy returns
  // 502 with {"error":"upstream_error","upstream_status":429} on
  // sustained upstream throttling. Pre-rc.6, the form-fill planner's
  // catch block counted these toward errorReplans and gave up after
  // 2 (resulting in planning_failed: "planner output never validated:
  // ... 502 ..." — which is misleading because the planner's reply
  // never came; only the request itself failed). The carve-out
  // distinguishes upstream blips from planner-logic failures and
  // allows the loop to keep retrying through transient upstream
  // weather while STILL bailing fast on a real logic failure.
  it("does NOT exhaust errorReplans on upstream 502/upstream_error blips", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    // Custom LLM stub that throws the proxy's upstream-blip error
    // three times in a row, then returns a valid plan. Pre-rc.6 this
    // failed planning_failed after the 3rd throw; rc.6 should ride
    // through and submit successfully.
    class BlippyLLM implements LLMClient {
      readonly name = "blippy";
      public calls = 0;
      async createMessage(): Promise<LLMResponse> {
        this.calls += 1;
        if (this.calls <= 3) {
          throw new Error(
            'trusty-squire-proxy:free: 502 {"error":"upstream_error","upstream_status":429}',
          );
        }
        return { text: fillPlan("#email", "#go"), backend: this.name };
      }
    }
    const llm = new BlippyLLM();

    // Use the same runLoop machinery, but inject the BlippyLLM.
    const asController: unknown = browser;
    if (!isController(asController)) throw new Error("unreachable");
    const agent = new SignupAgent(asController, llm as unknown as LLMClient);
    const steps: string[] = [];
    const fillValues = {
      email: "bot@inbox.test",
      password: "Pw-test-12345",
      name: "Test Bot",
      username: "testbot12",
      company: "Trusty Squire",
      literal: "",
    };
    const fn = (
      agent as unknown as {
        planExecuteWithRetry: (
          t: { service: string; email: string },
          fv: typeof fillValues,
          s: string[],
        ) => Promise<Outcome>;
      }
    ).planExecuteWithRetry.bind(agent);
    const outcome = await fn(
      { service: "Test", email: "bot@inbox.test" },
      fillValues,
      steps,
    );

    expect(outcome.kind).toBe("submitted");
    expect(llm.calls).toBe(4); // 3 blips + 1 successful plan
    expect(steps.some((s) => /transient upstream blip/i.test(s))).toBe(true);
  });

  it("re-plans when the submit button is disabled, instead of failing", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    // First submit is disabled (a required control unsatisfied); the
    // re-plan's submit goes through.
    let submitCalls = 0;
    browser.clickSubmitImpl = () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        throw new Error(
          "submit_disabled: the submit button (#go) is disabled — a required field or agreement checkbox was not satisfied",
        );
      }
    };
    const llm = new QueueLLM([fillPlan("#email", "#go"), fillPlan("#email", "#go")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(steps.some((s) => /submit_disabled/i.test(s))).toBe(true);
  });

  // Paddle regression: a multi-step SPA where an earlier action advances
  // the page, so the submit selector that resolved at plan-time has
  // vanished by click-time. clickSubmit throws a Playwright visibility
  // timeout. Pre-fix this returned submit_failed and ended the run; now
  // it re-plans against the now-current page and submits cleanly.
  it("re-plans when the submit selector went stale (Playwright timeout), instead of failing", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      // Round 1: a "Continue" button the planner submits to — but the
      // click advances the SPA and this selector then vanishes.
      [
        mk({ tag: "input", type: "checkbox", labelText: "I agree", selector: "#agree" }),
        mk({ tag: "button", visibleText: "Continue", selector: "#step1-continue" }),
      ],
      // Round 2: the genuinely-final form on the advanced page.
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    let submitCalls = 0;
    browser.clickSubmitImpl = () => {
      submitCalls += 1;
      if (submitCalls === 1) {
        throw new Error(
          "locator.waitFor: Timeout 20000ms exceeded.\nCall log:\n  - waiting for locator('#step1-continue') to be visible",
        );
      }
    };
    const llm = new QueueLLM([
      fillPlan("#agree", "#step1-continue"),
      fillPlan("#email", "#go"),
    ]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submitted");
    expect(steps.some((s) => /went stale/i.test(s))).toBe(true);
    expect(llm.calls).toBe(2); // re-planned once after the stale submit
  });

  // The carve-out is precise: a non-timeout submit click failure (e.g.
  // an ambiguous selector matched several buttons, none disambiguated)
  // is a genuine failure and still ends the run — it is NOT a stale-
  // selector re-plan.
  it("still fails submit_failed on a genuine (non-timeout) submit error", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    browser.clickSubmitImpl = () => {
      throw new Error(
        'submit selector "#go" matched 3 buttons, none scoring as a signup button',
      );
    };
    const llm = new QueueLLM([fillPlan("#email", "#go")]);

    const { outcome, steps } = await runLoop(browser, llm);

    expect(outcome.kind).toBe("submit_failed");
    expect(steps.some((s) => /submit click failed/i.test(s))).toBe(true);
  });

  // OAuth click-through: a "Sign In to Continue" interstitial (Qdrant's
  // session-expiry redirect) gates the provider buttons. The OAuth-first
  // scan finds no provider affordance on round 1; the bot must CLICK the
  // generic sign-in button to advance, then take the OAuth path on the
  // revealed page — instead of bailing oauth_required. `oauthProvider`
  // is pinned so the loop has a non-empty candidate list even with no
  // host Google session (loggedInProviders is mocked to []).
  it("clicks a 'Sign In to Continue' interstitial through to the revealed OAuth page", async () => {
    const browser = new FakeBrowser();
    const interstitial = mk({
      tag: "button",
      role: "button",
      visibleText: "Sign In to Continue",
      selector: "#signin",
    });
    const googleBtn = mk({
      tag: "button",
      visibleText: "Continue with Google",
      selector: "#google",
    });
    // The page reveals the Google button only AFTER the interstitial is
    // clicked — async-render retries before the click keep seeing only
    // the "Sign In to Continue" button (the Qdrant behaviour). Model it
    // off the click recorder rather than the per-call queue so the
    // retries don't advance the page on their own.
    browser.extractInteractiveElements = async () =>
      browser.clicked.includes("#signin") ? [googleBtn] : [interstitial];
    const llm = new QueueLLM(["{}"]);

    const { outcome, steps } = await runLoop(browser, llm, {
      oauthProvider: "google",
    });

    expect(outcome.kind).toBe("oauth");
    expect((outcome as { selector?: string }).selector).toBe("#google");
    // It clicked the interstitial button to advance.
    expect(browser.clicked).toContain("#signin");
    expect(steps.some((s) => /clicking it to advance to the real login/i.test(s))).toBe(true);
    // No planner call — this is all pre-form-fill.
    expect(llm.calls).toBe(0);
  });

  // A genuine form page is unchanged: no provider affordance, no sign-in
  // interstitial — the bot fills the form, never click-throughs.
  it("does NOT click-through on a real signup form (form-fill path unchanged)", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    const llm = new QueueLLM([fillPlan("#email", "#go")]);

    const { outcome, steps } = await runLoop(browser, llm, {
      oauthProvider: "google",
    });

    expect(outcome.kind).toBe("submitted");
    expect(browser.clicked).not.toContain("#signin");
    expect(steps.some((s) => /clicking it to advance/i.test(s))).toBe(false);
  });

  // Enterprise-SSO-only / no recoverable affordance: the page keeps
  // showing a sign-in button that never reveals a provider button (a
  // redirect loop / true SSO-only). The bounded click-through must give
  // up and still return oauth_required rather than clicking forever.
  it("still returns oauth_required when the interstitial never reveals a provider button", async () => {
    const browser = new FakeBrowser();
    // Every round serves the same lone sign-in button — clicking never
    // advances to a provider affordance.
    browser.inventoryQueue = [
      [
        mk({
          tag: "button",
          role: "button",
          visibleText: "Sign In to Continue",
          selector: "#signin",
        }),
      ],
    ];
    const llm = new QueueLLM(["{}"]);

    const { outcome, steps } = await runLoop(browser, llm, {
      oauthProvider: "google",
    });

    expect(outcome.kind).toBe("oauth_required");
    // It tried the click-through, but the cap (2) stopped it.
    expect(browser.clicked.filter((s) => s === "#signin").length).toBe(2);
    expect(llm.calls).toBe(0);
  });
});

// Fix C — the form-fill planner (planSignupForm, reached via
// planExecuteWithRetry) must mark its LLM call deterministic:true so the
// proxy pins a single model + provider + seed. temperature 0 alone leaves
// the model/provider lottery in play.
describe("planner call sites set deterministic=true (Fix C)", () => {
  // Records every request the planner sends so the test can assert the
  // deterministic flag rode along.
  class RecordingLLM implements LLMClient {
    readonly name = "recording";
    public requests: import("../llm-client.js").LLMRequest[] = [];
    constructor(private readonly reply: string) {}
    async createMessage(
      req: import("../llm-client.js").LLMRequest,
    ): Promise<LLMResponse> {
      this.requests.push(req);
      return { text: this.reply, backend: this.name };
    }
  }

  it("planSignupForm sends deterministic=true + temperature 0", async () => {
    const browser = new FakeBrowser();
    browser.inventoryQueue = [
      [
        mk({ tag: "input", type: "email", id: "email", selector: "#email" }),
        mk({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
    ];
    const llm = new RecordingLLM(fillPlan("#email", "#go"));
    const asController: unknown = browser;
    if (!isController(asController)) throw new Error("unreachable");
    const agent = new SignupAgent(asController, llm);
    const fillValues = {
      email: "bot@inbox.test",
      password: "Pw-test-12345",
      name: "Test Bot",
      username: "testbot12",
      company: "Trusty Squire",
      literal: "",
    };
    const fn = (
      agent as unknown as {
        planExecuteWithRetry: (
          t: { service: string; email: string },
          fv: typeof fillValues,
          s: string[],
        ) => Promise<Outcome>;
      }
    ).planExecuteWithRetry.bind(agent);
    await fn({ service: "Test", email: "bot@inbox.test" }, fillValues, []);

    expect(llm.requests.length).toBeGreaterThan(0);
    const first = llm.requests[0]!;
    expect(first.deterministic).toBe(true);
    expect(first.temperature).toBe(0);
  });
});
