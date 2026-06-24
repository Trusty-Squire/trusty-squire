// pickFormSubmitSelector — the recovery target when the planner hallucinates a
// submit_selector (MEASURED 2026-06-23, huggingface: the planner kept emitting a
// generic "div > form > button" not in the inventory → planning_failed).

import { describe, expect, it } from "vitest";
import { pickFormSubmitSelector, parseSignupPlan } from "../agent.js";
import type { InteractiveElement } from "../browser.js";

const btn = (over: Partial<InteractiveElement>): InteractiveElement =>
  ({ tag: "button", selector: "x", ...over }) as InteractiveElement;

describe("pickFormSubmitSelector", () => {
  it("picks the bare 'Next' submit over a long agreement button", () => {
    const inv = [
      btn({ visibleText: "Next", selector: "form > button.next" }),
      btn({ visibleText: "By continuing you agree to the Terms", selector: "form > a" }),
    ];
    expect(pickFormSubmitSelector(inv)).toBe("form > button.next");
  });

  it("matches Create account / Sign up / Join", () => {
    expect(
      pickFormSubmitSelector([btn({ visibleText: "Create account", selector: "s1" })]),
    ).toBe("s1");
    expect(
      pickFormSubmitSelector([btn({ visibleText: "Join Hugging Face", selector: "s2" })]),
    ).toBe("s2");
  });

  it("ignores non-button elements and unrelated buttons", () => {
    const inv = [
      btn({ tag: "input", type: "email", visibleText: "", selector: "i1" }),
      btn({ visibleText: "Read the docs", selector: "b1" }),
    ];
    expect(pickFormSubmitSelector(inv)).toBeNull();
  });
});

describe("parseSignupPlan — submit_selector fallback", () => {
  const allowed = new Set(["#email", "#pw", "form > button.next"]);
  const raw = JSON.stringify({
    actions: [
      { kind: "fill", selector: "#email", value_kind: "email", reason: "email" },
      { kind: "fill", selector: "#pw", value_kind: "password", reason: "pw" },
    ],
    submit_selector: "div > form > button",
    confidence: "high",
  });

  it("substitutes the fallback when submit_selector is hallucinated", () => {
    const plan = parseSignupPlan(raw, allowed, "form > button.next");
    expect(plan.submit_selector).toBe("form > button.next");
  });

  it("still throws when no valid fallback is available", () => {
    expect(() => parseSignupPlan(raw, allowed)).toThrow(/not in the page inventory/);
    expect(() => parseSignupPlan(raw, allowed, "div > nope")).toThrow(
      /not in the page inventory/,
    );
  });

  it("does NOT override a valid planner submit_selector", () => {
    const good = JSON.stringify({
      actions: [{ kind: "fill", selector: "#email", value_kind: "email", reason: "e" }],
      submit_selector: "form > button.next",
      confidence: "high",
    });
    expect(parseSignupPlan(good, allowed, "#email").submit_selector).toBe(
      "form > button.next",
    );
  });
});
