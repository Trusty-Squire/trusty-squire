// F3 — the DOM-grounded element inventory. These cover the pure
// logic the planner/executor reliability rework rests on: button
// scoring, the rank-and-cap that must never truncate a real form
// field, the planner-facing inventory text, the OAuth-only detector,
// and the parse-time inventory-membership check that makes selector
// hallucination impossible.

import { describe, expect, it } from "vitest";
import {
  scoreSignupButton,
  rankAndCapInventory,
  type InteractiveElement,
} from "../browser.js";
import { formatInventory, isOauthOnlyChooser, parseSignupPlan } from "../agent.js";

// Build an InteractiveElement with sane defaults — tests override
// only the fields they care about.
function mk(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "input",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

describe("scoreSignupButton", () => {
  it("scores account-creation text positive", () => {
    expect(scoreSignupButton("Create account")).toBeGreaterThan(0);
    expect(scoreSignupButton("Sign up")).toBeGreaterThan(0);
    expect(scoreSignupButton("Sign up with email")).toBeGreaterThan(0);
  });

  it("drives OAuth provider buttons firmly negative", () => {
    expect(scoreSignupButton("Continue with Google")).toBeLessThan(0);
    expect(scoreSignupButton("Sign up with GitHub")).toBeLessThan(0);
  });

  it("drives sign-in negative so it never wins over signup", () => {
    expect(scoreSignupButton("Sign in")).toBeLessThan(0);
    expect(scoreSignupButton("Create account")).toBeGreaterThan(
      scoreSignupButton("Log in"),
    );
  });
});

describe("rankAndCapInventory", () => {
  it("keeps every input even when buttons are capped", () => {
    const inputs = Array.from({ length: 6 }, (_, i) =>
      mk({ tag: "input", type: "text", selector: `#in${i}` }),
    );
    const buttons = Array.from({ length: 40 }, (_, i) =>
      mk({ tag: "button", type: "button", visibleText: `nav ${i}`, selector: `#b${i}` }),
    );
    const { inventory, buttonsDropped } = rankAndCapInventory(
      [...inputs, ...buttons],
      25,
    );
    // All 6 inputs survive; buttons capped at 25.
    expect(inventory.filter((e) => e.tag === "input")).toHaveLength(6);
    expect(inventory.filter((e) => e.tag === "button")).toHaveLength(25);
    expect(buttonsDropped).toBe(15);
  });

  it("ranks the signup button above nav noise", () => {
    const els = [
      mk({ tag: "button", visibleText: "About", selector: "#about" }),
      mk({ tag: "button", visibleText: "Create account", selector: "#go" }),
      mk({ tag: "button", visibleText: "Pricing", selector: "#price" }),
    ];
    const { inventory } = rankAndCapInventory(els, 1);
    // Only one button survives the cap — it must be the signup one.
    expect(inventory.filter((e) => e.tag === "button")).toEqual([
      expect.objectContaining({ selector: "#go" }),
    ]);
  });

  it("re-indexes the kept set contiguously", () => {
    const { inventory } = rankAndCapInventory(
      [mk({ selector: "#a" }), mk({ selector: "#b" })],
    );
    expect(inventory.map((e) => e.index)).toEqual([0, 1]);
  });
});

describe("formatInventory", () => {
  it("emits one line per element ending with the selector", () => {
    const out = formatInventory([
      mk({ tag: "input", type: "email", name: "email", selector: "#email" }),
    ]);
    expect(out).toContain("selector=#email");
    expect(out).toContain("type=email");
  });

  it("marks cookie-consent elements so the planner avoids them", () => {
    const out = formatInventory([
      mk({ tag: "input", type: "checkbox", inConsentWidget: true, selector: "#c" }),
    ]);
    expect(out).toContain("[cookie-consent — avoid]");
  });
});

describe("isOauthOnlyChooser", () => {
  it("is false when the page has a fillable email input", () => {
    expect(
      isOauthOnlyChooser([mk({ tag: "input", type: "email", selector: "#e" })]),
    ).toBe(false);
  });

  it("is true when only OAuth buttons exist — no form, no email option", () => {
    expect(
      isOauthOnlyChooser([
        mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" }),
        mk({ tag: "button", visibleText: "Continue with GitHub", selector: "#h" }),
      ]),
    ).toBe(true);
  });

  it("is false when an email-signup button is present (two-stage chooser)", () => {
    expect(
      isOauthOnlyChooser([
        mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" }),
        mk({ tag: "button", visibleText: "Sign up with email", selector: "#e" }),
      ]),
    ).toBe(false);
  });
});

describe("parseSignupPlan — inventory-membership validation", () => {
  const planJson = (selector: string, submit: string): string =>
    JSON.stringify({
      actions: [{ kind: "fill", selector, value_kind: "email", reason: "email" }],
      submit_selector: submit,
      confidence: "high",
    });

  it("accepts a plan whose selectors are all in the inventory", () => {
    const allowed = new Set(["#email", "#go"]);
    const plan = parseSignupPlan(planJson("#email", "#go"), allowed);
    expect(plan.actions[0]?.selector).toBe("#email");
  });

  it("rejects an action selector not in the inventory", () => {
    const allowed = new Set(["#email", "#go"]);
    expect(() => parseSignupPlan(planJson("#hallucinated", "#go"), allowed)).toThrow(
      /not in the page inventory/,
    );
  });

  it("rejects a submit_selector not in the inventory", () => {
    const allowed = new Set(["#email"]);
    expect(() => parseSignupPlan(planJson("#email", "#guessed"), allowed)).toThrow(
      /not in the page inventory/,
    );
  });

  it("rejects an invalid :contains() selector — it is not in the inventory", () => {
    const allowed = new Set(["#email", "#go"]);
    expect(() =>
      parseSignupPlan(planJson("button:contains('Sign up')", "#go"), allowed),
    ).toThrow(/not in the page inventory/);
  });

  it("skips the membership check when no inventory is supplied", () => {
    // Back-compat: the post-verify / dual-mode callers pass no set.
    const plan = parseSignupPlan(planJson("#anything", "#whatever"));
    expect(plan.submit_selector).toBe("#whatever");
  });
});
