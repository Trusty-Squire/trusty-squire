import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../session/model.js";
import type * as SessionLifecycle from "../session/lifecycle.js";
import type { BrowserController } from "../browser.js";
import type { Page } from "playwright";
import type * as ObserveModule from "../observe/observe.js";
import type { Observation } from "../provision-session.js";
import { createSession } from "../session/model.js";
import { act, actInternally, dispatchDriveAct } from "../act/act.js";
import * as DriveIdentity from "../act/identity.js";
import {
  OAuthAwaitingHumanError,
  oauthActionDeadline,
  oauthHumanHandoffTimeoutMs,
  resetOAuthActionDeadline,
  withinOAuthActionDeadline,
  withinOAuthCallerDeadline,
  withOAuthActionLease,
} from "../oauth-login.js";

const boundary = vi.hoisted(() => ({
  session: undefined as Session | undefined,
  gate: vi.fn(),
  observe: vi.fn(),
}));

vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionLifecycle>()),
  sessionForCall: () => boundary.session,
  googleSessionGateForSession: boundary.gate,
}));

vi.mock("../observe/observe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ObserveModule>()),
  observeSession: boundary.observe,
}));

afterEach(() => {
  vi.restoreAllMocks();
  boundary.session = undefined;
  boundary.gate.mockReset();
  boundary.observe.mockReset();
  vi.useRealTimers();
});

describe("Google OAuth action serialization", () => {
  it("runs concurrent sign-ins one at a time without refusing either", async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withOAuthActionLease(undefined, async () => {
      active++;
      peak = Math.max(peak, active);
      await firstBlocked;
      active--;
      return "first";
    });
    const second = withOAuthActionLease(undefined, async () => {
      active++;
      peak = Math.max(peak, active);
      active--;
      return "second";
    });
    await Promise.resolve();
    expect(active).toBe(1);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(peak).toBe(1);
  });
});

describe("OAuth action deadline under a caller budget", () => {
  describe.each(["already expired", "timer expiry"])("%s", (expiry) => {
    it.each([
      ["lease", undefined, "not_attempted", "Retry oauth_login"],
      ["lease", true, "not_attempted", "Retry oauth_login"],
      ["action", undefined, "not_attempted", "Retry oauth_login"],
      ["action", false, "not_attempted", "Retry oauth_login"],
      ["action", true, "pending", "Call operate_observe"],
    ] as const)("classifies %s timeout with dispatch=%s as %s", async (phase, dispatched, expected, guidance) => {
      vi.useFakeTimers();
      const deadline = oauthActionDeadline("google", 45_000);
      deadline.dispatchAttempted = dispatched;
      if (expiry === "already expired") deadline.expiresAt = Date.now();
      const result = withinOAuthActionDeadline(
        new Promise<never>(() => {}),
        deadline,
        phase,
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await result;
      expect(error).toBeInstanceOf(OAuthAwaitingHumanError);
      expect(error).toMatchObject({ phase: expected, message: expect.stringContaining(guidance) });
    });
  });

  // Kenari, 1.1.54: a max_seconds 45 drive dispatched Google OAuth, reached the
  // consent page, and the human-handoff re-arm let the call run past 60 s.
  it("never re-arms past the caller's remaining budget", async () => {
    const started = Date.now();
    const deadline = oauthActionDeadline("google", 80);
    expect(deadline.expiresAt).toBeLessThanOrEqual(started + 80 + 5);
    const pending = withinOAuthActionDeadline(new Promise<never>(() => {}), deadline);
    resetOAuthActionDeadline(deadline, oauthHumanHandoffTimeoutMs());
    expect(deadline.expiresAt).toBe(deadline.capAt);
    await expect(pending).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps the provider's own windows when the caller has no budget", () => {
    const deadline = oauthActionDeadline("google");
    expect(deadline.capAt).toBeUndefined();
    resetOAuthActionDeadline(deadline, oauthHumanHandoffTimeoutMs());
    expect(deadline.expiresAt - Date.now()).toBeGreaterThan(60_000);
  });
});

describe("OAuth preflight under a drive deadline", () => {
  it.each([18_000, 30_000, 35_000])(
    "includes a %i ms identity probe in the caller budget",
    async (probeMs) => {
      vi.useFakeTimers();
      const callerMs = probeMs === 35_000 ? 45_000 : 20_000;
      const deadline = oauthActionDeadline("google", callerMs);
      let finishExecution = () => {};
      const execution = vi.fn(async () => {
        resetOAuthActionDeadline(deadline, oauthHumanHandoffTimeoutMs());
        return await new Promise<undefined>((resolve) => {
          finishExecution = () => resolve(undefined);
        });
      });
      const browser = {
        activePage: () => null,
        currentUrl: () => "https://fixture.test/signup",
        maskOperatorOutput: <T>(value: T): T => value,
        withDispatchPacing: execution,
      } as unknown as BrowserController;
      boundary.session = createSession({
        id: "budget",
        browser,
        allowedHosts: [],
        startUrl: "https://fixture.test/signup",
        consentInboxRead: false,
        userEmail: null,
      });
      boundary.gate.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, probeMs));
        return { ok: true };
      });
      const result = vi.fn();
      const pending = actInternally(
        "budget",
        { kind: "oauth_login", target: "@e:go", provider: "google" },
        "none",
        undefined,
        undefined,
        { drive: true, oauthDeadline: deadline },
      ).then(result, result);
      await vi.advanceTimersByTimeAsync(Math.min(callerMs, 30_000));
      expect(result).toHaveBeenCalledOnce();
      expect(result.mock.calls[0]![0]).toBeInstanceOf(OAuthAwaitingHumanError);
      expect(execution).toHaveBeenCalledTimes(probeMs < 20_000 ? 1 : 0);
      expect(deadline.dispatchAttempted).not.toBe(true);
      await pending;
      finishExecution();
      await vi.advanceTimersByTimeAsync(10_000);
    },
  );

  it.each([80, 45_000])(
    "bounds the drive target guard with a %i ms caller budget",
    async (callerMs) => {
      vi.useFakeTimers();
      // Stall identity resolution itself: a page.evaluate stall has its own 4s
      // timeout and would finish the guard before the OAuth phase deadline.
      vi.spyOn(DriveIdentity, "resolveIdentityScope").mockImplementationOnce(
        () => new Promise<never>(() => {}),
      );
      const page = {
        url: () => "https://fixture.test/signup",
        isClosed: () => false,
      };
      const browser = {
        page,
        currentUrl: page.url,
        maskOperatorOutput: <T>(value: T): T => value,
      } as unknown as BrowserController;
      boundary.session = createSession({
        id: "budget",
        browser,
        allowedHosts: [],
        startUrl: page.url(),
        consentInboxRead: false,
        userEmail: null,
      });
      boundary.session.drive = {
        identities: new Map([
          [
            "@e:go",
            {
              selector: "#go",
              frameUrl: page.url(),
              frameOrigin: "https://fixture.test",
              role: "button",
              label: "Google",
            },
          ],
        ]),
      } as Session["drive"];
      const result = vi.fn();
      const deadline = oauthActionDeadline("google", callerMs);
      const pending = dispatchDriveAct(
        "budget",
        { kind: "oauth_login", target: "@e:go", provider: "google" },
        deadline,
      ).then(result, result);
      await vi.advanceTimersByTimeAsync(Math.min(callerMs, 30_000) - 1);
      expect(result).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toHaveBeenCalledOnce();
      expect(result.mock.calls[0]![0]).toBeInstanceOf(OAuthAwaitingHumanError);
      expect(boundary.gate).not.toHaveBeenCalled();
      expect(deadline.dispatchAttempted).not.toBe(true);
      await pending;
    },
  );
});

describe("OAuth fallback caller deadline", () => {
  it.each([20_000, 45_000])(
    "keeps a %i ms deadline through public OAuth fallback",
    async (callerMs) => {
      vi.useFakeTimers();
      const browser = {
        page: null,
        activePage: () => null,
        currentUrl: () => "https://fixture.test/signup",
        maskOperatorOutput: <T>(value: T): T => value,
      } as unknown as BrowserController;
      boundary.session = createSession({
        id: "fallback",
        browser,
        allowedHosts: [],
        startUrl: "https://fixture.test/signup",
        consentInboxRead: false,
        userEmail: null,
      });
      boundary.gate.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return { ok: true };
      });
      const deadline = oauthActionDeadline("google", callerMs);
      const action = { kind: "oauth_login", target: "Google", provider: "google" } as const;
      expect(await dispatchDriveAct("fallback", action, deadline)).toEqual({ kind: "unsupported" });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = vi.fn();
      const pending = act("fallback", action, "compact", "compact", true, deadline).then(
        result,
        result,
      );
      await vi.advanceTimersByTimeAsync(Math.min(callerMs, 30_000) - 5_000);
      expect(result).toHaveBeenCalledOnce();
      expect(result.mock.calls[0]![0]).toBeInstanceOf(OAuthAwaitingHumanError);
      expect(deadline.dispatchAttempted).not.toBe(true);
      await pending;
      await vi.advanceTimersByTimeAsync(20_000);
    },
  );

  it.each(["completion", "observation"])(
    "bounds stalled %s recovery after interrupted OAuth",
    async (stage) => {
      vi.useFakeTimers();
      const deadline = oauthActionDeadline("google", 20_000);
      let finishRecovery = () => {};
      const recover = vi.fn(async () => {
        if (stage === "observation") return { page: {} as Page };
        return await new Promise<null>((resolve) => {
          finishRecovery = () => resolve(null);
        });
      });
      boundary.observe.mockImplementation(
        () =>
          new Promise<Observation>((resolve) => {
            finishRecovery = () => resolve({ url: "https://fixture.test/signup" } as Observation);
          }),
      );
      deadline.completionCheck = recover;
      const browser = {
        activePage: () => null,
        currentUrl: () => "https://fixture.test/signup",
        maskOperatorOutput: <T>(value: T): T => value,
        withDispatchPacing: async () => {
          deadline.dispatchAttempted = true;
          throw new OAuthAwaitingHumanError("OAuth interrupted");
        },
      } as unknown as BrowserController;
      boundary.session = createSession({
        id: "recovery",
        browser,
        allowedHosts: [],
        startUrl: "https://fixture.test/signup",
        consentInboxRead: false,
        userEmail: null,
      });
      boundary.gate.mockResolvedValue({ ok: true });
      const result = vi.fn();
      const pending = actInternally(
        "recovery",
        { kind: "oauth_login", target: "Google", provider: "google" },
        "none",
        undefined,
        undefined,
        { drive: true, oauthDeadline: deadline },
      ).then(result, result);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(recover).toHaveBeenCalledOnce();
      expect(boundary.observe).toHaveBeenCalledTimes(stage === "observation" ? 1 : 0);
      expect(result).toHaveBeenCalledOnce();
      expect(result.mock.calls[0]![0].observation.oauth.state).toBe("awaiting_human");
      await pending;
      finishRecovery();
      await vi.advanceTimersByTimeAsync(10_000);
    },
  );
});

describe("OAuth recovery under the caller cap", () => {
  it("allows completion evidence after a phase timeout but refuses reads after the caller cap", async () => {
    vi.useFakeTimers();
    const deadline = oauthActionDeadline("google", 20_000);
    deadline.timedOut = true;
    deadline.expiresAt = Date.now();
    expect(await withinOAuthCallerDeadline(async () => "captured", deadline)).toBe("captured");
    await vi.advanceTimersByTimeAsync(20_000);
    const read = vi.fn(async () => "late evidence");
    await expect(withinOAuthCallerDeadline(read, deadline)).rejects.toBeInstanceOf(
      OAuthAwaitingHumanError,
    );
    expect(read).not.toHaveBeenCalled();
  });
});
