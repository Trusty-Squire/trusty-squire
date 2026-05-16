// F2 — the top-level signup() deadline. Every sub-step is bounded, yet
// the 2026-05-16 sweep produced 50-minute hangs: something outside the
// timed paths (a wedged navigation) can stall. signup() must always
// return — this verifies a hung browser call resolves to a clean
// `run_timeout` result instead of hanging forever.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignupAgent } from "../agent.js";
import type { BrowserController } from "../browser.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../llm-client.js";

class FakeLLM implements LLMClient {
  readonly name = "fake";
  async createMessage(_req: LLMRequest): Promise<LLMResponse> {
    return { text: "{}", backend: this.name };
  }
}

// goto() never resolves — runSignup() wedges there, exactly like a
// real navigation that hangs. prewarm + channel are all signup()
// touches before goto.
class HangingBrowser {
  get channel(): string | null {
    return null;
  }
  async prewarm(): Promise<void> {}
  async goto(): Promise<void> {
    return new Promise<void>(() => {
      /* never resolves */
    });
  }
}

// Launders the structural fake into the nominal BrowserController type
// without an `as` assertion — same pattern as the sibling bot tests.
function isController(_v: unknown): _v is BrowserController {
  return true;
}

describe("signup() top-level timeout", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env["UNIVERSAL_BOT_RUN_TIMEOUT_MS"];
    // 80ms — long enough to enter the run, short enough for a fast test.
    process.env["UNIVERSAL_BOT_RUN_TIMEOUT_MS"] = "80";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env["UNIVERSAL_BOT_RUN_TIMEOUT_MS"];
    else process.env["UNIVERSAL_BOT_RUN_TIMEOUT_MS"] = saved;
  });

  it("returns run_timeout instead of hanging when a browser call wedges", async () => {
    const browser = new HangingBrowser();
    const asController: unknown = browser;
    if (!isController(asController)) throw new Error("unreachable");
    const agent = new SignupAgent(asController, new FakeLLM());

    const result = await agent.signup({
      service: "Hangsville",
      signupUrl: "https://hangsville.test/signup",
      email: "bot@inbox.test",
      generatePassword: () => "Pw-test-12345",
    });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/^run_timeout:/);
    expect(result.steps.some((s) => /aborting/i.test(s))).toBe(true);
  });
});
