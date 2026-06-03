// isStalledOnActions — the deterministic breaker for a broken onboarding
// wizard that re-presents itself (the axiom case): the planner keeps
// correctly clicking a visibly-unfilled card, but the click never
// registers, so the page is identical round after round. Without the
// breaker the run burns all 24 post-verify rounds + LLM budget.

import { describe, expect, it } from "vitest";
import {
  isStalledOnActions,
  isLoginPageUrl,
  isLoadingShellText,
  isSignupOrLoginRoute,
  originRoot,
  isAuthProcessingText,
} from "../agent.js";

describe("isAuthProcessingText (async-session provisioning guard)", () => {
  it("flags Stytch B2B org-provisioning / login copy the bot must wait through", () => {
    expect(isAuthProcessingText("Build Fast Creating your organization...")).toBe(true);
    expect(isAuthProcessingText("Logging in...")).toBe(true);
    expect(isAuthProcessingText("Authenticating, one moment")).toBe(true);
    expect(isAuthProcessingText("Redirecting you to your dashboard")).toBe(true);
  });
  it("does NOT flag a settled dashboard or a plain login form", () => {
    expect(isAuthProcessingText("API Keys Dashboard Playground Default Project")).toBe(false);
    expect(isAuthProcessingText("Create Account or Login Continue with Google")).toBe(false);
  });
});

describe("isSignupOrLoginRoute (post-OAuth dead-route escape)", () => {
  it("flags signup/login/register routes an authed user shouldn't sit on", () => {
    expect(isSignupOrLoginRoute("https://app.northflank.com/signup")).toBe(true);
    expect(isSignupOrLoginRoute("https://x.example/sign-up")).toBe(true);
    expect(isSignupOrLoginRoute("https://x.example/register")).toBe(true);
    expect(isSignupOrLoginRoute("https://console.groq.com/authenticate")).toBe(true);
    expect(isSignupOrLoginRoute("https://x.example/login")).toBe(true);
  });
  it("does NOT flag dashboard/app routes", () => {
    expect(isSignupOrLoginRoute("https://app.northflank.com/projects")).toBe(false);
    expect(isSignupOrLoginRoute("https://x.example/settings/api-keys")).toBe(false);
    // "signup-success" is its own segment, not the bare "signup" route —
    // a post-signup landing page is NOT a dead route.
    expect(isSignupOrLoginRoute("https://x.example/signup-success/welcome")).toBe(false);
    expect(isSignupOrLoginRoute("https://x.example/dashboard")).toBe(false);
  });
  it("never throws on a malformed URL", () => {
    expect(isSignupOrLoginRoute("not a url")).toBe(false);
  });
});

describe("originRoot", () => {
  it("returns scheme://host/ with no path or query", () => {
    expect(originRoot("https://app.northflank.com/signup?x=1")).toBe("https://app.northflank.com/");
    expect(originRoot("https://console.groq.com/authenticate")).toBe("https://console.groq.com/");
  });
  it("returns null on a malformed URL", () => {
    expect(originRoot("nope")).toBeNull();
  });
});

describe("isLoadingShellText (SPA hydration guard)", () => {
  it("fires on northflank's real post-OAuth loading shell", () => {
    // Exact body text from the northflank /settings/access-tokens trail.
    expect(
      isLoadingShellText(
        "Northflank Cloud Platform Connecting This application cannot function " +
          "without JavaScript. Please enable it to continue.",
      ),
    ).toBe(true);
  });

  it("fires on common loading-shell phrasings", () => {
    expect(isLoadingShellText("Loading…")).toBe(true);
    expect(isLoadingShellText("Please wait while we get things ready")).toBe(true);
    expect(isLoadingShellText("Initializing your workspace")).toBe(true);
    expect(isLoadingShellText("Please enable JavaScript to continue")).toBe(true);
  });

  it("does NOT fire on a real dashboard with token UI", () => {
    expect(
      isLoadingShellText("API Tokens Create token Your personal access tokens Revoke"),
    ).toBe(false);
    expect(isLoadingShellText("Create your API key — Settings")).toBe(false);
  });
});

describe("isLoginPageUrl (non-persisting-OAuth detector)", () => {
  it("flags real login/authenticate pages (groq, northflank, amplitude)", () => {
    expect(isLoginPageUrl("https://console.groq.com/authenticate")).toBe(true);
    expect(isLoginPageUrl("https://app.northflank.com/login")).toBe(true);
    expect(isLoginPageUrl("https://app.amplitude.com/login?google-auth-error=1")).toBe(true);
    expect(isLoginPageUrl("https://x.example/sign-in")).toBe(true);
    expect(isLoginPageUrl("https://x.example/sso/start")).toBe(true);
  });

  it("does NOT flag authenticated dashboard / key pages", () => {
    expect(isLoginPageUrl("https://console.groq.com/keys")).toBe(false);
    expect(isLoginPageUrl("https://app.x.io/v2/organizations/me/getting-started")).toBe(false);
    expect(isLoginPageUrl("https://x.example/settings/api-keys")).toBe(false);
    // 'auth' as a substring of an unrelated path must not match.
    expect(isLoginPageUrl("https://x.example/author/profile")).toBe(false);
    expect(isLoginPageUrl("https://x.example/dashboard")).toBe(false);
  });

  it("never throws on a malformed URL", () => {
    expect(isLoginPageUrl("not a url")).toBe(false);
  });
});

const a = (kind: string, pageUnchanged: boolean) => ({ kind, pageUnchanged });

describe("isStalledOnActions", () => {
  it("fires when 3 consecutive page-mutating actions left the page unchanged (axiom)", () => {
    expect(
      isStalledOnActions([a("click", true), a("click", true), a("click", true)]),
    ).toBe(true);
  });

  it("counts mixed action kinds (click/select/check) toward the stall", () => {
    expect(
      isStalledOnActions([a("click", true), a("select", true), a("check", true)]),
    ).toBe(true);
  });

  it("does NOT fire below the threshold", () => {
    expect(isStalledOnActions([a("click", true), a("click", true)])).toBe(false);
  });

  it("does NOT fire if any of the last 3 actions DID change the page", () => {
    expect(
      isStalledOnActions([a("click", true), a("click", false), a("click", true)]),
    ).toBe(false);
  });

  it("excludes navigate/wait/extract — they legitimately don't mutate the current DOM", () => {
    // A navigate changes the URL not the DOM; it must not count as a stall.
    expect(
      isStalledOnActions([a("click", true), a("navigate", true), a("click", true)]),
    ).toBe(false);
    expect(
      isStalledOnActions([a("wait", true), a("wait", true), a("wait", true)]),
    ).toBe(false);
  });

  it("uses only the most recent `threshold` effects (a stall after earlier progress still fires)", () => {
    expect(
      isStalledOnActions([
        a("click", false), // earlier progress
        a("click", true),
        a("click", true),
        a("click", true),
      ]),
    ).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isStalledOnActions([a("click", true), a("click", true)], 2)).toBe(true);
  });
});
