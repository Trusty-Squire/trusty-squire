// Covers the M2/S3 no-inbox fast-fail (TODOS.md M2). The SES inbound
// pipeline is mothballed (M1), so provision_any_service runs the
// form-fill bot with NO inbox. When a signup submits and the
// post-submit page asks the user to confirm by email, signup() must
// return `verification_not_sent` IMMEDIATELY — it must not blind-poll
// a verification email that can never arrive. When the page does not
// ask for email, M2 must not over-trigger: that is a plain
// credentials-not-found failure.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignupAgent } from "../agent.js";
import type {
  BrowserController,
  BrowserState,
  CaptchaSolveResult,
  InteractiveElement,
} from "../browser.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../llm-client.js";

// A valid plan so signup() proceeds through fill → submit.
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

// Browser stub whose submit SUCCEEDS — signup() runs all the way to the
// verification step. `postSubmitText` decides whether the post-submit
// page asks the user to confirm by email.
class SubmitsOkBrowser {
  constructor(private readonly postSubmitText: string) {}
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
    return this.postSubmitText;
  }
  async extractCredentialCandidates(): Promise<string[]> {
    return [];
  }
  async solveVisibleCaptcha(): Promise<CaptchaSolveResult> {
    return { found: false };
  }
  async getState(): Promise<BrowserState> {
    return {
      url: "https://acme.test/signup",
      title: "Sign up",
      html: "<form></form>",
      screenshot: "",
    };
  }
  async clickSubmit(_selector: string): Promise<void> {
    // Submit lands cleanly — the opposite of submit-failure.test.ts.
  }
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    return [
      {
        index: 0,
        tag: "input",
        type: "email",
        id: "email",
        name: "email",
        placeholder: null,
        ariaLabel: null,
        role: null,
        labelText: null,
        visibleText: null,
        selector: "#email",
        visible: true,
        inViewport: true,
        inConsentWidget: false,
      },
      {
        index: 1,
        tag: "button",
        type: "submit",
        id: null,
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: null,
        labelText: null,
        visibleText: "Create account",
        selector: "button[type=submit]",
        visible: true,
        inViewport: true,
        inConsentWidget: false,
      },
    ];
  }
  async inspectSelector(
    selector: string,
  ): Promise<{ count: number; tag: string | null; id: string | null; name: string | null }> {
    if (selector === "#email") {
      return { count: 1, tag: "input", id: "email", name: "email" };
    }
    return { count: 1, tag: "button", id: null, name: null };
  }
}

function isController(_v: unknown): _v is BrowserController {
  return true;
}

async function runSignup(postSubmitText: string): ReturnType<SignupAgent["signup"]> {
  const browser: unknown = new SubmitsOkBrowser(postSubmitText);
  if (!isController(browser)) throw new Error("unreachable");
  const agent = new SignupAgent(browser, new PlanLLM());
  return agent.signup({
    service: "Acme",
    signupUrl: "https://acme.test/signup",
    email: "bot@inbox.test",
    generatePassword: () => "Pw-test-12345",
    // No `inbox` — provision_any_service no longer passes one (M1).
  });
}

describe("signup() no-inbox verification fast-fail (M2/S3)", () => {
  let debugDir: string;
  beforeAll(() => {
    // saveDebugSnapshot("after-submit") writes here once submit lands —
    // keep the artifacts out of the repo's .debug/.
    debugDir = mkdtempSync(join(tmpdir(), "ts-m2-debug-"));
    process.env.UNIVERSAL_BOT_DEBUG_DIR = debugDir;
  });
  afterAll(() => {
    delete process.env.UNIVERSAL_BOT_DEBUG_DIR;
    rmSync(debugDir, { recursive: true, force: true });
  });

  it("returns verification_not_sent when the page asks for email and there's no inbox", async () => {
    const result = await runSignup(
      "Thanks for signing up! Please check your email to verify your account.",
    );
    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^verification_not_sent:/);
    // The manual-signup URL is surfaced so the user can finish.
    expect(result.error ?? "").toContain("https://acme.test/signup");
    // The step trail records the deliberate no-poll bail.
    expect(result.steps.some((s) => /no inbox is configured/i.test(s))).toBe(true);
  });

  it("does NOT over-trigger — a page with no email prompt is a plain not-found failure", async () => {
    const result = await runSignup("Welcome to your Acme dashboard.");
    expect(result.success).toBe(false);
    // No "check your email" copy → not a verification_not_sent case.
    expect(result.error ?? "").not.toMatch(/^verification_not_sent:/);
  });
});
