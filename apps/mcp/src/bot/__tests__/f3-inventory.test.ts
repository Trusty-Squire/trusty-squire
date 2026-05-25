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
import {
  detectOAuthProvidersInInventory,
  formatInventory,
  isOauthOnlyChooser,
  parseSignupPlan,
} from "../agent.js";

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

  // rc.30 — combined login/signup-via-email path: services like
  // Railway, Vercel, Cloudflare ship one button that handles both
  // first-time signup AND returning login. Pre-rc.30 the "log in"
  // penalty drove "Log in using email" to negative, dropping it from
  // the inventory; the planner then had no email-button selector and
  // misclicked the footer "Email" contact link instead. Now the
  // auth-verb penalty is suppressed when "email" is present.
  it("keeps Log-in-with-email buttons positive (rc.30)", () => {
    // The Railway regression: "Log in using email" must outrank
    // generic nav anchors (score 0) so it survives ranking caps.
    expect(scoreSignupButton("Log in using email")).toBeGreaterThan(0);
    expect(scoreSignupButton("Sign in with email")).toBeGreaterThan(0);
    expect(scoreSignupButton("Continue with email")).toBeGreaterThan(0);
    // Without email, the penalty still applies — a bare "Sign in"
    // button is still the wrong target on a signup page.
    expect(scoreSignupButton("Sign in")).toBeLessThan(0);
    expect(scoreSignupButton("Log in")).toBeLessThan(0);
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

  // Railway regression (rc.12): a <select> whose first option has
  // value="" is the React-form-state-untouched pattern that silently
  // breaks submit. The planner needs to see the defaulted marker AND
  // the option list to know what to commit before clicking submit.
  it("flags a defaulted <select> with DEFAULTED marker + option list", () => {
    const out = formatInventory([
      mk({
        tag: "select",
        name: "workspaceId",
        selector: "select[name=\"workspaceId\"]",
        value: "",
        selectedOptionText: "No workspace",
        selectOptions: [
          { value: "", text: "No workspace" },
          { value: "uuid-1", text: "Acme Inc" },
        ],
      }),
    ]);
    expect(out).toContain("DEFAULTED");
    expect(out).toContain("\"No workspace\"");
    expect(out).toContain("options=");
    expect(out).toContain("\"Acme Inc\"");
  });

  it("F15: adds landmark=<x> to text-duplicates so the planner can pick the right one", () => {
    // The Railway pattern that motivated F15 — "Email" appears twice
    // on the page (body CTA + footer link). Both anchor tags share
    // the same visibleText; without landmark disambiguation the
    // planner picked the wrong one and looped on no-progress.
    const out = formatInventory([
      mk({
        tag: "a",
        visibleText: "Email",
        landmark: "main",
        selector: "#body-cta",
      }),
      mk({
        tag: "a",
        visibleText: "Email",
        landmark: "footer",
        selector: "#footer-link",
      }),
    ]);
    expect(out).toContain("landmark=main");
    expect(out).toContain("landmark=footer");
  });

  it("F15: does NOT add landmark on a unique-text element (terse default)", () => {
    const out = formatInventory([
      mk({
        tag: "a",
        visibleText: "Email",
        landmark: "main",
        selector: "#solo",
      }),
      mk({
        tag: "a",
        visibleText: "Pricing",
        landmark: "main",
        selector: "#pricing",
      }),
    ]);
    expect(out).not.toContain("landmark=");
  });

  it("F15: tolerates missing landmark on a duplicated element (no landmark = no tag)", () => {
    const out = formatInventory([
      mk({ tag: "a", visibleText: "Email", selector: "#one" }),
      mk({ tag: "a", visibleText: "Email", landmark: "footer", selector: "#two" }),
    ]);
    // The element with a landmark gets tagged; the one without is
    // unchanged (it just looks like the other "Email" but with no
    // disambiguator — graceful degrade, not a crash).
    expect(out).toContain("landmark=footer");
    expect(out.split("\n")[0]).not.toContain("landmark=");
  });

  it("does NOT flag a <select> whose user already picked a real option", () => {
    const out = formatInventory([
      mk({
        tag: "select",
        name: "workspaceId",
        selector: "select[name=\"workspaceId\"]",
        value: "uuid-1",
        selectedOptionText: "Acme Inc",
        selectOptions: [
          { value: "", text: "No workspace" },
          { value: "uuid-1", text: "Acme Inc" },
        ],
      }),
    ]);
    expect(out).not.toContain("DEFAULTED");
    expect(out).toContain("selected=\"Acme Inc\"");
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

describe("detectOAuthProvidersInInventory (needs_oauth_provider_session)", () => {
  it("finds both Google and GitHub when both buttons are present", () => {
    const out = detectOAuthProvidersInInventory([
      mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" }),
      mk({ tag: "button", visibleText: "Log in using GitHub", selector: "#h" }),
    ]);
    expect(out.sort()).toEqual(["github", "google"]);
  });

  it("returns just GitHub when only a GitHub link is visible (Railway pattern)", () => {
    const out = detectOAuthProvidersInInventory([
      mk({ tag: "button", visibleText: "Log in using GitHub", selector: "#h" }),
      mk({ tag: "button", visibleText: "Log in using SSO", selector: "#sso" }),
    ]);
    expect(out).toEqual(["github"]);
  });

  it("detects OAuth via href pattern even when the visible text is generic", () => {
    const out = detectOAuthProvidersInInventory([
      mk({
        tag: "a",
        visibleText: "Sign in",
        href: "/auth/google?return_to=/dashboard",
        selector: "#login-link",
      }),
    ]);
    expect(out).toEqual(["google"]);
  });

  it("returns empty when nothing OAuth-shaped is on the page", () => {
    expect(
      detectOAuthProvidersInInventory([
        mk({ tag: "input", type: "email", selector: "#email" }),
        mk({ tag: "button", visibleText: "Sign up", selector: "#go" }),
      ]),
    ).toEqual([]);
  });

  it("does not match nav links that merely mention a provider name", () => {
    // findOAuthButton requires an auth verb alongside the provider
    // keyword — "GitHub Compliance" footer link must NOT register.
    expect(
      detectOAuthProvidersInInventory([
        mk({ tag: "a", visibleText: "GitHub Compliance", href: "/policy", selector: "#policy" }),
      ]),
    ).toEqual([]);
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
