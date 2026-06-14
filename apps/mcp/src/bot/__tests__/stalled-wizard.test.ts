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
  isLoadingShell,
  SHELL_MAX_ELEMENTS,
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

  it("fires on common TRANSIENT loading-shell phrasings", () => {
    expect(isLoadingShellText("Loading…")).toBe(true);
    expect(isLoadingShellText("Please wait while we get things ready")).toBe(true);
    expect(isLoadingShellText("Initializing your workspace")).toBe(true);
  });

  it("does NOT fire on the permanent <noscript> fallback (it never leaves the DOM)", () => {
    // northflank's hydrated page still contains this text — matching it made
    // the page read as a perpetual loading shell.
    expect(isLoadingShellText("This application cannot function without JavaScript. Please enable it.")).toBe(false);
    expect(isLoadingShellText("Please enable JavaScript to continue")).toBe(false);
  });

  it("does NOT fire on a real dashboard with token UI", () => {
    expect(
      isLoadingShellText("API Tokens Create token Your personal access tokens Revoke"),
    ).toBe(false);
    expect(isLoadingShellText("Create your API key — Settings")).toBe(false);
  });

  it("does NOT fire on the Google account chooser despite its stray 'Loading' label", () => {
    // The clerk post-verify case: re-clicking "Sign in with Google" opens
    // accounts.google.com's chooser, whose body carries a stray "Loading"
    // label. It's an ACTIONABLE page (click the account card), not a
    // hydration shell — idling through the hydration ticks here is the bug.
    expect(
      isLoadingShellText(
        "Choose an account to continue to MyApp Loading user@example.com Use another account",
      ),
    ).toBe(false);
  });

  it("STILL fires on a genuine loading shell (chooser veto is narrow)", () => {
    expect(isLoadingShellText("Loading…")).toBe(true);
  });
});

describe("isLoadingShell (inventory-veto'd shell gate — the false-positive fix)", () => {
  it("fires on a genuine empty/near-empty shell (loading text + tiny inventory)", () => {
    // northflank's real post-OAuth shell: loading text, zero interactive DOM.
    expect(
      isLoadingShell(
        "Northflank Cloud Platform Connecting This application cannot function " +
          "without JavaScript.",
        0,
      ),
    ).toBe(true);
    // A shell that painted a logo link + nothing else is still a shell.
    expect(isLoadingShell("Loading…", 1)).toBe(true);
    expect(isLoadingShell("Please wait while we get things ready", SHELL_MAX_ELEMENTS - 1)).toBe(
      true,
    );
  });

  it("does NOT fire on a hydrated page despite a stray loading word (the luma-ai case)", () => {
    // luma-ai: 95 visible interactive elements, with a hidden "Please wait 30
    // seconds" string that the raw-textContent gate matched every round. The
    // inventory veto makes the shell read un-fireable on a hydrated page.
    expect(isLoadingShell("Generate Create Dashboard Please wait 30 seconds", 95)).toBe(false);
    // Exactly at the threshold = hydrated.
    expect(isLoadingShell("Loading…", SHELL_MAX_ELEMENTS)).toBe(false);
    // The other field offenders (10–50 elements) likewise veto.
    expect(isLoadingShell("Connecting… API Keys Settings Create token", 12)).toBe(false);
  });

  it("does NOT fire when there's NO loading text, regardless of inventory", () => {
    // A normal dashboard with no loading copy is never a shell.
    expect(isLoadingShell("API Tokens Create token Revoke", 0)).toBe(false);
    expect(isLoadingShell("Create your API key — Settings", 3)).toBe(false);
  });

  it("threshold const stays in sync with waitForInteractiveDom's default", () => {
    // The positive readiness gate (waitForInteractiveDom(SHELL_MAX_ELEMENTS))
    // and this negative veto must agree on what 'hydrated' means.
    expect(SHELL_MAX_ELEMENTS).toBe(5);
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
const as = (kind: string, pageUnchanged: boolean, selector: string) => ({
  kind,
  pageUnchanged,
  selector,
});

describe("isStalledOnActions", () => {
  it("fires when 3 consecutive page-mutating actions left the page unchanged (selectorless, legacy)", () => {
    expect(
      isStalledOnActions([a("click", true), a("click", true), a("click", true)]),
    ).toBe(true);
  });

  it("fires when the SAME selector is re-clicked with no change (genuine stuck wizard)", () => {
    expect(
      isStalledOnActions([as("click", true, "#card"), as("click", true, "#card"), as("click", true, "#card")]),
    ).toBe(true);
  });

  it("does NOT fire when DISTINCT selectors are clicked unchanged (multi-field wizard progress — axiom)", () => {
    // Selecting role, then company-size, then plan doesn't change the
    // inventory, but each is a different choice — that's progress, not a stall.
    expect(
      isStalledOnActions([as("click", true, "#role"), as("click", true, "#size"), as("click", true, "#plan")]),
    ).toBe(false);
  });

  it("fires when a selector repeats among distinct ones (looping back)", () => {
    expect(
      isStalledOnActions([as("click", true, "#role"), as("click", true, "#size"), as("click", true, "#role")]),
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
