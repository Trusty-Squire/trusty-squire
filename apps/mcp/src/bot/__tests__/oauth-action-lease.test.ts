import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../session/model.js";
import type * as SessionLifecycle from "../session/lifecycle.js";
import type { BrowserController } from "../browser.js";
import { createSession } from "../session/model.js";
import { actInternally, dispatchDriveAct } from "../act/act.js";
import {
  OAuthAwaitingHumanError,
  oauthActionDeadline,
  oauthHumanHandoffTimeoutMs,
  resetOAuthActionDeadline,
  withinOAuthActionDeadline,
  withOAuthActionLease,
} from "../oauth-login.js";

const boundary = vi.hoisted(() => ({
  session: undefined as Session | undefined,
  gate: vi.fn(),
}));

vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionLifecycle>()),
  sessionForCall: () => boundary.session,
  googleSessionGateForSession: boundary.gate,
}));

afterEach(() => {
  boundary.session = undefined;
  boundary.gate.mockReset();
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
  it.each([18_000, 30_000])("includes a %i ms identity probe in the caller budget", async (probeMs) => {
    vi.useFakeTimers();
    const deadline = oauthActionDeadline("google", 20_000);
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
    ).then(result);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result).toHaveBeenCalledOnce();
    expect(result.mock.calls[0]![0].observation.oauth.state).toBe("awaiting_human");
    expect(execution).toHaveBeenCalledTimes(probeMs < 20_000 ? 1 : 0);
    await pending;
    finishExecution();
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it("bounds the drive target guard before the identity probe", async () => {
    vi.useFakeTimers();
    const page = {
      url: () => "https://fixture.test/signup",
      isClosed: () => false,
      frames: (): unknown[] => [page],
      evaluate: () => new Promise<never>(() => {}),
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
      identities: new Map([["@e:go", {
        selector: "#go",
        frameUrl: page.url(),
        frameOrigin: "https://fixture.test",
        role: "button",
        label: "Google",
      }]]),
    } as Session["drive"];
    const result = vi.fn();
    const pending = dispatchDriveAct(
      "budget",
      { kind: "oauth_login", target: "@e:go", provider: "google" },
      80,
    ).then(result);
    await vi.advanceTimersByTimeAsync(80);
    expect(result).toHaveBeenCalledOnce();
    expect(result.mock.calls[0]![0]).toMatchObject({ kind: "ok", oauth: { state: "awaiting_human" } });
    expect(boundary.gate).not.toHaveBeenCalled();
    await pending;
  });
});
