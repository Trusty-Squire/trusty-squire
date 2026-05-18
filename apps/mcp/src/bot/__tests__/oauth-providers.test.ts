// T13 — the GitHub provider: auth-page classifier + scope gate, plus
// the provider registry's normalization of the Google classifier.

import { describe, expect, it } from "vitest";
import {
  OAUTH_PROVIDERS,
  classifyGitHubAuthState,
  githubScopesAreBasic,
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
