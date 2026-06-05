// Covers the captcha-gate short-circuit. A signup run has three
// visible-captcha gates (pre-submit, post-submit, re-plan), each
// calling solveVisibleCaptcha() which burns up to 30s. Cloudflare
// scoring is sticky per session: once one gate is blocked the run is
// doomed, so the remaining gates must NOT re-probe — that would waste
// up to 60s more. This verifies the second/third gate skips the
// browser call entirely once any gate has reported `blocked`.

import { describe, expect, it } from "vitest";
import { SignupAgent } from "../agent.js";
import type { CaptchaSolveResult, CaptchaVariant } from "../browser.js";
import type { BrowserController } from "../browser.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../llm-client.js";

class FakeLLM implements LLMClient {
  readonly name = "fake";
  async createMessage(_req: LLMRequest): Promise<LLMResponse> {
    return { text: "{}", backend: this.name };
  }
}

// A browser stub exposing the two methods runCaptchaGate touches —
// solveVisibleCaptcha and detectCaptchaVariant (a pure-read telemetry
// classifier) — plus a call counter. Injected via the unknown-
// narrowing path the existing dual-mode test established —
// BrowserController is a class with private fields, so a structural
// fake can't satisfy the nominal type without this narrowing.
class FakeCaptchaBrowser {
  public solveCalls = 0;
  constructor(
    private readonly result: CaptchaSolveResult,
    private readonly detectResult: {
      variant: CaptchaVariant;
      challengeRendered: boolean;
    } = { variant: "unknown", challengeRendered: false },
  ) {}
  async solveVisibleCaptcha(): Promise<CaptchaSolveResult> {
    this.solveCalls += 1;
    return this.result;
  }
  async detectCaptchaVariant(): Promise<{
    variant: CaptchaVariant;
    challengeRendered: boolean;
  }> {
    return this.detectResult;
  }
  // Invoked by runCaptchaGate's invisible-reCAPTCHA branch to mint the score
  // token; the short-circuit test only asserts the silent-encounter record, so
  // a stub that reports "minted" is sufficient.
  async triggerInvisibleRecaptcha(): Promise<boolean> {
    return true;
  }
}

function agentWith(browser: FakeCaptchaBrowser): SignupAgent {
  const asController: unknown = browser;
  if (!isController(asController)) throw new Error("unreachable");
  return new SignupAgent(asController, new FakeLLM());
}

// The fake only needs to be accepted where BrowserController is
// expected; this guard launders the type without an `as` assertion.
function isController(_value: unknown): _value is BrowserController {
  return true;
}

// Reflection helpers — runCaptchaGate is private, but it is the unit
// under test. We mirror the dual-mode test's documented break-the-
// encapsulation rather than widening the production API for tests.
interface GateResult {
  found: boolean;
  solved: boolean;
  blocked: boolean;
  kind: string;
}
async function runGate(
  agent: SignupAgent,
  label: string,
  steps: string[],
): Promise<GateResult> {
  const fn = (agent as unknown as {
    runCaptchaGate: (l: string, s: string[]) => Promise<GateResult>;
  }).runCaptchaGate.bind(agent);
  return fn(label, steps);
}

describe("captcha gate short-circuit", () => {
  it("probes the browser when no prior gate has blocked", async () => {
    const browser = new FakeCaptchaBrowser({ found: false });
    const agent = agentWith(browser);
    const steps: string[] = [];

    const result = await runGate(agent, "Pre-submit", steps);

    expect(result.blocked).toBe(false);
    expect(result.found).toBe(false);
    expect(browser.solveCalls).toBe(1);
  });

  it("reports blocked and records the encounter on a failed solve", async () => {
    const browser = new FakeCaptchaBrowser({
      found: true,
      solved: false,
      kind: "turnstile",
    });
    const agent = agentWith(browser);
    const steps: string[] = [];

    const result = await runGate(agent, "Pre-submit", steps);

    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("turnstile");
    expect(browser.solveCalls).toBe(1);
  });

  it("skips the browser call on later gates once a gate is blocked", async () => {
    const browser = new FakeCaptchaBrowser({
      found: true,
      solved: false,
      kind: "recaptcha",
    });
    const agent = agentWith(browser);
    const steps: string[] = [];

    // Gate 1: pre-submit — blocked, one real probe.
    const gate1 = await runGate(agent, "Pre-submit", steps);
    expect(gate1.blocked).toBe(true);
    expect(browser.solveCalls).toBe(1);

    // Gate 2: post-submit — must short-circuit (no second probe).
    const gate2 = await runGate(agent, "Post-submit", steps);
    expect(gate2.blocked).toBe(true);
    expect(gate2.kind).toBe("recaptcha");
    expect(browser.solveCalls).toBe(1);

    // Gate 3: re-plan — still short-circuited.
    const gate3 = await runGate(agent, "Re-plan", steps);
    expect(gate3.blocked).toBe(true);
    expect(browser.solveCalls).toBe(1);

    // The skip is logged so the step trail explains the missing probes.
    expect(steps.some((s) => /skipped/i.test(s))).toBe(true);
  });

  it("does not short-circuit after a successfully solved gate", async () => {
    const browser = new FakeCaptchaBrowser({
      found: true,
      solved: true,
      kind: "turnstile",
    });
    const agent = agentWith(browser);
    const steps: string[] = [];

    const gate1 = await runGate(agent, "Pre-submit", steps);
    expect(gate1.blocked).toBe(false);
    expect(gate1.solved).toBe(true);

    // A solved gate leaves the session viable — the next gate probes.
    const gate2 = await runGate(agent, "Post-submit", steps);
    expect(gate2.solved).toBe(true);
    expect(browser.solveCalls).toBe(2);
  });

  // Invisible Turnstile / reCAPTCHA-v3 recording — the silent-pass case
  // the visible gate alone misses (the A/B's CDP-hardening target class).
  function resolveEncounter(
    agent: SignupAgent,
  ): { kind: string; variant: string; challenge_rendered: boolean; blocked: boolean } | undefined {
    return (
      agent as unknown as {
        resolveCaptchaEncounter: () => {
          kind: string;
          variant: string;
          challenge_rendered: boolean;
          blocked: boolean;
        } | undefined;
      }
    ).resolveCaptchaEncounter.bind(agent)();
  }

  it("records a silent invisible-Turnstile encounter when no visible widget", async () => {
    const browser = new FakeCaptchaBrowser({ found: false }, { variant: "turnstile", challengeRendered: false });
    const agent = agentWith(browser);
    const gate = await runGate(agent, "Pre-submit", []);
    expect(gate.found).toBe(false);
    expect(resolveEncounter(agent)).toMatchObject({
      kind: "turnstile",
      variant: "turnstile",
      challenge_rendered: false,
      blocked: false,
    });
  });

  it("records an invisible reCAPTCHA-v3 silent encounter", async () => {
    const browser = new FakeCaptchaBrowser({ found: false }, { variant: "recaptcha_v3", challengeRendered: false });
    const agent = agentWith(browser);
    await runGate(agent, "Pre-submit", []);
    expect(resolveEncounter(agent)).toMatchObject({
      kind: "recaptcha",
      variant: "recaptcha_v3",
      challenge_rendered: false,
      blocked: false,
    });
  });

  it("a VISIBLE blocked encounter wins over a synthesized invisible one", async () => {
    const browser = new FakeCaptchaBrowser(
      { found: true, solved: false, kind: "turnstile" },
      { variant: "turnstile", challengeRendered: true },
    );
    const agent = agentWith(browser);
    await runGate(agent, "Pre-submit", []);
    expect(resolveEncounter(agent)).toMatchObject({ blocked: true });
  });

  it("no captcha of any kind → no encounter synthesized", async () => {
    const browser = new FakeCaptchaBrowser({ found: false }, { variant: "unknown", challengeRendered: false });
    const agent = agentWith(browser);
    await runGate(agent, "Pre-submit", []);
    expect(resolveEncounter(agent)).toBeUndefined();
  });
});
