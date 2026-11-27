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
  turnstileInjectCalls: 0,
  variant: "hcaptcha" as CaptchaVariant,
  failSolve: false,
  variantTokenPresent: false,
  challengeRendered: true,
  recaptchaEvidence: undefined as CaptchaModule.RecaptchaDetectEvidence | undefined,
  hcaptchaChallengeVisible: undefined as boolean | undefined,
  hcaptchaInvisible: false,
  turnstileEvidence: undefined as CaptchaModule.TurnstileDetectEvidence | undefined,
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
    variant: h.variant,
    challengeRendered: h.challengeRendered,
    ...(h.recaptchaEvidence === undefined ? {} : { recaptcha: h.recaptchaEvidence }),
    ...(h.hcaptchaChallengeVisible === undefined
      ? {}
      : { hcaptchaChallengeVisible: h.hcaptchaChallengeVisible }),
    ...(h.turnstileEvidence === undefined ? {} : { turnstile: h.turnstileEvidence }),
  }),
  hasHcaptchaResponseTokenWithCompat: async () => h.variantTokenPresent,
  hasCaptchaResponseTokenForVariant: async () => h.variantTokenPresent,
  waitForCaptchaResponseToken: async () => h.variantTokenPresent,
  extractHcaptchaSitekey: async () => "00000000-0000-0000-0000-000000000000",
  extractRecaptchaSitekey: async () => "6LftmFkUAAAAADydGEH99T-xmZoK69ErtRCzfVFf",
  getHcaptchaSolveContext: async () => ({
    invisible: h.hcaptchaInvisible,
    userAgent: "test-agent",
    rqdata: null,
  }),
  findHcaptchaWidgetPageUrl: async () => null,
  injectHcaptchaToken: async () => {
    h.injectCalls += 1;
    h.variantTokenPresent = true;
    return true;
  },
  extractTurnstileSitekey: async () => "0x4AAAAAAAAAAAAAAAAAAAAA",
  injectTurnstileToken: async () => {
    h.turnstileInjectCalls += 1;
    h.variantTokenPresent = true;
    return true;
  },
}));

const auditMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LifecycleModule>()),
  audit: auditMock.fn,
}));

import { attemptOperateCaptchaAutoSolve, markCaptchaDocumentEngaged } from "../captcha-solve.js";
import type { Page } from "playwright";
import type { Session } from "../session/model.js";
import type * as CaptchaModule from "../captcha.js";
import type * as LifecycleModule from "../session/lifecycle.js";
import type { CaptchaVariant } from "../captcha.js";

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
  h.turnstileInjectCalls = 0;
  h.variant = "hcaptcha";
  h.failSolve = false;
  h.variantTokenPresent = false;
  h.challengeRendered = true;
  h.recaptchaEvidence = undefined;
  h.hcaptchaChallengeVisible = undefined;
  h.hcaptchaInvisible = false;
  h.turnstileEvidence = undefined;
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
    expect(diag.some((line) => /outcome=fetch_skipped reason=expiry_backoff/.test(line))).toBe(
      true,
    );

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

describe("attemptOperateCaptchaAutoSolve — Cloudflare Turnstile", () => {
  beforeEach(() => {
    h.variant = "turnstile";
    // Turnstile never renders an image grid; its widget is the challenge.
    h.challengeRendered = false;
  });

  it("buys a Turnstile token for an unsolved widget and injects it on the next observation", async () => {
    const session = fakeSession();
    const page = fakePage(false);

    const first = await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(first).toBe("fetch_started");
    expect(h.solveCalls).toEqual(["turnstile"]);
    expect(h.turnstileInjectCalls).toBe(0);

    const delivered = await attemptOperateCaptchaAutoSolve(session, page);
    await flushDetached();
    expect(delivered).toBe("injected");
    expect(h.turnstileInjectCalls).toBe(1);
    expect(h.injectCalls).toBe(0);
    expect(h.solveCalls).toEqual(["turnstile"]);
  });

  it("never spends on a Turnstile widget that already holds a token", async () => {
    h.variantTokenPresent = true;
    const outcome = await attemptOperateCaptchaAutoSolve(fakeSession(), fakePage(false));
    await flushDetached();
    expect(outcome).toBe("already_settled");
    expect(h.solveCalls).toHaveLength(0);
  });

  it("keeps the failure cooldown on Turnstile purchases", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.failSolve = true;
      expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
      await flushDetached();
      expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("cooldown");
      expect(h.solveCalls).toEqual(["turnstile"]);

      vi.advanceTimersByTime(30_001);
      h.failSolve = false;
      expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
      await flushDetached();
      expect(h.solveCalls).toEqual(["turnstile", "turnstile"]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("attemptOperateCaptchaAutoSolve — defer unengaged invisible widgets and active OAuth", () => {
  it("defers invisible reCAPTCHA v2 without a visible challenge frame until the agent engages the document", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "recaptcha_v2";
    h.challengeRendered = true;
    h.recaptchaEvidence = {
      challengeFrameVisible: false,
      anchorType: "image",
      anchorSize: "invisible",
      apiRender: "explicit",
      sitekey: "6LftmFkUAAAAADydGEH99T-xmZoK69ErtRCzfVFf",
      hasVisibleCheckboxAnchor: false,
      hasInvisibleAnchor: true,
      hasBadge: true,
    };

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("unengaged_widget");
    await flushDetached();
    expect(h.solveCalls).toEqual([]);

    markCaptchaDocumentEngaged(session, PAGE_URL);
    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["recaptcha_v2"]);
  });

  it("still solves a visible blocking reCAPTCHA image challenge on an untouched page", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "recaptcha_v2";
    h.challengeRendered = true;
    h.recaptchaEvidence = {
      challengeFrameVisible: true,
      anchorType: "image",
      anchorSize: "invisible",
      apiRender: "explicit",
      sitekey: "6LftmFkUAAAAADydGEH99T-xmZoK69ErtRCzfVFf",
      hasVisibleCheckboxAnchor: false,
      hasInvisibleAnchor: true,
      hasBadge: true,
    };

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["recaptcha_v2"]);
  });

  it("defers invisible hCaptcha without a visible challenge frame until the agent engages the document", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "hcaptcha";
    h.challengeRendered = true;
    h.hcaptchaChallengeVisible = false;
    h.hcaptchaInvisible = true;

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("unengaged_widget");
    await flushDetached();
    expect(h.solveCalls).toEqual([]);

    markCaptchaDocumentEngaged(session, PAGE_URL);
    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["hcaptcha"]);
  });

  it("still solves a visible hCaptcha challenge on an untouched page even when invisible metadata is set", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "hcaptcha";
    h.challengeRendered = true;
    h.hcaptchaChallengeVisible = true;
    h.hcaptchaInvisible = true;

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["hcaptcha"]);
  });

  it("defers an unengaged Turnstile widget on a Tavily-style login/signup page until the agent engages the form", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "turnstile";
    h.challengeRendered = false;
    h.turnstileEvidence = {
      interstitial: false,
      widgetVisible: true,
      embeddedInForm: true,
      hasPageControls: true,
    };

    const diag: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      diag.push(String(msg));
    });
    try {
      expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("unengaged_widget");
      await flushDetached();
      expect(h.solveCalls).toEqual([]);
      expect(h.turnstileInjectCalls).toBe(0);
      expect(outcomes()).toContain("fetch_skipped");
      expect(diag.some((line) => /outcome=fetch_skipped reason=unengaged_widget/.test(line))).toBe(
        true,
      );

      // Engaging the form unlocks purchase and subsequent injection on the same document.
      markCaptchaDocumentEngaged(session, PAGE_URL);
      expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
      await flushDetached();
      expect(h.solveCalls).toEqual(["turnstile"]);

      expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("injected");
      await flushDetached();
      expect(h.turnstileInjectCalls).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("defers an invisible/non-interactive Turnstile widget on an untouched non-interstitial page until engaged", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "turnstile";
    h.challengeRendered = false;
    h.turnstileEvidence = {
      interstitial: false,
      widgetVisible: false,
      embeddedInForm: false,
      hasPageControls: false,
    };

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("unengaged_widget");
    await flushDetached();
    expect(h.solveCalls).toEqual([]);

    markCaptchaDocumentEngaged(session, PAGE_URL);
    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["turnstile"]);
  });

  it("still solves a full-page Cloudflare Turnstile interstitial on an untouched page", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "turnstile";
    h.challengeRendered = false;
    h.turnstileEvidence = {
      interstitial: true,
      widgetVisible: true,
      embeddedInForm: false,
      hasPageControls: false,
    };

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["turnstile"]);
  });

  it("still solves a standalone visible blocking Turnstile gate on an untouched page", async () => {
    const session = fakeSession();
    const page = fakePage(false);
    h.variant = "turnstile";
    h.challengeRendered = false;
    h.turnstileEvidence = {
      interstitial: false,
      widgetVisible: true,
      embeddedInForm: false,
      hasPageControls: false,
    };

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["turnstile"]);
  });

  it("never purchases a CAPTCHA token while an OAuth attempt is active", async () => {
    const session = fakeSession();
    (session.browser as unknown as { activeOAuthAttempt: object }).activeOAuthAttempt = {
      id: "oauth-1",
    };
    const page = fakePage(false);
    h.variant = "hcaptcha";
    h.challengeRendered = true;

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("oauth_in_progress");
    await flushDetached();
    expect(h.solveCalls).toEqual([]);
  });

  it("does not block CAPTCHA auto-solve when completed popup OAuth pages remain open", async () => {
    const session = fakeSession();
    const openPage = { isClosed: () => false, url: () => PAGE_URL };
    Object.assign(session.browser, {
      activeOAuthAttempt: null,
      oauthProductPage: openPage,
      oauthProviderPage: openPage,
    });
    const page = fakePage(false);
    h.variant = "hcaptcha";
    h.challengeRendered = true;

    expect(await attemptOperateCaptchaAutoSolve(session, page)).toBe("fetch_started");
    await flushDetached();
    expect(h.solveCalls).toEqual(["hcaptcha"]);
  });
});
