// T11 — fake-browser integration tests for the OAuth-first signup flow
// (T6/T7/T9). Real-Google behaviour is covered by the spike + the T12
// manual thin slice (D6); these tests pin the agent LOGIC: the
// OAuth-first branch, the consent scope gate, and — the load-bearing
// one — the critical guarantee that a missing/expired Google session
// or a security challenge hands back `needs_login` and the bot NEVER
// types into Google's form.
//
// SignupAgent's private methods are reflected here, the same
// break-the-encapsulation pattern as plan-execute-retry.test.ts.

import { describe, expect, it } from "vitest";
import {
  SignupAgent,
  detectEmailOtpGate,
  detectManualLoginFallback,
  detectSsoRestriction,
  detectStuckOnGoogleOAuth,
  findOAuthButton,
  findFirstOAuthButton,
  findSignInAdvanceButton,
  orderOAuthCandidates,
  isLoginLoopState,
  parsePostVerifyStep,
  type AgentInbox,
} from "../agent.js";
import { scoreSignupButton } from "../browser.js";
import type {
  BrowserController,
  BrowserState,
  InteractiveElement,
} from "../browser.js";
import type { LLMClient, LLMResponse } from "../llm-client.js";
import { buildSignupResponse } from "../../tools/provision-any.js";

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

const GOOGLE_BTN = mk({
  tag: "button",
  visibleText: "Continue with Google",
  selector: "#google-oauth",
});
const GITHUB_BTN = mk({
  tag: "button",
  visibleText: "Continue with GitHub",
  selector: "#github-oauth",
});
const EMAIL_INPUT = mk({ tag: "input", type: "email", selector: "#email" });
const API_LINK = mk({ tag: "a", visibleText: "API Keys", selector: "#api" });

// One scripted page: the URL + visible body text the fake serves while
// the run "sits" on it. Navigation steps advance the page pointer.
interface ScriptPage {
  url: string;
  text: string;
}

// Fake browser driven by a page script. startOAuth / advanceGoogleConsent
// / click / goto-navigate advance the pointer; everything else reads the
// current page. extractInteractiveElements returns: the signup-page
// inventory at page 0; `consentPageInventory` at page 1 (empty = a
// genuine consent screen, an input present = a Google login form); and
// `dashboardInventory` at page 2+ (the post-OAuth onboarding surface).
class FakeOAuthBrowser {
  public idx = 0;
  public typeCalls: Array<{ selector: string; text: string }> = [];
  public startOAuthCalls = 0;
  public advanceCalls = 0;
  public settleCalls = 0;
  public advanceResult = true;
  public signupInventory: InteractiveElement[] = [GOOGLE_BTN];
  public consentPageInventory: InteractiveElement[] = [];
  public dashboardInventory: InteractiveElement[] = [];
  public popupClosed = false;

  constructor(private readonly script: ScriptPage[]) {}

  private advance(): void {
    this.idx = Math.min(this.idx + 1, this.script.length - 1);
  }
  private page(): ScriptPage {
    return this.script[Math.min(this.idx, this.script.length - 1)] ?? { url: "", text: "" };
  }

  get channel(): string | null {
    return null;
  }
  get proxied(): string | null {
    return null;
  }
  async prewarm(): Promise<void> {}
  async goto(): Promise<void> {}
  async wait(): Promise<void> {}
  async waitForFormReady(): Promise<void> {}
  async dismissConsentBanner(): Promise<string | null> { return null; }
  async type(selector: string, text: string): Promise<void> {
    this.typeCalls.push({ selector, text });
  }
  async check(): Promise<void> {}
  async click(): Promise<void> {
    // A post-OAuth onboarding click navigates the dashboard.
    this.advance();
  }
  async selectOption(): Promise<void> {}
  async clickSubmit(): Promise<void> {}

  // Visible <input>/<textarea> values keyed by page index — a key in a
  // copy-input / discrete-element credential candidates by page index —
  // a key in a copy-input lives here, not in extractText().
  public fieldValuesByIdx: Record<number, string[]> = {};
  async extractText(): Promise<string> {
    return this.page().text;
  }
  async extractCredentialCandidates(): Promise<string[]> {
    return this.fieldValuesByIdx[this.idx] ?? [];
  }
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    if (this.idx === 0) return this.signupInventory;
    if (this.idx === 1) return this.consentPageInventory;
    return this.dashboardInventory;
  }
  async getState(): Promise<BrowserState> {
    const p = this.page();
    return {
      url: p.url,
      title: "Sign up",
      html: `<html><body>${p.text}</body></html>`,
      screenshot: "",
    };
  }

  // ── OAuth surface ──
  async startOAuth(): Promise<void> {
    this.startOAuthCalls += 1;
    this.advance(); // land on the first Google screen
  }
  // These tests exercise the classic OAuth-redirect path; report no GSI/FedCM
  // widget so runOAuthFlow takes startOAuth (not tryGoogleGsiLogin).
  async hasGoogleGsiAffordance(): Promise<boolean> {
    return false;
  }
  currentUrl(): string {
    return this.page().url;
  }
  oauthPageClosed(): boolean {
    return this.popupClosed;
  }
  async advanceOAuthConsent(): Promise<boolean> {
    this.advanceCalls += 1;
    if (this.advanceResult) this.advance();
    return this.advanceResult;
  }
  async settleAfterOAuth(): Promise<void> {
    this.settleCalls += 1;
  }
}

// LLM stub replaying a queue of post-verify step replies (last sticks).
class QueueLLM implements LLMClient {
  readonly name = "queue";
  public calls = 0;
  constructor(private readonly replies: string[]) {}
  async createMessage(): Promise<LLMResponse> {
    const r = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return { text: r ?? "{}", backend: this.name };
  }
}

// An inbox that must never be touched on an OAuth run (OAuth has no
// verification-email step).
class NeverInbox implements AgentInbox {
  public calls = 0;
  async waitForEmail(): Promise<{
    subject: string;
    from_address: string;
    parsed_links: ReadonlyArray<string>;
    parsed_codes: ReadonlyArray<string>;
  }> {
    this.calls += 1;
    throw new Error("inbox must not be polled on an OAuth run");
  }
}

function isController(_v: unknown): _v is BrowserController {
  return true;
}

function newAgent(browser: FakeOAuthBrowser, llm?: LLMClient): SignupAgent {
  const asController: unknown = browser;
  if (!isController(asController)) throw new Error("unreachable");
  // 10ms Google-challenge timeout so the "needs_login on challenge"
  // test doesn't wall-clock-burn 120 seconds waiting for a FakeBrowser
  // that's never going to leave the challenge state. The test runs in
  // ~10ms instead of 120s — and CI's vitest worker stops timing out
  // its IPC heartbeat (which was the root of the rc.3 flake).
  return new SignupAgent(asController, llm ?? new QueueLLM(["{}"]), {
    googleChallengeTimeoutMs: 10,
  });
}

const CONSENT_BASIC: ScriptPage = {
  url: "https://accounts.google.com/signin/oauth/consent?scope=openid+email+profile&client_id=abc",
  text: "Render wants access to your Google Account",
};
const CONSENT_GITHUB: ScriptPage = {
  url: "https://github.com/login/oauth/authorize?client_id=abc&scope=read:user+user:email",
  text: "Authorize Render — Render by render wants to access your account",
};
const PRODUCT_DASH = (text: string): ScriptPage => ({
  url: "https://dashboard.render.com/",
  text,
});

// ───────────────────── findOAuthButton ─────────────────────

describe("findOAuthButton", () => {
  it("matches a 'Continue with Google' button", () => {
    expect(findOAuthButton([GOOGLE_BTN], "google")?.selector).toBe("#google-oauth");
  });

  it("matches a 'Sign up with Google' link and an aria-labelled icon button", () => {
    const link = mk({ tag: "a", visibleText: "Sign up with Google", selector: "#a" });
    const icon = mk({ tag: "button", ariaLabel: "Sign in with Google", selector: "#b" });
    expect(findOAuthButton([link], "google")?.selector).toBe("#a");
    expect(findOAuthButton([icon], "google")?.selector).toBe("#b");
  });

  it("matches a button whose SVG name is GLUED to its text ('GoogleSign up with Google')", () => {
    // elevenlabs (and similar) render the provider icon's accessible name
    // concatenated to the button text with no space, fusing the verb into
    // "googlesign". The camelCase split must recover it so the bot OAuths
    // in instead of falling back to a bouncing email signup.
    const glued = mk({
      tag: "button",
      visibleText: "GoogleSign up with Google",
      selector: "#glued",
    });
    expect(findOAuthButton([glued], "google")?.selector).toBe("#glued");
  });

  it("matches a 'Continue with GitHub' button when the provider is github", () => {
    const gh = mk({ tag: "button", visibleText: "Continue with GitHub", selector: "#gh" });
    expect(findOAuthButton([gh], "github")?.selector).toBe("#gh");
    // ...but not when the requested provider is Google.
    expect(findOAuthButton([gh], "google")).toBeNull();
  });

  it("returns null for a page with no matching affordance", () => {
    expect(
      findOAuthButton(
        [EMAIL_INPUT, mk({ tag: "button", visibleText: "Create account", selector: "#go" })],
        "google",
      ),
    ).toBeNull();
  });

  it("ignores a non-auth link that merely mentions the provider", () => {
    const docs = mk({ tag: "a", visibleText: "Powered by Google Cloud", selector: "#d" });
    expect(findOAuthButton([docs], "google")).toBeNull();
    const ghDocs = mk({ tag: "a", visibleText: "View on GitHub", selector: "#g" });
    expect(findOAuthButton([ghDocs], "github")).toBeNull();
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
      selector: "#gh-a",
    });
    expect(findOAuthButton([oauthLink], "google")?.selector).toBe("#gh-a");
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

  it("rejects a card-wrapper <a> whose descendants include a tiny provider icon (OpenRouter rc.12)", () => {
    // OpenRouter's signup page wraps a model-showcase card in an <a>.
    // Its textContent reads as a model card; a descendant <img alt> for
    // a small "G" icon caused iconLabelFor() to surface "Google". Both
    // signals must reject the wrapper — only short button labels qualify.
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

  it("rejects an icon-only-shaped <button> when the wrapping element also carries unrelated visible text", () => {
    // A defensive variant of the OpenRouter case — same iconLabel
    // signal but on a <button> whose own text exceeds the cap. Must
    // still reject; iconLabel is only a valid signal on truly
    // icon-only elements.
    const wrapper = mk({
      tag: "button",
      visibleText: "Browse all 200+ models including Claude, GPT-4, Gemini, and Llama variants",
      iconLabel: "Google",
      selector: "#wrap",
    });
    expect(findOAuthButton([wrapper], "google")).toBeNull();
  });

  it("still accepts a truly icon-only button with no own visible text (Mistral regression guard)", () => {
    // The original icon-only case must keep working post-tightening:
    // visibleText is empty/null, iconLabel carries the provider name.
    const iconBtn = mk({
      tag: "button",
      visibleText: null,
      iconLabel: "Google",
      selector: "#icon",
    });
    expect(findOAuthButton([iconBtn], "google")?.selector).toBe("#icon");
  });
});

// ───────────────────── findFirstOAuthButton ─────────────────────

describe("findFirstOAuthButton", () => {
  it("returns the first match in CANDIDATE order, not inventory order", () => {
    const google = mk({
      tag: "button",
      visibleText: "Continue with Google",
      selector: "#g",
    });
    const github = mk({
      tag: "button",
      visibleText: "Continue with GitHub",
      selector: "#gh",
    });
    const hit = findFirstOAuthButton([google, github], ["github", "google"]);
    expect(hit?.provider).toBe("github");
    expect(hit?.button.selector).toBe("#gh");
  });

  it("falls through to the next candidate when the first is absent", () => {
    const github = mk({
      tag: "button",
      visibleText: "Continue with GitHub",
      selector: "#gh",
    });
    const hit = findFirstOAuthButton([github], ["google", "github"]);
    expect(hit?.provider).toBe("github");
  });

  it("returns null when no candidate's affordance is on the page", () => {
    const email = mk({ tag: "input", type: "email", selector: "#email" });
    expect(findFirstOAuthButton([email], ["google", "github"])).toBeNull();
  });
});

// ───────────────────── findSignInAdvanceButton ─────────────────────

describe("findSignInAdvanceButton", () => {
  const PROVIDERS = ["google", "github"] as const;

  it("matches Qdrant's 'Sign In to Continue' interstitial button", () => {
    const btn = mk({
      tag: "button",
      role: "button",
      visibleText: "Sign In to Continue",
      selector: "#signin",
    });
    expect(findSignInAdvanceButton([btn], PROVIDERS)?.selector).toBe("#signin");
  });

  it("matches a bare 'Sign in' / 'Log in' affordance", () => {
    const signIn = mk({ tag: "a", visibleText: "Sign in", selector: "#a" });
    const logIn = mk({ tag: "button", visibleText: "Log in", selector: "#b" });
    expect(findSignInAdvanceButton([signIn], PROVIDERS)?.selector).toBe("#a");
    expect(findSignInAdvanceButton([logIn], PROVIDERS)?.selector).toBe("#b");
  });

  it("does NOT match non-auth CTAs (404 recovery, workspace, nav)", () => {
    // daytona / workos 404 pages, highlight's disabled-workspace page.
    const goDashboard = mk({
      tag: "button",
      visibleText: "Go to Dashboard",
      selector: "#d",
    });
    const goDashboard2 = mk({
      tag: "a",
      role: "button",
      visibleText: "Go to the dashboard",
      selector: "#d2",
    });
    const joinWorkspace = mk({
      tag: "button",
      type: "submit",
      visibleText: "Join Workspace",
      selector: "#jw",
    });
    const home = mk({ tag: "a", visibleText: "Home", selector: "#home" });
    const refresh = mk({ tag: "button", visibleText: "Try a refresh", selector: "#r" });
    expect(
      findSignInAdvanceButton(
        [goDashboard, goDashboard2, joinWorkspace, home, refresh],
        PROVIDERS,
      ),
    ).toBeNull();
  });

  it("does NOT match a bare 'Continue' (too ambiguous to click blind)", () => {
    const cont = mk({ tag: "button", visibleText: "Continue", selector: "#c" });
    expect(findSignInAdvanceButton([cont], PROVIDERS)).toBeNull();
  });

  it("returns null when a provider affordance is already present", () => {
    // A page with BOTH a "Sign in" link and a real Google button must
    // not route through the click-through path — the caller takes OAuth.
    const signIn = mk({ tag: "a", visibleText: "Sign in", selector: "#a" });
    const google = mk({
      tag: "button",
      visibleText: "Continue with Google",
      selector: "#g",
    });
    expect(findSignInAdvanceButton([signIn, google], PROVIDERS)).toBeNull();
  });

  it("ignores a long paragraph that merely contains 'sign in'", () => {
    const blurb = mk({
      tag: "a",
      visibleText:
        "By continuing you agree to our terms; sign in to your account from the menu",
      selector: "#blurb",
    });
    expect(findSignInAdvanceButton([blurb], PROVIDERS)).toBeNull();
  });
});

// ───────────────────── orderOAuthCandidates ─────────────────────

describe("orderOAuthCandidates", () => {
  it("leads with an explicit pin when its session is warm, Google as fallback", () => {
    // northflank pins github (its Google is One-Tap/FedCM the redirect flow
    // can't drive); with a warm github session the pin leads, google trails
    // as the fallback for pages that only offer google.
    expect(orderOAuthCandidates("github", ["google", "github"])).toEqual(["github", "google"]);
    expect(orderOAuthCandidates("github", ["github", "google"])).toEqual(["github", "google"]);
  });

  it("falls back to Google when the pinned provider's session is NOT warm", () => {
    expect(orderOAuthCandidates("github", ["google"])).toEqual(["google", "github"]);
  });

  it("honours a non-Google pin when there's NO Google session (no regression)", () => {
    expect(orderOAuthCandidates("github", ["github"])).toEqual(["github"]);
    expect(orderOAuthCandidates("github", [])).toEqual(["github"]);
  });

  it("leads with Google when Google is pinned, github as fallback", () => {
    expect(orderOAuthCandidates("google", ["google", "github"])).toEqual(["google", "github"]);
    expect(orderOAuthCandidates("google", ["google"])).toEqual(["google"]);
  });

  it("with no pin, sorts logged-in providers Google-first", () => {
    expect(orderOAuthCandidates(undefined, ["github", "google"])).toEqual(["google", "github"]);
    expect(orderOAuthCandidates(undefined, ["github"])).toEqual(["github"]);
    expect(orderOAuthCandidates(undefined, [])).toEqual([]);
  });
});

// ───────────────────── isLoginLoopState (rc.20) ─────────────────────

describe("isLoginLoopState", () => {
  const googleBtn = mk({
    tag: "button",
    visibleText: "Continue with Google",
    selector: "#g",
  });

  it("detects Groq-style /authenticate page with a Google button", () => {
    const hit = isLoginLoopState(
      "https://console.groq.com/authenticate",
      [googleBtn],
      "google",
    );
    expect(hit?.selector).toBe("#g");
  });

  it("detects /login + Google button as a loop", () => {
    expect(
      isLoginLoopState("https://service.com/login?next=/dashboard", [googleBtn], "google"),
    ).not.toBeNull();
  });

  it("detects /signin path too", () => {
    expect(
      isLoginLoopState("https://service.com/signin", [googleBtn], "google"),
    ).not.toBeNull();
  });

  it("returns null when the path is a dashboard route", () => {
    expect(
      isLoginLoopState("https://service.com/dashboard/api-keys", [googleBtn], "google"),
    ).toBeNull();
  });

  it("returns null when the path is /callback (genuinely transient)", () => {
    expect(
      isLoginLoopState("https://service.com/oauth/callback", [googleBtn], "google"),
    ).toBeNull();
  });

  it("returns null when the page has authenticated-state markers (Sign out)", () => {
    // Even if the URL is /authenticate, a visible Sign-out link means the
    // user IS signed in — detectAlreadySignedIn flips this case.
    const signOut = mk({ tag: "a", visibleText: "Sign out", selector: "#signout" });
    expect(
      isLoginLoopState("https://service.com/authenticate", [signOut, googleBtn], "google"),
    ).toBeNull();
  });

  it("returns null when the provider button is for a different provider", () => {
    const githubBtn = mk({
      tag: "button",
      visibleText: "Continue with GitHub",
      selector: "#gh",
    });
    expect(
      isLoginLoopState("https://service.com/authenticate", [githubBtn], "google"),
    ).toBeNull();
  });

  it("STILL fires when a bare email field sits next to the Google button (real groq /authenticate)", () => {
    // groq's /authenticate shows an "or continue with email" magic-link
    // input ALONGSIDE the OAuth buttons. A bare email field must NOT
    // suppress the login-loop retry that groq requires to finalize its
    // Stytch session — that suppression was the oauth_session_not_persisted bug.
    const emailInput = mk({ tag: "input", type: "email", selector: "#email-input" });
    const hit = isLoginLoopState(
      "https://console.groq.com/authenticate",
      [emailInput, googleBtn],
      "google",
    );
    expect(hit?.selector).toBe("#g");
  });

  it("returns null on a genuine email+PASSWORD hybrid form (Clerk/Auth0 credential creation)", () => {
    // The real hybrid form the guard exists for: OAuth buttons PLUS a
    // password input means the service wants a credential created, which
    // the planner (not another OAuth click) must drive.
    const emailInput = mk({ tag: "input", type: "email", selector: "#email" });
    const pwInput = mk({ tag: "input", type: "password", selector: "#pw" });
    expect(
      isLoginLoopState("https://service.com/sign-up", [emailInput, pwInput, googleBtn], "google"),
    ).toBeNull();
  });

  it("returns null on a malformed URL", () => {
    expect(isLoginLoopState("not-a-url", [googleBtn], "google")).toBeNull();
  });
});

// ───────── post-OAuth gate detectors (rc.24) ─────────

describe("detectManualLoginFallback (rc.24)", () => {
  const email = mk({ tag: "input", type: "email", selector: "#email" });
  const password = mk({ tag: "input", type: "password", selector: "#pw" });

  it("fires on DigitalOcean's /login with redirect_url + email + password inputs", () => {
    expect(
      detectManualLoginFallback(
        "https://cloud.digitalocean.com/login?redirect_url=https%3A%2F%2Fcloud.digitalocean.com%2Faccount%2Fapi%2Ftokens",
        [email, password],
      ),
    ).toBe(true);
  });

  it("requires BOTH email AND password input present", () => {
    expect(detectManualLoginFallback("https://x.com/login", [email])).toBe(false);
    expect(detectManualLoginFallback("https://x.com/login", [password])).toBe(false);
  });

  it("does not fire on a dashboard URL", () => {
    expect(
      detectManualLoginFallback("https://x.com/dashboard", [email, password]),
    ).toBe(false);
  });

  it("does not fire on a malformed URL", () => {
    expect(detectManualLoginFallback("not-a-url", [email, password])).toBe(false);
  });
});

describe("detectEmailOtpGate (rc.24)", () => {
  it("fires on Porter / Koyeb (WorkOS) email-verification URL", () => {
    expect(
      detectEmailOtpGate(
        "https://auth.porter.run/email-verification?redirect_uri=…",
        "Verify your email",
        "",
      ),
    ).toBe(true);
    expect(
      detectEmailOtpGate(
        "https://signin.koyeb.com/email-verification?redirect_uri=…",
        "Verify your email",
        "",
      ),
    ).toBe(true);
  });

  it("fires on a 'Verify your email' title even with a non-matching URL", () => {
    expect(detectEmailOtpGate("https://x.com/onboarding/step-2", "Verify your email", "")).toBe(true);
  });

  it("fires on a page-text 'we sent you a verification code to' phrasing", () => {
    expect(
      detectEmailOtpGate(
        "https://x.com/dashboard",
        "Welcome",
        "We sent a 6-digit verification code to lunchboxfortwo@gmail.com",
      ),
    ).toBe(true);
  });

  it("does not fire on a generic page that mentions email", () => {
    expect(
      detectEmailOtpGate("https://x.com/dashboard", "Dashboard", "Your email is configured."),
    ).toBe(false);
  });

  it("fires on Convex's post-OAuth radar-challenge 'Enter the code sent to' wall (0.8.10)", () => {
    // Exact shape captured 2026-05-30: generic URL/title, the gate lives
    // in the body text. This is what the post-verify loop now polls gmail for.
    expect(
      detectEmailOtpGate(
        "https://auth.convex.dev/radar-challenge?state=%2Fauth&redirect_uri=https%3A%2F%2Fdashboard.convex.dev",
        "Complete the code challenge",
        "Complete the code challenge Enter the code sent to lunchboxfortwo@gmail.com Back to sign-in",
      ),
    ).toBe(true);
  });
});

describe("detectSsoRestriction (rc.24)", () => {
  it("fires on Fly's 'SSO organization membership' phrasing", () => {
    expect(
      detectSsoRestriction(
        "New tokens cannot be created — accounts in this SSO organization must use the org SSO portal.",
      ),
    ).toBe(true);
  });

  it("fires on 'managed via Single Sign-On' phrasing", () => {
    expect(
      detectSsoRestriction("This workspace is managed via Single Sign-On (SAML)."),
    ).toBe(true);
  });

  it("fires on 'enforced by SAML' phrasing", () => {
    expect(detectSsoRestriction("Token creation is enforced by SAML on this org.")).toBe(true);
  });

  it("does not fire on a generic mention of SSO as an option", () => {
    expect(
      detectSsoRestriction("You can optionally enable SSO from the security tab."),
    ).toBe(false);
  });
});

describe("detectStuckOnGoogleOAuth (rc.24)", () => {
  it("fires on Google account chooser URL — the Upstash case", () => {
    expect(
      detectStuckOnGoogleOAuth(
        "https://accounts.google.com/v3/signin/accountchooser?access_type=offline&client_id=…",
      ),
    ).toBe(true);
  });

  it("fires on any accounts.google.com page", () => {
    expect(detectStuckOnGoogleOAuth("https://accounts.google.com/")).toBe(true);
    expect(
      detectStuckOnGoogleOAuth("https://accounts.google.com/signin/oauth/consent?x=1"),
    ).toBe(true);
  });

  it("does not fire on the service's own domain", () => {
    expect(detectStuckOnGoogleOAuth("https://console.upstash.com/login")).toBe(false);
  });

  it("does not fire on a malformed URL", () => {
    expect(detectStuckOnGoogleOAuth("not-a-url")).toBe(false);
  });
});

// ───────────────────── scoreSignupButton oauthProvider ─────────────────────

describe("scoreSignupButton — OAuth-first flip", () => {
  it("scores a Google button negative by default, positive when google is a candidate", () => {
    expect(scoreSignupButton("Continue with Google")).toBeLessThan(0);
    expect(scoreSignupButton("Continue with Google", ["google"])).toBeGreaterThan(0);
  });

  it("flips only candidate providers — non-candidates stay negative", () => {
    expect(scoreSignupButton("Continue with GitHub", ["google"])).toBeLessThan(0);
    expect(scoreSignupButton("Continue with GitHub", ["github"])).toBeGreaterThan(0);
    expect(scoreSignupButton("Continue with Google", ["github"])).toBeLessThan(0);
  });

  it("flips every provider in a multi-candidate list (auto-prefer)", () => {
    expect(
      scoreSignupButton("Continue with Google", ["google", "github"]),
    ).toBeGreaterThan(0);
    expect(
      scoreSignupButton("Continue with GitHub", ["google", "github"]),
    ).toBeGreaterThan(0);
  });
});

// ───────────────────── planExecuteWithRetry → oauth outcome ─────────────────────

describe("planExecuteWithRetry — OAuth-first branch (T6)", () => {
  it("returns the `oauth` outcome when oauthProvider=google and a Google button exists", async () => {
    const browser = new FakeOAuthBrowser([{ url: "https://render.com/register", text: "" }]);
    const agent = newAgent(browser);
    const steps: string[] = [];
    const fn = (
      agent as unknown as {
        planExecuteWithRetry: (
          t: { service: string; email: string; oauthProvider?: "google" },
          fv: Record<string, string>,
          s: string[],
        ) => Promise<{ kind: string; selector?: string }>;
      }
    ).planExecuteWithRetry.bind(agent);
    const fillValues = {
      email: "x@inbox.test",
      password: "Pw-1",
      name: "N",
      username: "u",
      company: "c",
      literal: "",
    };
    const outcome = await fn(
      { service: "Render", email: "x@inbox.test", oauthProvider: "google" },
      fillValues,
      steps,
    );
    expect(outcome.kind).toBe("oauth");
    expect(outcome.selector).toBe("#google-oauth");
  });
});

// ───────────────────── full OAuth signup ─────────────────────

function oauthTask(): Parameters<SignupAgent["signup"]>[0] {
  return {
    service: "Render",
    signupUrl: "https://render.com/register",
    email: "bot@inbox.test",
    generatePassword: () => "Pw-test-12345",
    oauthProvider: "google",
  };
}

describe("OAuth signup — happy path (T6/T7)", () => {
  it("clicks Google, auto-approves basic consent, and extracts the API key", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      CONSENT_BASIC,
      PRODUCT_DASH("Dashboard — Your API Key: ts_oauthkey_abcdefghijklmnop12345"),
    ]);
    const agent = newAgent(browser);
    const result = await agent.signup(oauthTask());

    expect(result.success).toBe(true);
    expect(result.credentials?.api_key).toBe("ts_oauthkey_abcdefghijklmnop12345");
    expect(browser.startOAuthCalls).toBe(1);
    expect(browser.advanceCalls).toBe(1); // one consent screen, auto-approved
    expect(browser.settleCalls).toBe(1);
    // OAuth runs never form-fill — nothing was typed anywhere.
    expect(browser.typeCalls).toHaveLength(0);
    expect(result.steps.some((s) => /taking the OAuth path/i.test(s))).toBe(true);
    expect(result.steps.some((s) => /scopes all basic/i.test(s))).toBe(true);
  });

  it("drives post-OAuth onboarding when the key is one click away (T9)", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      CONSENT_BASIC,
      PRODUCT_DASH("Welcome — no key here, open the API Keys page"),
      {
        url: "https://dashboard.render.com/u/settings/api-keys",
        text: "API Key: rnd_onboard_abcdefghij1234567890",
      },
    ]);
    // The onboarding planner picks #api from the DOM inventory — not an
    // invented selector. Round 0: click into the API keys page. Round 1: extract.
    browser.dashboardInventory = [API_LINK];
    const llm = new QueueLLM([
      JSON.stringify({ kind: "click", selector: "#api", reason: "open API keys" }),
      JSON.stringify({ kind: "extract", reason: "key visible" }),
    ]);
    const agent = newAgent(browser, llm);
    const result = await agent.signup(oauthTask());

    expect(result.success).toBe(true);
    expect(result.credentials?.api_key).toBe("rnd_onboard_abcdefghij1234567890");
    expect(browser.typeCalls).toHaveLength(0);
  });

  it("extracts a key rendered into a copy <input> (field-value scan)", async () => {
    // Render shows a freshly-created key in a readonly copy-input —
    // whose value is absent from textContent. extractCredentials must
    // scan visible field values, not just page text.
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      CONSENT_BASIC,
      PRODUCT_DASH("Dashboard — open the API Keys page"),
      {
        url: "https://dashboard.render.com/u/settings",
        text: "API Keys — copy your new key:", // key NOT in the page text
      },
    ]);
    browser.dashboardInventory = [API_LINK];
    // The key lives only in a copy-input on the API page (idx 3).
    browser.fieldValuesByIdx = { 3: ["rnd_fieldvalueabcdefghij1234567890"] };
    const llm = new QueueLLM([
      JSON.stringify({ kind: "click", selector: "#api", reason: "open API keys" }),
      JSON.stringify({ kind: "extract", reason: "key visible in the copy field" }),
    ]);
    const result = await newAgent(browser, llm).signup(oauthTask());

    expect(result.success).toBe(true);
    expect(result.credentials?.api_key).toBe("rnd_fieldvalueabcdefghij1234567890");
  });
});

describe("OAuth signup — the critical guarantee (D4)", () => {
  it("hands back needs_login and NEVER types when the Google session is missing", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      {
        url: "https://accounts.google.com/v3/signin/identifier?continue=x",
        text: "Sign in — Use your Google Account. Email or phone",
      },
    ]);
    const inbox = new NeverInbox();
    const agent = newAgent(browser);
    const result = await agent.signup({ ...oauthTask(), inbox });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^needs_login:/);
    // THE GUARANTEE: not one keystroke into Google's login form.
    expect(browser.typeCalls).toHaveLength(0);
    expect(browser.advanceCalls).toBe(0);
    expect(inbox.calls).toBe(0);
  });

  it("hands back needs_login on a Google security challenge", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      {
        url: "https://accounts.google.com/v3/signin/challenge/totp?x",
        text: "2-Step Verification — Enter the code",
      },
    ]);
    const result = await newAgent(browser).signup(oauthTask());

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^needs_login:/);
    expect(browser.typeCalls).toHaveLength(0);
  });

  it("backstops the classifier — a login form mis-read as consent still aborts needs_login", async () => {
    // URL path /signin/oauth → classifier says consent; but the live
    // DOM carries an email input, so it is really a login form.
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      {
        url: "https://accounts.google.com/signin/oauth/x?scope=openid",
        text: "Sign in to continue to Render",
      },
    ]);
    browser.consentPageInventory = [EMAIL_INPUT];
    const result = await newAgent(browser).signup(oauthTask());

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^needs_login:/);
    expect(browser.typeCalls).toHaveLength(0);
    expect(browser.advanceCalls).toBe(0);
  });
});

describe("OAuth signup — consent scope gate (T7)", () => {
  it("aborts oauth_consent_needs_review when the consent asks for broad scope", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      {
        url:
          "https://accounts.google.com/signin/oauth/consent?client_id=abc" +
          "&scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly",
        text: "Render wants access to your Google Account",
      },
    ]);
    const result = await newAgent(browser).signup(oauthTask());

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^oauth_consent_needs_review:/);
    expect(result.error ?? "").toMatch(/gmail\.readonly/);
    // Broad scope is never auto-approved.
    expect(browser.advanceCalls).toBe(0);
    expect(browser.typeCalls).toHaveLength(0);
  });
});

// ───────────────────── GitHub provider (T13) ─────────────────────

describe("GitHub OAuth signup (T13)", () => {
  it("completes a GitHub OAuth signup — clicks GitHub, authorizes, extracts the key", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      CONSENT_GITHUB,
      PRODUCT_DASH("Dashboard — Your API Key: ts_ghkey_abcdefghijklmnop12345"),
    ]);
    browser.signupInventory = [GITHUB_BTN];
    const result = await newAgent(browser).signup({
      ...oauthTask(),
      oauthProvider: "github",
    });

    expect(result.success).toBe(true);
    expect(result.credentials?.api_key).toBe("ts_ghkey_abcdefghijklmnop12345");
    expect(browser.advanceCalls).toBe(1); // one authorize screen, auto-approved
    expect(browser.typeCalls).toHaveLength(0);
    expect(result.steps.some((s) => /GitHub auth state = consent/i.test(s))).toBe(true);
  });

  it("aborts oauth_consent_needs_review on a broad GitHub scope (repo)", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      {
        url: "https://github.com/login/oauth/authorize?client_id=abc&scope=read:user+repo",
        text: "Authorize Render",
      },
    ]);
    browser.signupInventory = [GITHUB_BTN];
    const result = await newAgent(browser).signup({
      ...oauthTask(),
      oauthProvider: "github",
    });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^oauth_consent_needs_review:/);
    expect(result.error ?? "").toMatch(/repo/);
    expect(browser.advanceCalls).toBe(0);
    expect(browser.typeCalls).toHaveLength(0);
  });

  it("hands back needs_login on the GitHub login page — never types", async () => {
    const browser = new FakeOAuthBrowser([
      { url: "https://render.com/register", text: "" },
      { url: "https://github.com/login?return_to=x", text: "Sign in to GitHub" },
    ]);
    browser.signupInventory = [GITHUB_BTN];
    const result = await newAgent(browser).signup({
      ...oauthTask(),
      oauthProvider: "github",
    });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^needs_login:/);
    expect(browser.typeCalls).toHaveLength(0);
    expect(browser.advanceCalls).toBe(0);
  });
});

// ───────────────────── buildSignupResponse status mapping (T10) ─────────────────────

describe("buildSignupResponse — OAuth statuses (T10)", () => {
  const base = { service: "Render" };
  const tail = { steps: [], llm_calls: 0 };

  it("maps a needs_login error to status=needs_login", () => {
    const res = buildSignupResponse(base, {
      success: false,
      error: "needs_login: the bot's Google session is missing or expired",
      ...tail,
    });
    expect(res["status"]).toBe("needs_login");
    expect(String(res["message"])).toMatch(/mcp pair|mcp login/);
  });

  it("maps an oauth_consent_needs_review error to its status", () => {
    const res = buildSignupResponse(base, {
      success: false,
      error: "oauth_consent_needs_review: the consent screen requests scopes beyond basic",
      ...tail,
    });
    expect(res["status"]).toBe("oauth_consent_needs_review");
  });

  it("maps an onboarding_blocked error to its status", () => {
    const res = buildSignupResponse(base, {
      success: false,
      error: "onboarding_blocked: the API key sits behind a billing wall",
      ...tail,
    });
    expect(res["status"]).toBe("onboarding_blocked");
  });

  it("still maps a clean success to status=success", () => {
    const res = buildSignupResponse(base, {
      success: true,
      credentials: { api_key: "k" },
      ...tail,
    });
    expect(res["status"]).toBe("success");
  });
});

// A guard so the post-verify schema stays usable for the OAuth path,
// plus the DOM-grounding gate: an invented click/fill selector is a
// parse-time rejection (the onboarding planner's anti-hallucination).
describe("parsePostVerifyStep", () => {
  it("accepts the selector-free steps the onboarding loop emits", () => {
    expect(parsePostVerifyStep('{"kind":"extract","reason":"x"}').kind).toBe("extract");
    expect(parsePostVerifyStep('{"kind":"done","reason":"x"}').kind).toBe("done");
    expect(parsePostVerifyStep('{"kind":"navigate","url":"https://x/api","reason":"x"}').kind).toBe(
      "navigate",
    );
  });

  it("accepts a click whose selector is in the inventory", () => {
    const allowed = new Set(["#api"]);
    const step = parsePostVerifyStep(
      '{"kind":"click","selector":"#api","reason":"open keys"}',
      allowed,
    );
    expect(step.kind).toBe("click");
  });

  it("rejects a click whose selector was invented (not in the inventory)", () => {
    const allowed = new Set(["#api"]);
    expect(() =>
      parsePostVerifyStep(
        '{"kind":"click","selector":"a[href*=\'api\']","reason":"guessed"}',
        allowed,
      ),
    ).toThrow(/not in the page inventory/);
  });
});
