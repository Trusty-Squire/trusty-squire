// Covers the submit-failure fail-fast path (TODOS.md S2.2). When the
// submit button can't be clicked — e.g. an ambiguous selector matched
// several buttons and none disambiguated — signup() must return
// `submit_failed` immediately, NOT fall through into the multi-minute
// verification-email poll for an email that can never arrive. That
// false 5-minute "hang" is the bug this guards.

import { describe, expect, it } from "vitest";
import { SignupAgent, type AgentInbox } from "../agent.js";
import type { BrowserController, BrowserState, CaptchaSolveResult } from "../browser.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../llm-client.js";

// Returns a valid signup plan so signup() proceeds all the way to the
// submit step (where the fake browser then throws).
class PlanLLM implements LLMClient {
  readonly name = "fake-plan";
  async createMessage(_req: LLMRequest): Promise<LLMResponse> {
    return {
      text: JSON.stringify({
        actions: [
          { kind: "fill", selector: "#email", value_kind: "email", reason: "email" },
        ],
        submit_selector: "button[type=submit]",
        confidence: "high",
      }),
      backend: this.name,
    };
  }
}

// Browser stub: every method signup() touches before the submit is a
// no-op; clickSubmit throws to simulate the ambiguous-selector failure
// (the real Resend run: selector matched 3 button[type=submit]).
class SubmitFailsBrowser {
  get channel(): string | null {
    return null;
  }
  async prewarm(): Promise<void> {}
  async goto(): Promise<void> {}
  async wait(): Promise<void> {}
  async waitForFormReady(): Promise<void> {}
  async type(): Promise<void> {}
  async check(): Promise<void> {}
  async click(): Promise<void> {}
  async extractText(): Promise<string> {
    return "";
  }
  async solveVisibleCaptcha(): Promise<CaptchaSolveResult> {
    return { found: false };
  }
  async getState(): Promise<BrowserState> {
    return {
      url: "https://resend.com/signup",
      title: "Sign up",
      html: "<form></form>",
      screenshot: "",
    };
  }
  async clickSubmit(selector: string): Promise<void> {
    throw new Error(
      `submit selector "${selector}" matched 3 buttons, none scoring as a signup button`,
    );
  }
}

// Inbox spy: records whether the verification-email poll was entered.
class SpyInbox implements AgentInbox {
  public waitCalls = 0;
  async waitForEmail(): Promise<{
    subject: string;
    from_address: string;
    parsed_links: ReadonlyArray<string>;
  }> {
    this.waitCalls += 1;
    throw new Error("inbox should not have been polled");
  }
}

// The fake only needs to be accepted where BrowserController is
// expected; this guard launders the type without an `as` assertion —
// same pattern as captcha-short-circuit.test.ts.
function isController(_v: unknown): _v is BrowserController {
  return true;
}

describe("signup() submit-failure fail-fast", () => {
  it("returns submit_failed and skips the verification poll", async () => {
    const browser = new SubmitFailsBrowser();
    const asController: unknown = browser;
    if (!isController(asController)) throw new Error("unreachable");
    const agent = new SignupAgent(asController, new PlanLLM());
    const inbox = new SpyInbox();

    const result = await agent.signup({
      service: "Resend",
      signupUrl: "https://resend.com/signup",
      email: "bot@inbox.test",
      generatePassword: () => "Pw-test-12345",
      inbox,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^submit_failed:/);
    // The fail-fast must happen BEFORE the verification poll — otherwise
    // the run sits in a multi-minute wait for an email that can never
    // arrive (the original false "hang").
    expect(inbox.waitCalls).toBe(0);
    // The real reason is surfaced in the step trail, not buried.
    expect(result.steps.some((s) => /submit click failed/i.test(s))).toBe(true);
  });
});
