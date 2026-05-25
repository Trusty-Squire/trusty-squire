// T13 — the GitHub provider: auth-page classifier + scope gate, plus
// the provider registry's normalization of the Google classifier.

import { describe, expect, it } from "vitest";
import {
  OAUTH_PROVIDERS,
  classifyGitHubAuthState,
  githubScopesAreBasic,
  isGitHubDismissible2faSetup,
  isOAuthProviderId,
} from "../oauth-providers.js";

describe("classifyGitHubAuthState (T13)", () => {
  it("detects the OAuth authorize screen as consent", () => {
    expect(
      classifyGitHubAuthState(
        "https://github.com/login/oauth/authorize?client_id=x&scope=read:user",
        "Authorize Acme — Acme by acme wants to access your account",
      ),
    ).toBe("consent");
  });

  it("classifies the GitHub login page as needs_login", () => {
    expect(
      classifyGitHubAuthState(
        "https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize",
        "Sign in to GitHub",
      ),
    ).toBe("needs_login");
  });

  it("detects a two-factor / device challenge", () => {
    expect(
      classifyGitHubAuthState(
        "https://github.com/sessions/two-factor/app",
        "Two-factor authentication",
      ),
    ).toBe("challenge");
    expect(
      classifyGitHubAuthState(
        "https://github.com/sessions/verified-device",
        "Verify your device",
      ),
    ).toBe("challenge");
  });

  it("returns not_provider off a GitHub host or on a bad URL", () => {
    expect(classifyGitHubAuthState("https://dashboard.render.com/", "Welcome")).toBe(
      "not_provider",
    );
    expect(classifyGitHubAuthState("not-a-url", "")).toBe("not_provider");
  });

  it("defaults an unrecognized github.com page to needs_login", () => {
    expect(classifyGitHubAuthState("https://github.com/odd/page", "")).toBe("needs_login");
  });
});

describe("githubScopesAreBasic (T13)", () => {
  it("accepts the basic identity scopes", () => {
    expect(githubScopesAreBasic(["read:user", "user:email"])).toBe(true);
    expect(githubScopesAreBasic(["user:email"])).toBe(true);
  });

  it("rejects repo / admin / write and other broad scopes", () => {
    expect(githubScopesAreBasic(["read:user", "repo"])).toBe(false);
    expect(githubScopesAreBasic(["admin:org"])).toBe(false);
    expect(githubScopesAreBasic(["write:packages"])).toBe(false);
  });

  it("rejects an empty scope list — absence is not confirmation", () => {
    expect(githubScopesAreBasic([])).toBe(false);
  });
});

describe("OAUTH_PROVIDERS registry", () => {
  it("normalizes the Google classifier's not_google to not_provider", () => {
    expect(
      OAUTH_PROVIDERS.google.classifyAuthState("https://dashboard.render.com/", ""),
    ).toBe("not_provider");
    expect(
      OAUTH_PROVIDERS.google.classifyAuthState(
        "https://accounts.google.com/signin/oauth/consent?scope=openid",
        "wants access to your Google Account",
      ),
    ).toBe("consent");
  });

  it("wires each provider's scope gate", () => {
    expect(OAUTH_PROVIDERS.github.scopesAreBasic(["read:user"])).toBe(true);
    expect(OAUTH_PROVIDERS.github.scopesAreBasic(["repo"])).toBe(false);
    expect(OAUTH_PROVIDERS.google.scopesAreBasic(["openid", "email"])).toBe(true);
  });

  it("isOAuthProviderId narrows known ids only", () => {
    expect(isOAuthProviderId("google")).toBe(true);
    expect(isOAuthProviderId("github")).toBe(true);
    expect(isOAuthProviderId("microsoft")).toBe(false);
    expect(isOAuthProviderId("")).toBe(false);
  });
});

describe("isGitHubDismissible2faSetup (rc.34)", () => {
  it("detects the canonical 'skip 2FA verification at this moment' link", () => {
    const body =
      "Verify your two-factor authentication (2FA) settings\n" +
      "This is a one-time verification of your recently configured 2FA credentials.\n" +
      "Verify 2FA now\n" +
      "You can choose to skip 2FA verification at this moment, we'll remind you tomorrow.";
    expect(isGitHubDismissible2faSetup(body)).toBe(true);
  });

  it("matches across whitespace breaks from GitHub's quirky DOM (rc.34 follow-up)", () => {
    // GitHub renders the dismiss control as `<button>skip 2FA
    // verification</button>` with the surrounding "at this moment..."
    // text as a sibling text node OUTSIDE the button. Real
    // page.textContent("body") preserves the newlines/whitespace
    // between them — earlier rc.34 used a literal substring match
    // and missed the live page. Detector now whitespace-normalizes
    // before checking.
    const body =
      "Verify 2FA now\n\n  \n            skip 2FA verification\n  \n            at this moment, we'll remind you again tomorrow.";
    expect(isGitHubDismissible2faSetup(body)).toBe(true);
  });

  it("also matches the historical 'skip 2FA verification for now' phrasing", () => {
    const body = "skip 2FA verification for now";
    expect(isGitHubDismissible2faSetup(body)).toBe(true);
  });

  it("is case-insensitive on the link text", () => {
    expect(isGitHubDismissible2faSetup("SKIP 2FA VERIFICATION AT THIS MOMENT")).toBe(true);
    expect(isGitHubDismissible2faSetup("Skip 2fa Verification At This Moment")).toBe(true);
  });

  it("does NOT match a real 2FA challenge page (no skip link)", () => {
    const body =
      "Two-factor authentication\n" +
      "Use your authenticator app to get a verification code, then enter it below.\n" +
      "Verify";
    expect(isGitHubDismissible2faSetup(body)).toBe(false);
  });

  it("does NOT match a generic security-challenge page", () => {
    const body = "Verify your device — we sent a code to your email.";
    expect(isGitHubDismissible2faSetup(body)).toBe(false);
  });

  it("does NOT match a non-2FA page that happens to mention 'skip'", () => {
    const body = "skip this tutorial";
    expect(isGitHubDismissible2faSetup(body)).toBe(false);
  });
});
