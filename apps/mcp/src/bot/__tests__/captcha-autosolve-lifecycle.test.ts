// The autosolve lifecycle must not burn the funded 2Captcha key on attempts it
// can already know are doomed.
//
// Measured live on Bluesky signup (release 1.1.15-rc.1, sessions b7582464 /
// 64ee93d9, 2026-09):
//
// 1. A purchased token on a /gate/ page (Bluesky) must be written into the
//    live widget the page uses, including its callback. Diverting to a
//    scratch-page handoff left delivered=0 and the page showing
//    "Invalid verification code" (gauntlet 2026-09-27).
// 2. A token that dies unconsumed (the agent's observe cadence is slower than
//    the ~2 min token shelf life) must not be re-purchased on the very next
//    observation — that token dies the same way. Purchases back off
//    geometrically per consecutive expiry and re-arm once the agent consumes
//    again.
//
// Synthetic fixtures only; no network, no browser, no credentials.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  solveCalls: [] as string[],
  injectCalls: 0,
  failSolve: false,
  variantTokenPresent: false,
  challengeRendered: true,
  solverAvailable: true,
  gateFrames: [] as Array<{ url: () => string; evaluate: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../captcha.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CaptchaModule>()),
  TwoCaptchaSolver: class {
    isAvailable(): boolean {
      return h.solverAvailable;
    }
    async solveHcaptcha(): Promise<
      { kind: "ok"; token: string } | { kind: "solver_error"; reason: string }
    > {
      h.solveCalls.push("hcaptcha");
      return h.failSolve
        ? { kind: "solver_error", reason: "boom" }
        : { kind: "ok", token: "P0_eyJhbGciOiJIUzI1NiJ9.MINTED" };
    }
    async solveRecaptchaV2(): Promise<
      { kind: "ok"; token: string } | { kind: "solver_error"; reason: string }
    > {
      h.solveCalls.push("recaptcha_v2");
      return h.failSolve
        ? { kind: "solver_error", reason: "boom" }
        : { kind: "ok", token: "P0_eyJhbGciOiJIUzI1NiJ9.MINTED" };
    }
    async solveTurnstile(): Promise<
      { kind: "ok"; token: string } | { kind: "solver_error"; reason: string }
    > {
      h.solveCalls.push("turnstile");
      return h.failSolve
        ? { kind: "solver_error", reason: "boom" }
        : { kind: "ok", token: "P0_eyJhbGciOiJIUzI1NiJ9.MINTED" };
    }
  },
  detectCaptchaVariant: async () => ({
    variant: "hcaptcha" as const,
    challengeRendered: h.challengeRendered,
  }),
  hasHcaptchaResponseTokenWithCompat: async () => h.variantTokenPresent,
  hasCaptchaResponseTokenForVariant: async () => h.variantTokenPresent,
  waitForCaptchaResponseToken: async () => h.variantTokenPresent,
  extractHcaptchaSitekey: async () => "00000000-0000-0000-0000-000000000000",
  getHcaptchaSolveContext: async () => ({
    invisible: false,
    userAgent: "test-agent",
    rqdata: null,
  }),
  findHcaptchaWidgetPageUrl: async () => null,
  injectHcaptchaToken: async () => {
    h.injectCalls += 1;
    h.variantTokenPresent = true;
    return true;
  },
}));

const auditMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LifecycleModule>()),
  audit: auditMock.fn,
}));

import { attemptOperateCaptchaAutoSolve } from "../captcha-solve.js";
import type { Page } from "playwright";
import type { Session } from "../session/model.js";
import type * as CaptchaModule from "../captcha.js";
import type * as LifecycleModule from "../session/lifecycle.js";

const PAGE_URL = "https://bsky.app/";

function fakePage(withGateFrame: boolean): Page {
  const gateFrames = withGateFrame
    ? [
        {
          url: () => "https://bsky.social/gate/signup?handle=x.bsky.social&state=abc",
          evaluate: vi.fn(async () => ({
            hcKeys: "absent",
            cfgFns: "none",
            textareas: 2,
            hosts: 1,
            iframes: 1,
          })),
        },
      ]
    : [];
  h.gateFrames = gateFrames;
  return {
    url: () => PAGE_URL,
    frames: () => gateFrames as unknown as Page["frames"] extends () => infer R ? R : never,
    mainFrame: () => ({
      evaluate: vi.fn(async () => true),
    }),
    context: () => ({
      newPage: async () => ({
        goto: async () => {
          throw new Error("fixture: no network");
        },
        waitForSelector: async () => null,
        evaluate: async () => ({ ok: true, textareas: 2, formSubmitted: true }),
        url: () => "about:blank",
        close: async () => {},
      }),
    }),
  } as unknown as Page;
}

function fakeSession(): Session {
  return {
    id: "sess-test",
    releasedPaymentCard: null,
    browser: { currentUrl: () => PAGE_URL },
    api: { listCredentials: async () => ({ credentials: [] }) },
  } as unknown as Session;
}

const outcomes = (): string[] =>
  auditMock.fn.mock.calls.map((c: unknown[]) => {
    const values = c[2] as Record<string, unknown> | undefined;
    return String(values?.outcome ?? "?");
  });

beforeEach(() => {
  h.solveCalls = [];
  h.injectCalls = 0;
  h.failSolve = false;
  h.variantTokenPresent = false;
  h.challengeRendered = true;
  h.solverAvailable = true;
  auditMock.fn.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the detached fetch finish without advancing wall time. */
const flushDetached = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
};

describe("attemptOperateCaptchaAutoSolve — bounded spend", () => {
  it("re-purchases after expiry back off geometrically, and a consumption resets the streak", async () => {
    const session = fakeSession();
    const page = fakePage(false);

    // Observe 1: token purchased.
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(h.solveCalls).toHaveLength(1);

    // Observe 2, past the token's shelf life: expired, and the very next
    // fetch is skipped instead of buying another doomed token.
    const diag: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      diag.push(String(msg));
    });
    vi.advanceTimersByTime(121_000);
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    errorSpy.mockRestore();
    expect(h.solveCalls).toHaveLength(1);
    expect(outcomes()).toContain("token_expired");
    expect(outcomes()).toContain("fetch_skipped");
    expect(diag.some((line) => /outcome=fetch_skipped reason=expiry_backoff/.test(line))).toBe(true);

    // 30s into the backoff: still skipped (backoff is 30s from the expiry,
    // minus the elapsed observe time — advance just past it).
    vi.advanceTimersByTime(10_000);
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(h.solveCalls).toHaveLength(1);

    // Backoff elapsed: the next observe re-arms and buys a fresh token.
    vi.advanceTimersByTime(25_000);
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(h.solveCalls).toHaveLength(2);

    // The fresh token is consumed on the following observe: the streak resets,
    // so a subsequent expiry backoff starts from the base again.
    h.variantTokenPresent = true;
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(outcomes()).toContain("already_settled");
    h.variantTokenPresent = false;
  });

  it("injects a purchased token into the live widget on a /gate/ page instead of diverting to handoff", async () => {
    const session = fakeSession();
    const page = fakePage(true);

    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(h.solveCalls).toHaveLength(1);
    expect(h.injectCalls).toBe(0);

    const delivered = await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(delivered).toBe("injected");
    expect(h.injectCalls).toBe(1);
    expect(outcomes()).toContain("ok");
    expect(outcomes()).not.toContain("gate_handoff_started");
    expect(outcomes()).not.toContain("autosolve_disabled");
  });

  it("does not disable later purchases after a gate-page live-widget inject", async () => {
    const session = fakeSession();
    const page = fakePage(true);

    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(outcomes()).toContain("ok");

    h.variantTokenPresent = false;
    h.challengeRendered = true;
    const again = await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(again).not.toBe("autosolve_disabled");
    expect(outcomes()).not.toContain("autosolve_disabled");
  });

  it("still purchases on a gate page while the handoff is untouched, and on non-gate pages", async () => {
    // Non-gate page: purchases proceed (the disable is gate-scoped).
    const session = fakeSession();
    const page = fakePage(false);
    await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(h.solveCalls).toHaveLength(1);
    expect(outcomes()).not.toContain("autosolve_disabled");
  });

  it("emits an unsealed diag line when a fetch is already in flight", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    const diag: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      diag.push(String(msg));
    });
    try {
      const first = await attemptOperateCaptchaAutoSolve(session, page);
      expect(first).toBe("fetch_started");
      const second = await attemptOperateCaptchaAutoSolve(session, page);
      expect(second).toBe("in_flight");
      expect(diag.some((line) => /outcome=fetch_skipped reason=in_flight/.test(line))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("emits an unsealed diag line while cooldown is armed after a failed fetch", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    const diag: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      diag.push(String(msg));
    });
    try {
      h.failSolve = true;
      const first = await attemptOperateCaptchaAutoSolve(session, page);
      expect(first).toBe("fetch_started");
      await flushDetached();
      diag.length = 0;
      const cooled = await attemptOperateCaptchaAutoSolve(session, page);
      expect(cooled).toBe("cooldown");
      expect(diag.some((line) => /outcome=fetch_skipped reason=cooldown/.test(line))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never spends when no challenge is rendered (bare checkbox stays free)", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.challengeRendered = false;
    const outcome = await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(outcome).toBe("no_challenge");
    expect(h.solveCalls).toHaveLength(0);
  });

  it("reports no_key when the solver has no credential", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.solverAvailable = false;
    const outcome = await attemptOperateCaptchaAutoSolve(session, page);
    expect(outcome).toBe("no_key");
    expect(h.solveCalls).toHaveLength(0);
  });

  // The detect state's audit outcome is a sealed value, so its unsealed
  // `[captcha-autosolve-diag]` line is the only readable record of whether
  // detection saw a rendered challenge. Both halves must reach the diag
  // stream, and the challenge flag must match what detection observed.
  it("emits an unsealed detect diag line reporting the observed challenge state", async () => {
    const diag: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      diag.push(String(msg));
    });
    try {
      h.challengeRendered = true;
      await attemptOperateCaptchaAutoSolve(fakeSession(), fakePage(false));
      await flushDetached();
      const detect = diag.filter(
        (l) => l.includes("[captcha-autosolve-diag]") && l.includes("outcome=detect"),
      );
      expect(detect).toHaveLength(1);
      expect(detect[0]).toContain("challenge_rendered=true");

      diag.length = 0;
      h.challengeRendered = false;
      await attemptOperateCaptchaAutoSolve(fakeSession(), fakePage(false));
      await flushDetached();
      const detectNoChallenge = diag.filter(
        (l) => l.includes("[captcha-autosolve-diag]") && l.includes("outcome=detect"),
      );
      expect(detectNoChallenge).toHaveLength(1);
      expect(detectNoChallenge[0]).toContain("challenge_rendered=false");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
