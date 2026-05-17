// Covers parseSignupPlan / parsePostVerifyStep — the validators that
// stand between untrusted LLM output and the browser executor. Every
// field a later executor reads (selector, value_kind, url, ...) must
// be validated here; a malformed reply MUST throw so callLLM can
// trigger the premium-fallback retry.

import { describe, expect, it } from "vitest";
import { parseSignupPlan, parsePostVerifyStep } from "../agent.js";

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

  it("rejects an unknown step kind", () => {
    const raw = JSON.stringify({ kind: "teleport", reason: "" });
    expect(() => parsePostVerifyStep(raw)).toThrow(/unknown kind/i);
  });
});
