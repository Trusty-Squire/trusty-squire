// Post-OAuth recovery — findSignupCtaElement. The amplitude case: after
// Google OAuth the service lands on a LOGIN page that also carries an
// in-page "Sign up for free" CTA (the identity has no account yet). We
// must surface the SIGNUP affordance — not the "Sign in" submit button
// and not the "Continue with Google" OAuth button (which would loop) —
// so the post-OAuth recovery can click it and re-route into form-fill.

import { describe, expect, it } from "vitest";
import { type InteractiveElement } from "../browser.js";
import { findSignupCtaElement } from "../agent.js";

// Same fixture helper as the other inventory tests — defaults filled in
// so each case expresses only the fields it cares about.
function mk(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "div",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "div",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

describe("findSignupCtaElement (post-OAuth login page with a signup CTA)", () => {
  it("returns the signup anchor on an amplitude-style login page", () => {
    const inventory = [
      mk({ tag: "button", visibleText: "Continue with Google", selector: "button.google" }),
      mk({ tag: "input", type: "password", selector: "input#password" }),
      mk({ tag: "button", visibleText: "Sign in", selector: "button[type=submit]" }),
      mk({ tag: "a", visibleText: "Sign up for free", selector: "a.signup" }),
    ];
    const cta = findSignupCtaElement(inventory);
    expect(cta).not.toBeNull();
    expect(cta?.selector).toBe("a.signup");
  });

  it("matches a 'Create an account' button via visible text", () => {
    const inventory = [
      mk({ tag: "button", visibleText: "Sign in", selector: "button#login" }),
      mk({ tag: "button", visibleText: "Create an account", selector: "button#create" }),
    ];
    expect(findSignupCtaElement(inventory)?.selector).toBe("button#create");
  });

  it("matches a signup affordance via aria-label", () => {
    const inventory = [
      mk({ tag: "a", ariaLabel: "Register for a new account", selector: "a#reg" }),
    ];
    expect(findSignupCtaElement(inventory)?.selector).toBe("a#reg");
  });

  it("returns null for a login-only inventory (no signup affordance)", () => {
    const inventory = [
      mk({ tag: "input", type: "password", selector: "input#password" }),
      mk({ tag: "button", visibleText: "Sign in", selector: "button[type=submit]" }),
      mk({ tag: "a", visibleText: "Forgot your password?", selector: "a.forgot" }),
    ];
    expect(findSignupCtaElement(inventory)).toBeNull();
  });

  it("returns null for an OAuth-only inventory (excludes 'Continue with Google')", () => {
    // The exact regression we guard against: a service that genuinely needs
    // a second OAuth click must NOT be read as a signup CTA, so the caller
    // falls through to the re-OAuth path.
    const inventory = [
      mk({ tag: "button", visibleText: "Continue with Google", selector: "button.google" }),
      mk({ tag: "button", visibleText: "Sign in with GitHub", selector: "button.github" }),
    ];
    expect(findSignupCtaElement(inventory)).toBeNull();
  });

  it("ignores a non-clickable div even when its text reads as signup", () => {
    const inventory = [
      mk({ tag: "div", visibleText: "Sign up for free", selector: "div.promo" }),
    ];
    expect(findSignupCtaElement(inventory)).toBeNull();
  });

  it("prefers an anchor/button over a role=button div", () => {
    const inventory = [
      mk({ tag: "div", role: "button", visibleText: "Sign up", selector: "div[role=button]" }),
      mk({ tag: "a", visibleText: "Sign up for free", selector: "a.signup" }),
    ];
    expect(findSignupCtaElement(inventory)?.selector).toBe("a.signup");
  });
});
