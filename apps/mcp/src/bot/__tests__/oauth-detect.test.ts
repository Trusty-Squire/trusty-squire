// Unit tests for the browser-free OAuth/auth-state predicates carved out
// of the retired universal-bot monolith into oauth-detect.ts:
//   - findOAuthButton: locate a "Sign in with <provider>" affordance in a
//     page inventory (href / icon-only / text+verb signals).
//   - detectAlreadySignedIn: decide whether a page is a post-login surface
//     (no credential input + a positive auth signal).

import { describe, expect, it } from "vitest";
import { findOAuthButton, detectAlreadySignedIn } from "../oauth-detect.js";
import type { InteractiveElement } from "../browser.js";

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

describe("findOAuthButton", () => {
  it("matches a 'Continue with Google' button", () => {
    const btn = mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" });
    expect(findOAuthButton([btn], "google")?.selector).toBe("#g");
  });

  it("matches a 'Sign up with Google' link and an aria-labelled icon button", () => {
    const link = mk({ tag: "a", visibleText: "Sign up with Google", selector: "#a" });
    const icon = mk({ tag: "button", ariaLabel: "Sign in with Google", selector: "#b" });
    expect(findOAuthButton([link], "google")?.selector).toBe("#a");
    expect(findOAuthButton([icon], "google")?.selector).toBe("#b");
  });

  it("matches the requested provider only ('Continue with GitHub')", () => {
    const gh = mk({ tag: "button", visibleText: "Continue with GitHub", selector: "#gh" });
    expect(findOAuthButton([gh], "github")?.selector).toBe("#gh");
    // ...but not when the requested provider is Google.
    expect(findOAuthButton([gh], "google")).toBeNull();
  });

  it("matches an icon-only button named only by a descendant img alt (Mistral)", () => {
    // <button><img alt="Google"></button> — no text, no aria-label.
    const iconBtn = mk({ tag: "button", iconLabel: "Google", selector: "#sso-g" });
    expect(findOAuthButton([iconBtn], "google")?.selector).toBe("#sso-g");
    // The sibling Apple icon button must not match.
    const apple = mk({ tag: "button", iconLabel: "Apple", selector: "#sso-a" });
    expect(findOAuthButton([apple], "google")).toBeNull();
  });

  it("matches an <a> by an OAuth href even with no visible text (Sentry)", () => {
    const oauthLink = mk({
      tag: "a",
      visibleText: "",
      href: "https://sentry.io/identity/login/google/?href=https%3A%2F%2Fsentry.io%2Fsignup",
      selector: "#oauth-a",
    });
    expect(findOAuthButton([oauthLink], "google")?.selector).toBe("#oauth-a");
  });

  it("rejects a policy link to the provider's own domain", () => {
    // policies.google.com/privacy names Google and is an <a>, but its
    // href does not route through an OAuth endpoint.
    const policy = mk({
      tag: "a",
      visibleText: "Google's Privacy Policy",
      href: "https://policies.google.com/privacy",
      selector: "#pp",
    });
    expect(findOAuthButton([policy], "google")).toBeNull();
  });

  it("ignores a non-auth link that merely mentions the provider", () => {
    const docs = mk({ tag: "a", visibleText: "Powered by Google Cloud", selector: "#d" });
    expect(findOAuthButton([docs], "google")).toBeNull();
    const ghDocs = mk({ tag: "a", visibleText: "View on GitHub", selector: "#g" });
    expect(findOAuthButton([ghDocs], "github")).toBeNull();
  });

  it("rejects a card-wrapper <a> whose visible text exceeds the button-length cap (OpenRouter rc.12)", () => {
    // OpenRouter wraps a model-showcase card in an <a>; a descendant <img alt>
    // surfaced "Google" via iconLabel. The length cap rejects it.
    const cardWrapper = mk({
      tag: "a",
      visibleText:
        "anthropic/claude-opus-4.7Model routing visualizationHigher AvailabilityReliable AI models via our distributed infrastruc",
      iconLabel: "Google",
      href: "/docs/guides/best-practices/uptime-optimization",
      selector: "#card",
    });
    expect(findOAuthButton([cardWrapper], "google")).toBeNull();
  });

  it("returns null for a page with no matching affordance", () => {
    const email = mk({ tag: "input", type: "email", selector: "#email" });
    const create = mk({ tag: "button", visibleText: "Create account", selector: "#go" });
    expect(findOAuthButton([email, create], "google")).toBeNull();
  });
});

describe("detectAlreadySignedIn", () => {
  it("returns false when a credential input is visible (a signup chooser)", () => {
    const email = mk({ tag: "input", type: "email", selector: "#email" });
    const dash = mk({ tag: "a", visibleText: "Dashboard", selector: "#dash" });
    expect(
      detectAlreadySignedIn({
        inventory: [email, dash],
        url: "https://app.example.com/dashboard",
      }),
    ).toBe(false);
  });

  it("returns true on a strong 'Sign out' affordance (proves a session)", () => {
    const signOut = mk({ tag: "button", visibleText: "Sign out", selector: "#out" });
    expect(
      detectAlreadySignedIn({
        inventory: [signOut],
        url: "https://app.example.com/projects",
      }),
    ).toBe(true);
  });

  it("returns true on a getting-started URL with no signup affordance (last9)", () => {
    const allSet = mk({ tag: "button", visibleText: "You're all set! Next steps", selector: "#ns" });
    expect(
      detectAlreadySignedIn({
        inventory: [allSet],
        url: "https://app.last9.io/v2/organizations/acme/getting-started",
      }),
    ).toBe(true);
  });

  it("does NOT treat a weak nav keyword as signed-in when a signup chooser is present (northflank)", () => {
    // /login renders "Continue with Google" alongside "Projects"/"Settings"
    // — the weak nav keyword must NOT override the visible auth gate.
    const oauth = mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" });
    const projects = mk({ tag: "a", visibleText: "Projects", selector: "#proj" });
    expect(
      detectAlreadySignedIn({
        inventory: [oauth, projects],
        url: "https://app.northflank.com/login",
      }),
    ).toBe(false);
  });

  it("returns true on a dashboard-route URL with a resource-creation CTA", () => {
    const newProject = mk({ tag: "button", visibleText: "New project", selector: "#np" });
    expect(
      detectAlreadySignedIn({
        inventory: [newProject],
        url: "https://app.example.com/dashboard",
      }),
    ).toBe(true);
  });

  it("returns false on a bare /login page with only a signup affordance", () => {
    const signup = mk({ tag: "button", visibleText: "Sign up", selector: "#su" });
    const oauth = mk({ tag: "button", visibleText: "Continue with Google", selector: "#g" });
    expect(
      detectAlreadySignedIn({
        inventory: [signup, oauth],
        url: "https://example.com/login",
      }),
    ).toBe(false);
  });
});
