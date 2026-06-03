// Covers parseSignupPlan / parsePostVerifyStep — the validators that
// stand between untrusted LLM output and the browser executor. Every
// field a later executor reads (selector, value_kind, url, ...) must
// be validated here; a malformed reply MUST throw so callLLM can
// trigger the premium-fallback retry.

import { describe, expect, it } from "vitest";
import { parseSignupPlan, parsePostVerifyStep, isSubmitTimeout } from "../agent.js";

describe("parseSignupPlan — valid input", () => {
  it("parses a well-formed plan", () => {
    const raw = JSON.stringify({
      actions: [
        { kind: "fill", selector: "#email", value_kind: "email", reason: "the email field" },
        { kind: "check", selector: "#tos", reason: "accept terms" },
        { kind: "click", selector: "#cookies", reason: "dismiss banner" },
      ],
      submit_selector: "#submit",
      confidence: "high",
    });
    const plan = parseSignupPlan(raw);
    expect(plan.actions).toHaveLength(3);
    expect(plan.submit_selector).toBe("#submit");
    expect(plan.confidence).toBe("high");
  });

  it("tolerates a markdown-fenced reply", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        actions: [{ kind: "fill", selector: "#email", value_kind: "email", reason: "" }],
        submit_selector: "#go",
        confidence: "low",
      }) +
      "\n```";
    expect(parseSignupPlan(raw).submit_selector).toBe("#go");
  });

  it("preserves the literal value on a literal fill action", () => {
    const raw = JSON.stringify({
      actions: [
        { kind: "fill", selector: "#code", value_kind: "literal", literal: "INVITE99", reason: "" },
      ],
      submit_selector: "#submit",
      confidence: "medium",
    });
    const action = parseSignupPlan(raw).actions[0];
    expect(action).toEqual({
      kind: "fill",
      selector: "#code",
      value_kind: "literal",
      literal: "INVITE99",
      reason: "",
    });
  });
});

describe("parseSignupPlan — rejection", () => {
  it("rejects a fill action with no selector", () => {
    const raw = JSON.stringify({
      actions: [{ kind: "fill", value_kind: "email", reason: "" }],
      submit_selector: "#submit",
      confidence: "high",
    });
    expect(() => parseSignupPlan(raw)).toThrow(/selector/i);
  });

  it("rejects a fill action with an unknown value_kind", () => {
    const raw = JSON.stringify({
      actions: [{ kind: "fill", selector: "#x", value_kind: "captcha", reason: "" }],
      submit_selector: "#submit",
      confidence: "high",
    });
    expect(() => parseSignupPlan(raw)).toThrow(/value_kind/i);
  });

  it("rejects a literal fill action missing its literal value", () => {
    const raw = JSON.stringify({
      actions: [{ kind: "fill", selector: "#x", value_kind: "literal", reason: "" }],
      submit_selector: "#submit",
      confidence: "high",
    });
    expect(() => parseSignupPlan(raw)).toThrow(/literal/i);
  });

  it("rejects an action with an unknown kind", () => {
    const raw = JSON.stringify({
      actions: [{ kind: "scroll", selector: "#x", reason: "" }],
      submit_selector: "#submit",
      confidence: "high",
    });
    expect(() => parseSignupPlan(raw)).toThrow(/unknown kind/i);
  });

  it("rejects a plan with no actions array", () => {
    const raw = JSON.stringify({ submit_selector: "#submit", confidence: "high" });
    expect(() => parseSignupPlan(raw)).toThrow(/actions/i);
  });

  it("rejects a plan with an empty submit_selector", () => {
    const raw = JSON.stringify({ actions: [], submit_selector: "", confidence: "high" });
    expect(() => parseSignupPlan(raw)).toThrow(/submit_selector/i);
  });

  it("rejects a plan with an invalid confidence value", () => {
    const raw = JSON.stringify({
      actions: [],
      submit_selector: "#submit",
      confidence: "very-high",
    });
    expect(() => parseSignupPlan(raw)).toThrow(/confidence/i);
  });

  it("rejects a reply with no JSON object", () => {
    expect(() => parseSignupPlan("I cannot help with that.")).toThrow(/no JSON/i);
  });

  it("rejects a reply whose JSON is malformed", () => {
    expect(() => parseSignupPlan("{ actions: [ unbalanced")).toThrow();
  });
});

describe("parsePostVerifyStep — valid input", () => {
  it("parses a done step", () => {
    const raw = JSON.stringify({ kind: "done", reason: "phone wall" });
    expect(parsePostVerifyStep(raw)).toEqual({ kind: "done", reason: "phone wall" });
  });

  it("parses a click step", () => {
    const raw = JSON.stringify({ kind: "click", selector: ".api-keys", reason: "open" });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "click",
      selector: ".api-keys",
      reason: "open",
    });
  });

  it("parses a wait step with numeric seconds", () => {
    const raw = JSON.stringify({ kind: "wait", seconds: 3, reason: "loading" });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "wait",
      seconds: 3,
      reason: "loading",
    });
  });

  it("parses a login step", () => {
    const raw = JSON.stringify({ kind: "login", reason: "signed out — login wall" });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "login",
      reason: "signed out — login wall",
    });
  });

  it("parses a check step", () => {
    const raw = JSON.stringify({ kind: "check", selector: "#tos", reason: "accept terms" });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "check",
      selector: "#tos",
      reason: "accept terms",
    });
  });

  // F11
  it("parses a select step WITHOUT option_text (first-option behavior)", () => {
    const raw = JSON.stringify({
      kind: "select",
      selector: "#region",
      reason: "pick a region",
    });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "select",
      selector: "#region",
      reason: "pick a region",
    });
  });

  it("parses a select step WITH option_text — F11 combobox value matching", () => {
    const raw = JSON.stringify({
      kind: "select",
      selector: "[role='combobox']#permission",
      option_text: "Project: Read",
      reason: "Sentry combobox permissions",
    });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "select",
      selector: "[role='combobox']#permission",
      option_text: "Project: Read",
      reason: "Sentry combobox permissions",
    });
  });

  it("parses a scroll step WITHOUT selector — auto-detect path", () => {
    // The canonical Railway-style ToS-modal case: the scrollable
    // container is a div not in the inventory, so the planner omits
    // selector and the bot auto-detects.
    const raw = JSON.stringify({
      kind: "scroll",
      reason: "scroll ToS to enable Accept",
    });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "scroll",
      reason: "scroll ToS to enable Accept",
    });
  });

  it("parses a scroll step WITH selector and does NOT inventory-check it", () => {
    // The scrollable container is rarely interactive, so a scroll
    // selector should not be rejected when missing from the inventory.
    const raw = JSON.stringify({
      kind: "scroll",
      selector: ".tos-modal-body",
      reason: "scroll ToS",
    });
    const allowed = new Set<string>(); // intentionally empty
    expect(parsePostVerifyStep(raw, allowed)).toEqual({
      kind: "scroll",
      selector: ".tos-modal-body",
      reason: "scroll ToS",
    });
  });

  it("treats an empty-string scroll selector as absent", () => {
    const raw = JSON.stringify({ kind: "scroll", selector: "", reason: "" });
    expect(parsePostVerifyStep(raw)).toEqual({ kind: "scroll", reason: "" });
  });

  it("treats an empty-string option_text as absent", () => {
    // A model emitting `"option_text": ""` would otherwise be saying
    // "match an option whose text contains the empty string" — every
    // option matches, behavior identical to omitting it. Normalize to
    // omit so the executor's "first option" fallback fires cleanly.
    const raw = JSON.stringify({
      kind: "select",
      selector: "#x",
      option_text: "",
      reason: "",
    });
    expect(parsePostVerifyStep(raw)).toEqual({
      kind: "select",
      selector: "#x",
      reason: "",
    });
  });
});

describe("parsePostVerifyStep — rejection", () => {
  it("rejects a click step with no selector", () => {
    const raw = JSON.stringify({ kind: "click", reason: "open" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/selector/i);
  });

  it("rejects a fill step missing its value", () => {
    const raw = JSON.stringify({ kind: "fill", selector: "#name", reason: "" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/value/i);
  });

  it("rejects a navigate step with no url", () => {
    const raw = JSON.stringify({ kind: "navigate", reason: "go" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/url/i);
  });

  it("rejects a wait step with non-numeric seconds", () => {
    const raw = JSON.stringify({ kind: "wait", seconds: "soon", reason: "" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/seconds/i);
  });

  it("rejects a check step with no selector", () => {
    const raw = JSON.stringify({ kind: "check", reason: "accept terms" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/selector/i);
  });

  it("rejects an unknown step kind", () => {
    const raw = JSON.stringify({ kind: "teleport", reason: "" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/unknown kind/i);
  });
});

describe("isSubmitTimeout — stale-submit-selector recovery (Paddle)", () => {
  it("matches a Playwright locator.waitFor visibility timeout", () => {
    // The exact shape Paddle produced: a "Continue" click advanced the
    // SPA, so clickSubmit's locator never became visible.
    const reason =
      "locator.waitFor: Timeout 20000ms exceeded.\n" +
      "Call log:\n  - waiting for locator('div > main > div:nth-of-type(2) > button') to be visible";
    expect(isSubmitTimeout(reason)).toBe(true);
  });

  it("matches a waitForSelector timeout", () => {
    expect(
      isSubmitTimeout("page.waitForSelector: Timeout 10000ms exceeded. waiting for selector"),
    ).toBe(true);
  });

  it("does NOT match submit_disabled (handled by its own re-plan path)", () => {
    expect(
      isSubmitTimeout(
        "submit_disabled: the submit button (#go) is disabled — a required field or agreement checkbox was not satisfied",
      ),
    ).toBe(false);
  });

  it("does NOT match a genuine ambiguous-selector failure", () => {
    expect(
      isSubmitTimeout('submit selector "#go" matched 3 buttons, none scoring as a signup button'),
    ).toBe(false);
  });

  it("does NOT match an arbitrary non-timeout error", () => {
    expect(isSubmitTimeout("Browser not started")).toBe(false);
  });
});
