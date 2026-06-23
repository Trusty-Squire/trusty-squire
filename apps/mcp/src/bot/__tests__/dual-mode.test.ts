// Verifies the cheap-first / premium-fallback retry mechanism in
// SignupAgent.callLLM. We don't run the browser or hit a real model;
// we inject hand-crafted LLMClient fakes via a small reflection trick
// since callLLM is private.

import { describe, expect, it } from "vitest";
import { SignupAgent, LLMCallBudgetExceeded } from "../agent.js";
import type { LLMClient, LLMRequest, LLMResponse, LLMPair } from "../llm-client.js";
import type { BrowserController } from "../browser.js";

class FakeLLM implements LLMClient {
  readonly name: string;
  public callCount = 0;
  constructor(name: string, private readonly reply: string | (() => string)) {
    this.name = name;
  }
  async createMessage(_req: LLMRequest): Promise<LLMResponse> {
    this.callCount += 1;
    const text = typeof this.reply === "function" ? this.reply() : this.reply;
    return { text, backend: this.name };
  }
}

// Construct a SignupAgent that bypasses the real picker by reaching
// into the private llmPair field. We're explicit about the
// intentional break-the-encapsulation since the alternative would be
// adding production code purely for testing.
function agentWithPair(pair: LLMPair): SignupAgent {
  const browserStub = {} as unknown as BrowserController;
  // First arg is browser; second arg is a single LLMClient injection
  // path which makes the constructor set premium=null. We then swap
  // the whole pair afterwards.
  const agent = new SignupAgent(browserStub, pair.primary);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as unknown as { llmPair: LLMPair }).llmPair = pair;
  return agent;
}

// Tiny helper that calls the private callLLM method.
async function callLLM<T>(
  agent: SignupAgent,
  args: {
    system: string;
    userBlocks: never[];
    maxTokens: number;
    parse?: (raw: string) => T;
  },
): Promise<T extends undefined ? string : T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (agent as any).callLLM(args);
}

describe("SignupAgent dual-mode LLM fallback", () => {
  it("uses primary when its reply parses cleanly", async () => {
    const primary = new FakeLLM("primary:cheap", `{"value":42}`);
    const premium = new FakeLLM("premium:sonnet", "should not be called");
    const agent = agentWithPair({ primary, premium });

    const result = await callLLM<{ value: number }>(agent, {
      system: "",
      userBlocks: [],
      maxTokens: 100,
      parse: (raw) => JSON.parse(raw) as { value: number },
    });

    expect(result).toEqual({ value: 42 });
    expect(primary.callCount).toBe(1);
    expect(premium.callCount).toBe(0);
    expect(agent.backends).toEqual(["primary:cheap"]);
  });

  it("falls back to premium when primary returns unparseable JSON", async () => {
    const primary = new FakeLLM("primary:cheap", "I'm sorry, I cannot comply.");
    const premium = new FakeLLM("premium:sonnet", `{"value":99}`);
    const agent = agentWithPair({ primary, premium });

    const result = await callLLM<{ value: number }>(agent, {
      system: "",
      userBlocks: [],
      maxTokens: 100,
      parse: (raw) => {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m === null) throw new Error("no JSON");
        return JSON.parse(m[0]) as { value: number };
      },
    });

    expect(result).toEqual({ value: 99 });
    expect(primary.callCount).toBe(1);
    expect(premium.callCount).toBe(1);
    expect(agent.backends).toEqual(["primary:cheap", "premium:sonnet"]);
  });

  it("surfaces premium's parse error when both fail", async () => {
    const primary = new FakeLLM("primary:cheap", "garbage");
    const premium = new FakeLLM("premium:sonnet", "still garbage");
    const agent = agentWithPair({ primary, premium });

    await expect(
      callLLM(agent, {
        system: "",
        userBlocks: [],
        maxTokens: 100,
        parse: (raw) => {
          if (!raw.includes("{")) throw new Error(`unparseable: ${raw}`);
          return raw;
        },
      }),
    ).rejects.toThrow(/still garbage/);
  });

  it("does not fall back to premium when there is no parse callback", async () => {
    const primary = new FakeLLM("primary:cheap", "raw text");
    const premium = new FakeLLM("premium:sonnet", "should not be called");
    const agent = agentWithPair({ primary, premium });

    const raw = await callLLM(agent, {
      system: "",
      userBlocks: [],
      maxTokens: 100,
    });

    expect(raw).toBe("raw text");
    expect(premium.callCount).toBe(0);
  });

  // 0.8.2-rc.8 — failed createMessage calls don't tick llmCallCount.
  // The rc.7 sentry batch surfaced this: 2 upstream-blip retries
  // consumed 2 of the 15 budget units before the proxy's own
  // retry-with-backoff gave up and surfaced an error. Counting those
  // failed calls against the planner's budget is wrong — they
  // produced no plan and the planner has to re-issue the request
  // anyway. Behave like a meter: only count consumption that actually
  // delivered a reply.
  it("does NOT tick llmCallCount when createMessage throws", async () => {
    class FailingThenOkLLM implements LLMClient {
      readonly name = "flake";
      public callCount = 0;
      async createMessage(): Promise<LLMResponse> {
        this.callCount += 1;
        if (this.callCount <= 2) {
          throw new Error("upstream_error: 502");
        }
        return { text: `{"value":99}`, backend: this.name };
      }
    }
    const primary = new FailingThenOkLLM();
    const agent = agentWithPair({ primary, premium: null });

    // First two calls throw. Capture the budget state by attempting
    // and rescuing each one, then a third call should succeed.
    await expect(
      callLLM(agent, {
        system: "",
        userBlocks: [],
        maxTokens: 100,
        parse: (raw) => JSON.parse(raw) as unknown,
      }),
    ).rejects.toThrow(/502/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any).llmCallCount).toBe(0);

    await expect(
      callLLM(agent, {
        system: "",
        userBlocks: [],
        maxTokens: 100,
        parse: (raw) => JSON.parse(raw) as unknown,
      }),
    ).rejects.toThrow(/502/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any).llmCallCount).toBe(0);

    const ok = await callLLM<{ value: number }>(agent, {
      system: "",
      userBlocks: [],
      maxTokens: 100,
      parse: (raw) => JSON.parse(raw) as { value: number },
    });
    expect(ok).toEqual({ value: 99 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any).llmCallCount).toBe(1);
    expect(primary.callCount).toBe(3);
  });

  it("throws LLMCallBudgetExceeded when the cap is hit", async () => {
    // Set the budget low using the env var, then build a fresh agent.
    const original = process.env["UNIVERSAL_BOT_MAX_LLM_CALLS"];
    process.env["UNIVERSAL_BOT_MAX_LLM_CALLS"] = "2";
    try {
      // Re-import to pick up the new env value. We can't easily
      // re-evaluate the module constant, so instead verify the
      // mechanism via the constant we already have: simulate the
      // count by setting it to the default cap.
      // (The constant lives at module scope so changing the env
      // post-import doesn't help. Test the symptom: forced-bail.)
      const primary = new FakeLLM("primary", `{"ok":true}`);
      const agent = agentWithPair({ primary, premium: null });
      // Burn through the default cap by manipulating the counter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (agent as any).llmCallCount = 30;

      await expect(
        callLLM(agent, {
          system: "",
          userBlocks: [],
          maxTokens: 100,
          parse: (raw) => JSON.parse(raw) as unknown,
        }),
      ).rejects.toBeInstanceOf(LLMCallBudgetExceeded);
    } finally {
      if (original === undefined) {
        delete process.env["UNIVERSAL_BOT_MAX_LLM_CALLS"];
      } else {
        process.env["UNIVERSAL_BOT_MAX_LLM_CALLS"] = original;
      }
    }
  });
});
