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
  findGoogleOAuthButton,
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
const EMAIL_INPUT = mk({ tag: "input", type: "email", selector: "#email" });

// One scripted page: the URL + visible body text the fake serves while
// the run "sits" on it. Navigation steps advance the page pointer.
interface ScriptPage {
  url: string;
  text: string;
}

// Fake browser driven by a page script. startOAuth / advanceGoogleConsent
// / click / goto-navigate advance the pointer; everything else reads the
// current page. extractInteractiveElements returns the signup-page
// inventory at page 0 and `googlePageInventory` afterwards (empty = a
// genuine consent screen; an input present = a Google login form).
class FakeOAuthBrowser {
  public idx = 0;
  public typeCalls: Array<{ selector: string; text: string }> = [];
  public startOAuthCalls = 0;
  public advanceCalls = 0;
  public settleCalls = 0;
  public advanceResult = true;
  public signupInventory: InteractiveElement[] = [GOOGLE_BTN];
  public googlePageInventory: InteractiveElement[] = [];
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

  async extractText(): Promise<string> {
    return this.page().text;
  }
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    return this.idx === 0 ? this.signupInventory : this.googlePageInventory;
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
  currentUrl(): string {
    return this.page().url;
  }
  oauthPageClosed(): boolean {
    return this.popupClosed;
  }
  async advanceGoogleConsent(): Promise<boolean> {
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
  return new SignupAgent(asController, llm ?? new QueueLLM(["{}"]));
}

const CONSENT_BASIC: ScriptPage = {
  url: "https://accounts.google.com/signin/oauth/consent?scope=openid+email+profile&client_id=abc",
  text: "Render wants access to your Google Account",
};
const PRODUCT_DASH = (text: string): ScriptPage => ({
  url: "https://dashboard.render.com/",
  text,
});

// ───────────────────── findGoogleOAuthButton ─────────────────────

describe("findGoogleOAuthButton", () => {
  it("matches a 'Continue with Google' button", () => {
    expect(findGoogleOAuthButton([GOOGLE_BTN])?.selector).toBe("#google-oauth");
  });

  it("matches a 'Sign up with Google' link and an aria-labelled icon button", () => {
    const link = mk({ tag: "a", visibleText: "Sign up with Google", selector: "#a" });
    const icon = mk({ tag: "button", ariaLabel: "Sign in with Google", selector: "#b" });
    expect(findGoogleOAuthButton([link])?.selector).toBe("#a");
    expect(findGoogleOAuthButton([icon])?.selector).toBe("#b");
  });

  it("returns null for a page with no Google affordance", () => {
    expect(
      findGoogleOAuthButton([
        EMAIL_INPUT,
        mk({ tag: "button", visibleText: "Create account", selector: "#go" }),
      ]),
    ).toBeNull();
  });

  it("ignores a non-auth link that merely mentions Google", () => {
    const docs = mk({ tag: "a", visibleText: "Powered by Google Cloud", selector: "#d" });
    expect(findGoogleOAuthButton([docs])).toBeNull();
  });
});

// ───────────────────── scoreSignupButton oauthFirst ─────────────────────

describe("scoreSignupButton — OAuth-first flip", () => {
  it("scores a Google button negative by default, positive under OAuth-first", () => {
    expect(scoreSignupButton("Continue with Google")).toBeLessThan(0);
    expect(scoreSignupButton("Continue with Google", true)).toBeGreaterThan(0);
  });

  it("keeps other OAuth providers negative even under OAuth-first (Phase 1 is Google-only)", () => {
    expect(scoreSignupButton("Continue with GitHub", true)).toBeLessThan(0);
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
    // Round 0: click into the API keys page. Round 1: extract.
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
    browser.googlePageInventory = [EMAIL_INPUT];
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

// A guard so the post-verify schema stays usable for the OAuth path.
describe("parsePostVerifyStep", () => {
  it("accepts the steps the OAuth onboarding loop emits", () => {
    expect(parsePostVerifyStep('{"kind":"extract","reason":"x"}').kind).toBe("extract");
    expect(parsePostVerifyStep('{"kind":"done","reason":"x"}').kind).toBe("done");
  });
});
