// Covers the pure environment helpers in google-login.ts (T2). The
// login orchestration itself spawns real processes (Xvfb, x11vnc,
// cloudflared) and is validated by running it, not unit-tested — these
// are the deterministic pieces that can be.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { shortenVncUrl } from "../../api-client.js";
import {
  attachSelfManagedLoginContext,
  BrowserController,
  childProcessIsRunning,
  launchCancellablePersistentContext,
  resolvePersistentFallbackIdentity,
  resolveAttachedProfileChildIdentity,
  terminateTrackedProfileChild,
  withChromeStartupLock,
} from "../browser.js";
import {
  acquireProfileOperationGuard,
  launchWithProfileGate,
  ProfileBusyError,
} from "../profile.js";
import { loggedInProviders, markProviderLoggedIn } from "../login-state.js";
import {
  binaryOnPath,
  cancelActiveLoginBrowsers,
  installHint,
  installClaimPollCompleted,
  openInstallConfirmInBotChrome,
  classifyGoogleAuthState,
  checkLoginStatusWithin,
  detectActiveProviderSessions,
  extractGoogleAccountEmail,
  extractGoogleNumberMatch,
  extractOAuthScopes,
  findFreePort,
  fallbackCloudflaredArgs,
  hasDisplay,
  pollUntil,
  profileHasProviderCookies,
  registerHeadlessRigCleanup,
  scopesAreBasic,
  scrapeGoogleScopePhrases,
  teardownHeadlessRig,
  teardownLoginBrowser,
  trackActiveLoginBrowser,
  ensureOAuthSession,
  finalizeLoginRun,
  launchPersistentLoginContext,
  validateGoogleProfileSession,
  type HeadlessRig,
  type PersistentLauncher,
  type RunInBotChromeOpts,
} from "../google-login.js";

describe("canonical profile operation guard", () => {
  it("treats symlink aliases for an absent profile as one guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-google-profile-alias-"));
    const profiles = join(dir, "profiles");
    const alias = join(dir, "profiles-alias");
    mkdirSync(profiles);
    symlinkSync(profiles, alias, "dir");
    const lease = acquireProfileOperationGuard(join(profiles, "not-created"));
    try {
      expect(() => acquireProfileOperationGuard(join(alias, "not-created"))).toThrow(
        ProfileBusyError,
      );
    } finally {
      lease.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks provider-session probes while publication could own the profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-google-session-guard-"));
    const lease = acquireProfileOperationGuard(dir);
    try {
      await expect(detectActiveProviderSessions(dir)).rejects.toBeInstanceOf(ProfileBusyError);
    } finally {
      lease.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeProcess(name: string, ignoreSigterm = false): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    unref: vi.fn(),
    spawnargs: [name],
    kill: vi.fn(),
  });
  child.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    if (ignoreSigterm && signal === "SIGTERM") return true;
    child.exitCode = 0;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child as unknown as ChildProcess;
}

function rigWithEverySessionProcess(): { rig: HeadlessRig; processes: ChildProcess[] } {
  const processes = ["Xvfb", "x11vnc", "websockify", "cloudflared"].map((name) =>
    fakeProcess(name),
  );
  return { rig: { display: ":99", procs: processes }, processes };
}

function cleanupRuntime(): {
  handlers: Map<string, (...args: never[]) => void>;
  runtime: Parameters<typeof registerHeadlessRigCleanup>[2];
  exit: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (...args: never[]) => void>();
  const exit = vi.fn();
  const runtime = {
    once: vi.fn((event: string, listener: (...args: never[]) => void) => {
      handlers.set(event, listener);
      return runtime;
    }),
    removeListener: vi.fn((event: string) => {
      handlers.delete(event);
      return runtime;
    }),
    exit,
  } as unknown as Parameters<typeof registerHeadlessRigCleanup>[2];
  return { handlers, runtime, exit };
}

describe("headless login VNC lifecycle", () => {
  it("cleans every session process once from the normal timeout/error finally path", async () => {
    const { rig, processes } = rigWithEverySessionProcess();

    await teardownHeadlessRig(rig, 1);
    await teardownHeadlessRig(rig, 1);

    for (const child of processes) {
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.stdout?.destroy).toHaveBeenCalledTimes(1);
      expect(child.stderr?.destroy).toHaveBeenCalledTimes(1);
      expect(child.unref).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["SIGINT", "SIGTERM"])("cleans every session process on %s", async (signal) => {
    const { rig, processes } = rigWithEverySessionProcess();
    const { handlers, runtime, exit } = cleanupRuntime();
    const remove = registerHeadlessRigCleanup(rig, () => undefined, runtime);

    handlers.get(signal)!();
    const expectedCode = signal === "SIGINT" ? 130 : 143;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(expectedCode));

    for (const child of processes) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    remove();
  });

  it("escalates to SIGKILL when a session process ignores SIGTERM", async () => {
    const child = fakeProcess("cloudflared", true);
    const rig: HeadlessRig = { display: ":99", procs: [child] };

    await teardownHeadlessRig(rig, 1);

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("uses synchronous SIGKILL cleanup during process exit", () => {
    const child = fakeProcess("websockify", true);
    const rig: HeadlessRig = { display: ":99", procs: [child] };
    const { handlers, runtime } = cleanupRuntime();
    const remove = registerHeadlessRigCleanup(rig, () => undefined, runtime);

    handlers.get("exit")!();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    remove();
  });

  it("forces browser cleanup when graceful teardown stalls", async () => {
    vi.useFakeTimers();
    const forceClose = vi.fn();
    const waiting = teardownLoginBrowser({
      profileDir: "/unused/profile",
      identity: null,
      closeBrowser: () => new Promise<void>(() => undefined),
      forceClose,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toBe("force_closed_unproven");

    expect(forceClose).toHaveBeenCalledOnce();
  });

  it("cleans every session process and the active browser on an uncaught exception", async () => {
    const { rig, processes } = rigWithEverySessionProcess();
    const { handlers, runtime, exit } = cleanupRuntime();
    const browserTeardown = vi.fn(async () => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const remove = registerHeadlessRigCleanup(rig, () => browserTeardown, runtime);

    handlers.get("uncaughtException")!(new Error("boom") as never);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(browserTeardown).toHaveBeenCalledTimes(1);
    for (const child of processes) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    error.mockRestore();
    remove();
  });

  it("takes sole signal ownership from the self-managed Chrome handlers for its duration", () => {
    const { rig } = rigWithEverySessionProcess();
    const { handlers, runtime } = cleanupRuntime();
    const set = vi.fn();
    const remove = registerHeadlessRigCleanup(rig, () => undefined, runtime, {
      enabled: () => true,
      set,
    });

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(false);
    for (const event of ["exit", "SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"]) {
      expect(handlers.has(event)).toBe(true);
    }

    remove();
    expect(set).toHaveBeenLastCalledWith(true);
    expect(handlers.size).toBe(0);
  });

  it("stands down to the central shutdown coordinator when signal exit is disabled", () => {
    const { rig } = rigWithEverySessionProcess();
    const { handlers, runtime } = cleanupRuntime();
    const set = vi.fn();
    const remove = registerHeadlessRigCleanup(rig, () => undefined, runtime, {
      enabled: () => false,
      set,
    });

    // Only the pure-cleanup exit hook: the server's requestShutdown owns
    // signals/exit and drains the login via cancelActiveLoginBrowsers, and
    // exit-calling uncaught/unhandled handlers would break the server's
    // log-and-keep-serving process guards.
    expect(handlers.has("exit")).toBe(true);
    for (const event of ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"]) {
      expect(handlers.has(event)).toBe(false);
    }
    expect(set).not.toHaveBeenCalled();

    remove();
    expect(set).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });

  it("uses HTTP/2 for the per-session cloudflared fallback", () => {
    expect(fallbackCloudflaredArgs(4567)).toEqual([
      "tunnel",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:4567",
    ]);
  });

  it("bounds the fallback URL shortener request", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ short_url: "https://trustysquire.ai/g/short" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(
      shortenVncUrl("https://api.test", "https://long.test/#p=secret", fetchImpl),
    ).resolves.toBe("https://trustysquire.ai/g/short");
  });
});

describe("operator shutdown — OAuth-bootstrap login browser cancellation", () => {
  it("cancels every tracked login browser once and drains the registry", async () => {
    const closed: string[] = [];
    trackActiveLoginBrowser(async () => {
      closed.push("displayed");
    });
    trackActiveLoginBrowser(async () => {
      closed.push("headless");
      throw new Error("teardown failed mid-shutdown");
    });

    await cancelActiveLoginBrowsers();
    expect(closed.sort()).toEqual(["displayed", "headless"]);

    // Drained: a second shutdown trigger must not double-tear anything.
    await cancelActiveLoginBrowsers();
    expect(closed).toHaveLength(2);
  });

  it("skips a login run that already completed and unregistered", async () => {
    const cancel = vi.fn(async () => undefined);
    const untrack = trackActiveLoginBrowser(cancel);
    untrack();

    await cancelActiveLoginBrowsers();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("shares one teardown between the shutdown cancel and the login's own finally", async () => {
    // Mirrors the memoized teardownBrowser used by runDisplayedChrome /
    // runHeadlessChrome: whichever of requestShutdown or the run's finally
    // fires first performs the close, and the other awaits the same promise.
    let closes = 0;
    let teardown: Promise<void> | undefined;
    const teardownBrowser = (): Promise<void> =>
      (teardown ??= (async () => {
        closes += 1;
      })());
    const untrack = trackActiveLoginBrowser(async () => {
      await teardownBrowser();
    });

    await cancelActiveLoginBrowsers(); // the server shutdown wins the race
    untrack(); // …then the interrupted login run's finally still executes
    await teardownBrowser();

    expect(closes).toBe(1);
  });
});

describe("login browser lifecycle guards", () => {
  it("keeps cleaning a wedged persistent launch through its spawn window", async () => {
    vi.useFakeTimers();
    let cancel: (() => void) | undefined;
    let finishLaunch: ((value: string) => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const launch = new Promise<string>((resolve) => {
      finishLaunch = resolve;
    });

    const cleanupCancelled = vi.fn(async () => "closed" as const);
    let profileHolderPresent = false;
    const cleanupRejected = vi.fn(async () => {
      if (!profileHolderPresent) return "closed" as const;
      profileHolderPresent = false;
      return "closed" as const;
    });
    const launchImpl = vi.fn((options: { headless: boolean; timeout: number }): Promise<string> => {
      expect(options).toEqual({ headless: true, timeout: 25 });
      return launch;
    });
    const result = launchCancellablePersistentContext({
      launch: launchImpl,
      options: { headless: true },
      cancellation,
      cleanupCancelled,
      cleanupRejected,
      launchTimeoutMs: 25,
      cancellationSettleMs: 25,
      cancellationPollMs: 5,
    });
    await Promise.resolve();
    cancel?.();
    await vi.advanceTimersByTimeAsync(10);
    profileHolderPresent = true;
    await vi.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toEqual({ status: "cancelled", closeState: "unknown" });
    expect(cleanupRejected.mock.calls.length).toBeGreaterThan(1);
    expect(profileHolderPresent).toBe(false);

    finishLaunch?.("late browser");
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupCancelled).toHaveBeenCalledWith("late browser");
  });

  it("bounds persistent fallback identity proof when a live holder stays unreadable", async () => {
    vi.useFakeTimers();
    const profileDir = "/unused/profile";
    const readIdentity = vi.fn(() => null);
    const clearStaleLock = vi.fn(() => false);
    const resolving = resolvePersistentFallbackIdentity({
      profileDir,
      platform: "linux",
      timeoutMs: 100,
      pollMs: 25,
      currentHolderPid: () => 424_244,
      readIdentity,
      clearStaleLock,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(resolving).resolves.toEqual({ state: "unknown" });
    expect(readIdentity).toHaveBeenCalled();
    expect(clearStaleLock).toHaveBeenCalled();
  });

  it("cancels a wedged pre-launch stage without awaiting its settlement", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-browser-cancel-"));
    const controller = new BrowserController({ profileDir });
    const internals = controller as unknown as {
      startWithProfileGuard: () => Promise<void>;
      closeWithProfileGuard: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    };
    const startImpl = vi.fn(() => new Promise<void>(() => undefined));
    const closeImpl = vi.fn(async () => "unknown" as const);
    internals.startWithProfileGuard = startImpl;
    internals.closeWithProfileGuard = closeImpl;

    try {
      void controller.start().catch(() => undefined);
      await vi.waitFor(() => expect(startImpl).toHaveBeenCalledOnce());
      await expect(controller.close({ cancelStart: true })).resolves.toBe("closed");
      await expect(controller.close()).resolves.toBe("closed");
      expect(closeImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("waits for a committed launch to reach terminal settlement", async () => {
    vi.useFakeTimers();
    const profileDir = mkdtempSync(join(tmpdir(), "ts-browser-cancel-"));
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const controller = new BrowserController({ profileDir });
    const internals = controller as unknown as {
      startLaunchCommitted: boolean;
      startWithProfileGuard: () => Promise<void>;
      closeWithProfileGuard: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    };
    const startImpl = vi.fn(() => startGate);
    const closeImpl = vi.fn(async () => "closed" as const);
    internals.startWithProfileGuard = startImpl;
    internals.closeWithProfileGuard = closeImpl;

    try {
      const starting = controller.start().catch((error: unknown) => error);
      await vi.waitFor(() => expect(startImpl).toHaveBeenCalledOnce());
      internals.startLaunchCommitted = true;
      let closeSettled = false;
      const closing = controller.close({ cancelStart: true }).then((state) => {
        closeSettled = true;
        return state;
      });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(closeSettled).toBe(false);

      releaseStart?.();
      await vi.advanceTimersByTimeAsync(25);
      await expect(starting).resolves.toEqual(
        expect.objectContaining({ message: "BrowserController start cancelled" }),
      );
      await expect(closing).resolves.toBe("closed");
      await expect(controller.close()).resolves.toBe("closed");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("settles an in-flight start once and caches the verified close result", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-browser-close-"));
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const controller = new BrowserController({ profileDir });
    const internals = controller as unknown as {
      startWithProfileGuard: () => Promise<void>;
      closeWithProfileGuard: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    };
    const startImpl = vi.fn(() => startGate);
    const closeImpl = vi.fn(async () => "closed" as const);
    internals.startWithProfileGuard = startImpl;
    internals.closeWithProfileGuard = closeImpl;

    try {
      const starting = controller.start();
      await vi.waitFor(() => expect(startImpl).toHaveBeenCalledOnce());
      const firstClose = controller.close();
      const secondClose = controller.close();
      await Promise.resolve();
      expect(closeImpl).not.toHaveBeenCalled();

      releaseStart?.();
      await starting;
      await expect(Promise.all([firstClose, secondClose])).resolves.toEqual(["closed", "closed"]);
      await expect(controller.close()).resolves.toBe("closed");
      expect(closeImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("treats signal-terminated Chrome as closed", () => {
    const child = fakeProcess("chrome");
    expect(childProcessIsRunning(child)).toBe(true);
    Object.assign(child, { signalCode: "SIGKILL" });
    expect(childProcessIsRunning(child)).toBe(false);
  });

  it("fails immediately when another login owns the startup lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-startup-lock-"));
    const lockDir = join(root, "lock");
    mkdirSync(lockDir);
    try {
      await expect(
        withChromeStartupLock(async () => undefined, { deadlineMs: 0, lockDir }),
      ).rejects.toThrow(
        "another Trusty Squire session is already using the browser — close it first",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps a persistent-profile launch race to the contention error", async () => {
    await expect(
      launchWithProfileGate(
        "/tmp/unused-profile",
        async () => {
          throw new Error("Failed to create a ProcessSingleton for SingletonLock");
        },
        { failFast: true },
      ),
    ).rejects.toThrow(
      "another Trusty Squire session is already using the browser — close it first",
    );
  });
});

describe("headless login profile contention", () => {
  it("returns the clear already-in-use error immediately instead of waiting", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-profile-"));
    symlinkSync(`${hostname()}-${process.pid}`, join(profileDir, "SingletonLock"));

    try {
      const result = await ensureOAuthSession({ profileDir });
      expect(result).toEqual({
        status: "error",
        detail: "another Trusty Squire session is already using the browser — close it first",
      });
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

describe("profileHasProviderCookies (plain-login SQLite seed check)", () => {
  const withProfile = (
    cookies: Array<{ host: string; name: string }> | null,
    sub = "Default",
  ): string => {
    const dir = mkdtempSync(join(tmpdir(), "phpc-"));
    if (cookies !== null) {
      mkdirSync(join(dir, sub), { recursive: true });
      const db = new Database(join(dir, sub, "Cookies"));
      db.exec("CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)");
      for (const cookie of cookies) insert.run(cookie.host, cookie.name);
      db.close();
    }
    return dir;
  };

  it("detects a Google session from a matching cookie row", () => {
    const dir = withProfile([
      { host: ".google.com", name: "SAPISID" },
      { host: "accounts.google.com", name: "__Secure-1PSID" },
    ]);
    expect(profileHasProviderCookies(dir, "google")).toBe(true);
    expect(profileHasProviderCookies(dir, "github")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a GitHub session by user_session", () => {
    const dir = withProfile([{ host: ".github.com", name: "user_session" }]);
    expect(profileHasProviderCookies(dir, "github")).toBe(true);
    expect(profileHasProviderCookies(dir, "google")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a cookieless profile and never throws on a missing file", () => {
    const dir = withProfile([]);
    expect(profileHasProviderCookies(dir, "google")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    const missing = withProfile(null);
    expect(profileHasProviderCookies(missing, "google")).toBe(false);
    rmSync(missing, { recursive: true, force: true });
  });

  it("also finds cookies in the bare <profile>/Cookies layout", () => {
    const dir = withProfile([{ host: ".google.com", name: "SAPISID" }], ".");
    expect(profileHasProviderCookies(dir, "google")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not accept a deleted cookie whose name remains in SQLite bytes", () => {
    const dir = withProfile([{ host: ".google.com", name: "__Secure-1PSID" }]);
    const path = join(dir, "Default", "Cookies");
    const db = new Database(path);
    db.pragma("secure_delete = OFF");
    db.prepare("DELETE FROM cookies").run();
    db.close();

    expect(readFileSync(path).includes(Buffer.from("__Secure-1PSID"))).toBe(true);
    expect(profileHasProviderCookies(dir, "google")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a committed cookie from the live WAL", () => {
    const dir = withProfile([]);
    const path = join(dir, "Default", "Cookies");
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)").run(
      ".github.com",
      "user_session",
    );
    try {
      expect(profileHasProviderCookies(dir, "github")).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pollUntil phase-aware heartbeat", () => {
  it("resolves a heartbeat callback lazily after the wait phase changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T20:00:00.000Z"));
    let message = "waiting for sign-in";
    let done = false;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const waiting = pollUntil(
      Date.now() + 60_000,
      async () => done,
      () => message,
    );

    await vi.advanceTimersByTimeAsync(21_000);
    expect(stderr.mock.calls.at(-1)?.[0]).toContain("waiting for sign-in");

    message = "sign-in complete — click Finish";
    await vi.advanceTimersByTimeAsync(21_000);
    expect(stderr.mock.calls.at(-1)?.[0]).toContain("sign-in complete — click Finish");

    done = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(waiting).resolves.toBe(true);
  });

  it("prints a fixed heartbeat string without invoking callback logic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T20:00:00.000Z"));
    let done = false;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const waiting = pollUntil(Date.now() + 60_000, async () => done, "fixed install heartbeat");

    await vi.advanceTimersByTimeAsync(21_000);
    expect(stderr.mock.calls.at(-1)?.[0]).toContain("fixed install heartbeat");

    done = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(waiting).resolves.toBe(true);
  });

  it("uses the default sign-in heartbeat when no override is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T20:00:00.000Z"));
    let done = false;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const waiting = pollUntil(Date.now() + 60_000, async () => done);

    await vi.advanceTimersByTimeAsync(21_000);
    expect(stderr.mock.calls.at(-1)?.[0]).toContain("Still waiting for you to finish signing in");

    done = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(waiting).resolves.toBe(true);
  });

  it("returns false when the deadline expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T20:00:00.000Z"));

    const waiting = pollUntil(Date.now() + 5_000, async () => false);

    await vi.advanceTimersByTimeAsync(6_000);
    await expect(waiting).resolves.toBe(false);
  });

  it("fails loudly when the visible plain login browser has closed", async () => {
    await expect(
      pollUntil(
        Date.now() + 60_000,
        async () => false,
        "waiting for sign-in",
        () => {
          throw new Error("login browser closed");
        },
      ),
    ).rejects.toThrow("login browser closed");
  });

  it("fails instead of waiting forever when a login status check hangs", async () => {
    vi.useFakeTimers();
    const waiting = pollUntil(Date.now() + 60_000, () => new Promise<boolean>(() => undefined));
    const rejected = expect(waiting).rejects.toThrow("login status check stopped responding");

    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
  });

  it("applies the same timeout boundary to a preflight-style status check", async () => {
    vi.useFakeTimers();
    const waiting = checkLoginStatusWithin(
      Date.now() + 60_000,
      () => new Promise<boolean>(() => undefined),
      undefined,
      100,
    );
    const rejected = expect(waiting).rejects.toThrow("login status check stopped responding");

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });
});

describe("bot Chrome launch consistency", () => {
  it("forces the system Chrome channel through the executable launcher", async () => {
    const context = {};
    const launchPersistentContext = vi.fn().mockResolvedValue(context);
    const launcher = { launchPersistentContext } as unknown as PersistentLauncher;

    await expect(
      launchPersistentLoginContext(launcher, "/isolated-profile", {
        headless: true,
        channel: "bundled",
      }),
    ).resolves.toBe(context);
    expect(launchPersistentContext).toHaveBeenCalledWith("/isolated-profile", {
      headless: true,
      channel: "chrome",
    });
  });
});

describe("confirmed login finalization", () => {
  it("distinguishes a claimed install from pending and expired polls", () => {
    expect(installClaimPollCompleted("pending")).toBe(false);
    expect(installClaimPollCompleted({ status: "claimed", provider: "google" })).toBe(true);
    expect(() => installClaimPollCompleted("expired")).toThrow(/expired/);
  });

  it("records a confirmed login even when closure cannot publish a seed", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const publishSeed = vi.fn();
    try {
      await finalizeLoginRun(
        {
          profileDir,
          onConfirmedLogin: async () => markProviderLoggedIn("google", profileDir),
        },
        { status: "completed", closeState: "unknown" },
        publishSeed,
      );

      expect(loggedInProviders(profileDir)).toEqual(["google"]);
      expect(publishSeed).not.toHaveBeenCalled();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("does not record or publish a timed-out login", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const onConfirmedLogin = vi.fn();
    const publishSeed = vi.fn();
    try {
      await finalizeLoginRun(
        { profileDir, onConfirmedLogin },
        { status: "timeout", closeState: "closed" },
        publishSeed,
      );

      expect(onConfirmedLogin).not.toHaveBeenCalled();
      expect(publishSeed).not.toHaveBeenCalled();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("does not replace the Google seed after a completed GitHub login", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const validateGoogleSeed = vi.fn(async () => ({
      googleSignedIn: true,
      closeState: "closed" as const,
    }));
    const publishSeed = vi.fn();
    try {
      await finalizeLoginRun(
        { profileDir, seedProvider: "github", validateGoogleSeed },
        { status: "completed", closeState: "closed" },
        publishSeed,
      );

      expect(validateGoogleSeed).not.toHaveBeenCalled();
      expect(publishSeed).not.toHaveBeenCalled();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("publishes only verified closed Google login provenance", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const validateGoogleSeed = vi.fn(async () => ({
      googleSignedIn: true,
      closeState: "closed" as const,
    }));
    const publishSeed = vi.fn(async () => "generation");
    try {
      await finalizeLoginRun(
        { profileDir, seedProvider: "google", validateGoogleSeed },
        { status: "completed", closeState: "closed" },
        publishSeed,
      );

      expect(publishSeed).toHaveBeenCalledWith(profileDir, {
        proof: { loginStatus: "completed", closeState: "closed", provider: "google" },
        validateGoogleIdentity: validateGoogleSeed,
      });
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("threads completed Google provenance and the actual direct proxy disposition", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-connect-seed-"));
    const previousProxy = process.env.UNIVERSAL_BOT_PROXY_URL;
    process.env.UNIVERSAL_BOT_PROXY_URL = "http://agent:secret@proxy.example:8080";
    mkdirSync(join(profileDir, "Default"));
    const db = new Database(join(profileDir, "Default", "Cookies"));
    db.exec("CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL)");
    db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)").run(".google.com", "SID");
    db.close();
    const pollUntilClaimed = vi.fn(async () => ({ status: "claimed", provider: null }) as const);
    const validateGoogleSeed = vi.fn(async () => ({
      googleSignedIn: true,
      closeState: "closed" as const,
    }));
    const runChrome = vi.fn(async (runOpts: RunInBotChromeOpts) => {
      const callback = new URLSearchParams(new URL(runOpts.url).hash.slice(1)).get(
        "ts_install_complete",
      );
      expect(callback).not.toBeNull();
      await fetch(`${callback!}?provider=google`, { redirect: "manual" });
      await expect(runOpts.plainPollUntilDone!(profileDir)).resolves.toBe(true);
      await runOpts.plainOnSuccess!(profileDir);
      runOpts.onProxyDisposition?.(null);
      const provider =
        typeof runOpts.seedProvider === "function"
          ? runOpts.seedProvider()
          : (runOpts.seedProvider ?? null);
      expect(provider).toBe("google");
      await expect(runOpts.validateGoogleSeed!("/validation-profile")).resolves.toEqual({
        googleSignedIn: true,
        closeState: "closed",
      });
      return { status: "completed" as const };
    });

    try {
      await expect(
        openInstallConfirmInBotChrome(
          {
            confirmUrl: "https://example.com/install",
            profileDir,
            pollUntilClaimed,
          },
          runChrome,
          validateGoogleSeed,
        ),
      ).resolves.toEqual({ status: "claimed" });
      expect(pollUntilClaimed).toHaveBeenCalledWith(profileDir, true);
      expect(validateGoogleSeed).toHaveBeenCalledWith("/validation-profile", null);
      expect(runChrome).toHaveBeenCalledOnce();
    } finally {
      if (previousProxy === undefined) delete process.env.UNIVERSAL_BOT_PROXY_URL;
      else process.env.UNIVERSAL_BOT_PROXY_URL = previousProxy;
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("does not derive Google provenance from ambient cookies after GitHub completion", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-connect-seed-"));
    mkdirSync(join(profileDir, "Default"));
    const db = new Database(join(profileDir, "Default", "Cookies"));
    db.exec("CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL)");
    db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)").run(".google.com", "SID");
    db.close();
    const runChrome = vi.fn(async (runOpts: RunInBotChromeOpts) => {
      const callback = new URLSearchParams(new URL(runOpts.url).hash.slice(1)).get(
        "ts_install_complete",
      );
      await fetch(`${callback!}?provider=github`, { redirect: "manual" });
      await expect(runOpts.plainPollUntilDone!(profileDir)).resolves.toBe(true);
      await runOpts.plainOnSuccess!(profileDir);
      const provider =
        typeof runOpts.seedProvider === "function"
          ? runOpts.seedProvider()
          : (runOpts.seedProvider ?? null);
      expect(provider).toBeNull();
      return { status: "completed" as const };
    });

    try {
      await expect(
        openInstallConfirmInBotChrome(
          {
            confirmUrl: "https://example.com/install",
            profileDir,
            pollUntilClaimed: async () => ({ status: "claimed", provider: null }),
          },
          runChrome,
        ),
      ).resolves.toEqual({ status: "claimed" });
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

describe("Google seed validation", () => {
  it.each([
    ["https://myaccount.google.com/", true, "closed"],
    ["https://accounts.google.com/v3/signin/identifier", false, "closed"],
    ["https://myaccount.google.com/", true, "unknown"],
  ] as const)(
    "observes Google identity and proven closure at %s",
    async (url, signedIn, closeState) => {
      const profileDir = mkdtempSync(join(tmpdir(), "ts-google-seed-validation-"));
      const proxyDisposition = {
        server: "http://proxy.example:8080",
        username: "agent",
        password: "secret",
      };
      const close = vi.fn(async () => undefined);
      const goto = vi.fn(async () => undefined);
      const page = { goto, url: () => url };
      const context = {
        pages: () => [page],
        newPage: vi.fn(async () => page),
        close,
      };
      const launchPersistentContext = vi.fn(async () => context);
      const launcher = { launchPersistentContext } as unknown as PersistentLauncher;
      const closeValidationBrowser = vi.fn(
        async (opts: Parameters<typeof teardownLoginBrowser>[0]) => {
          await opts.closeBrowser();
          return closeState;
        },
      );

      try {
        await expect(
          validateGoogleProfileSession(
            profileDir,
            proxyDisposition,
            launcher,
            closeValidationBrowser,
          ),
        ).resolves.toEqual({ googleSignedIn: signedIn, closeState });
        expect(goto).toHaveBeenCalledWith("https://myaccount.google.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        expect(launchPersistentContext).toHaveBeenCalledWith(
          profileDir,
          expect.objectContaining({
            channel: "chrome",
            proxy: {
              server: "http://proxy.example:8080",
              username: "agent",
              password: "secret",
            },
          }),
        );
        expect(closeValidationBrowser).toHaveBeenCalledWith(
          expect.objectContaining({ profileDir, identity: null }),
        );
        expect(close).toHaveBeenCalledOnce();
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );
});

describe("cancelled self-managed Chrome launch", () => {
  it.each([
    { failure: "attach", expectedCloseCalls: 0 },
    { failure: "context", expectedCloseCalls: 1 },
  ])(
    "terminates an owned login child after $failure failure",
    async ({ failure, expectedCloseCalls }) => {
      const profileDir = mkdtempSync(join(tmpdir(), "ts-login-attach-failure-"));
      const child = fakeProcess("chrome");
      Object.assign(child, { pid: 424_240 });
      const identity = {
        host: hostname(),
        pid: 424_240,
        start_time: "birth",
        user_data_dir: profileDir,
      };
      const close = vi.fn(async () => undefined);
      const connectOverCDP =
        failure === "attach"
          ? vi.fn(async () => {
              throw new Error("CDP attach failed");
            })
          : vi.fn(async () => ({ contexts: () => [], close }));
      const terminateChild = vi.fn(async () => identity);
      try {
        await expect(
          attachSelfManagedLoginContext("http://127.0.0.1:9222", child, profileDir, identity, {
            launcher: { connectOverCDP } as never,
            terminateChild,
          }),
        ).rejects.toThrow(
          failure === "attach"
            ? "CDP attach failed"
            : "self-launched login Chrome exposed no default browser context",
        );
        expect(close).toHaveBeenCalledTimes(expectedCloseCalls);
        expect(terminateChild).toHaveBeenCalledWith(child, profileDir, identity);
      } finally {
        Object.assign(child, { exitCode: 0 });
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  it("allows a non-Linux attachment to continue with unknown identity", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-nonlinux-chrome-"));
    const child = fakeProcess("chrome");
    Object.assign(child, { pid: 424_241 });
    const readIdentity = vi.fn(() => null);
    const terminate = vi.fn(() => true);
    try {
      await expect(
        resolveAttachedProfileChildIdentity(child, profileDir, null, {
          platform: "darwin",
          readIdentity,
        }),
      ).resolves.toBeNull();
      await expect(
        terminateTrackedProfileChild(child, profileDir, {
          platform: "darwin",
          readIdentity,
          terminate,
        }),
      ).resolves.toBeNull();
      expect(readIdentity).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
      expect(childProcessIsRunning(child)).toBe(true);
    } finally {
      Object.assign(child, { exitCode: 0 });
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("retains the child until exact profile identity becomes observable", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-cancelled-chrome-"));
    const child = fakeProcess("chrome");
    Object.assign(child, { pid: 424_242 });
    const identity = {
      host: hostname(),
      pid: 424_242,
      start_time: "birth",
      user_data_dir: profileDir,
    };
    let probes = 0;
    const terminate = vi.fn(() => {
      Object.assign(child, { exitCode: 0 });
      return true;
    });
    try {
      await terminateTrackedProfileChild(child, profileDir, {
        readIdentity: () => (++probes === 1 ? null : identity),
        terminate,
      });

      expect(probes).toBe(2);
      expect(terminate).toHaveBeenCalledWith(identity, profileDir);
      expect(childProcessIsRunning(child)).toBe(false);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("waits for exact Linux login-child identity before attachment", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-chrome-identity-"));
    const child = fakeProcess("chrome");
    Object.assign(child, { pid: 424_243 });
    const identity = {
      host: hostname(),
      pid: 424_243,
      start_time: "birth",
      user_data_dir: profileDir,
    };
    let probes = 0;
    try {
      await expect(
        resolveAttachedProfileChildIdentity(child, profileDir, null, {
          platform: "linux",
          readIdentity: () => (++probes === 1 ? null : identity),
        }),
      ).resolves.toEqual(identity);
      expect(probes).toBe(2);
      expect(childProcessIsRunning(child)).toBe(true);
    } finally {
      Object.assign(child, { exitCode: 0 });
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("bounds Linux login-child identity proof without signaling an unknown process", async () => {
    vi.useFakeTimers();
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-chrome-unknown-"));
    const child = fakeProcess("chrome");
    Object.assign(child, { pid: 424_245 });
    const readIdentity = vi.fn(() => null);
    const terminate = vi.fn(() => true);
    try {
      const resolving = resolveAttachedProfileChildIdentity(child, profileDir, null, {
        platform: "linux",
        readIdentity,
        identityTimeoutMs: 100,
        identityPollMs: 25,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(resolving).resolves.toBeNull();

      const terminating = terminateTrackedProfileChild(child, profileDir, {
        platform: "linux",
        readIdentity,
        terminate,
        identityTimeoutMs: 100,
        identityPollMs: 25,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(terminating).resolves.toBeNull();
      expect(terminate).not.toHaveBeenCalled();
      expect(childProcessIsRunning(child)).toBe(true);
    } finally {
      Object.assign(child, { exitCode: 0 });
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

describe("extractGoogleAccountEmail (PR3 capture-at-login)", () => {
  it("prefers the OneGoogle account-chip aria-label", () => {
    const text = "Google Account: Ada Lovelace (ada.lovelace@example.com)\nInbox\nads@notme.com";
    expect(extractGoogleAccountEmail(text)).toBe("ada.lovelace@example.com");
  });

  it("rejects email text outside the active account chip", () => {
    expect(extractGoogleAccountEmail("Signed in as user@gmail.com — Manage")).toBeNull();
  });

  it("returns null when there is no email in the text", () => {
    expect(extractGoogleAccountEmail("My Account · Security · Privacy")).toBeNull();
  });
});

describe("claimed worker Google identity", () => {
  function controllerWithIdentityPage(finalUrl: string, identityTokens: string[]) {
    const close = vi.fn().mockResolvedValue(undefined);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn(() => finalUrl),
      locator: vi.fn(() => ({
        evaluateAll: vi.fn().mockResolvedValue(identityTokens),
      })),
      close,
    };
    const controller = new BrowserController({ humanize: false });
    (controller as unknown as { context: { newPage(): Promise<typeof page> } }).context = {
      newPage: vi.fn().mockResolvedValue(page),
    };
    return { close, controller };
  }

  it("reads the account email from the live worker context", async () => {
    const { close, controller } = controllerWithIdentityPage("https://myaccount.google.com/", [
      "inactive-account@example.com",
      "Google Account: Ada Lovelace (live-worker@example.com)",
    ]);

    await expect(controller.detectGoogleAccountEmail()).resolves.toBe("live-worker@example.com");
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats a sign-in redirect as unknown even when it remembers an email", async () => {
    const { close, controller } = controllerWithIdentityPage(
      "https://accounts.google.com/signin/v2/identifier",
      ["remembered@example.com"],
    );

    await expect(controller.detectGoogleAccountEmail()).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not mistake unrelated account-page text for the worker identity", async () => {
    const { controller } = controllerWithIdentityPage("https://myaccount.google.com/", [
      "inactive-account@example.com",
    ]);

    await expect(controller.detectGoogleAccountEmail()).resolves.toBeNull();
  });
});

describe("google-login env helpers", () => {
  it("binaryOnPath finds a real binary and rejects a fake one", () => {
    expect(binaryOnPath("sh")).toBe(true);
    expect(binaryOnPath("definitely-not-a-real-binary-xyz123")).toBe(false);
  });

  it("binaryOnPath still finds a standard-dir binary when PATH is trimmed", () => {
    // Reproduces the cloudflared false-missing: a spawner (systemd/agent)
    // drops /usr/local/bin etc., yet the binary is installed in a standard
    // dir. `sh` lives in /bin — a standard dir — so it must resolve even
    // with an empty PATH.
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(binaryOnPath("sh")).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("installHint gives cloudflared its own step, not an apt line that omits it", () => {
    const hint = installHint(["cloudflared"]);
    // The old bug: cloudflared missing → an apt-get line that can't install it.
    expect(hint).not.toMatch(/apt-get/);
    expect(hint).toContain("cloudflared-linux-");
    expect(hint).toContain("dpkg -i");
  });

  it("installHint maps each missing binary to its real package", () => {
    const hint = installHint(["Xvfb", "x11vnc", "websockify", "cloudflared"]);
    expect(hint).toContain("apt-get install -y xvfb x11vnc novnc websockify");
    expect(hint).toContain("cloudflared-linux-");
  });

  it("findFreePort returns a usable TCP port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("hasDisplay honors the force-headless override", () => {
    const saved = process.env.TRUSTY_SQUIRE_FORCE_HEADLESS;
    process.env.TRUSTY_SQUIRE_FORCE_HEADLESS = "true";
    try {
      expect(hasDisplay()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TRUSTY_SQUIRE_FORCE_HEADLESS;
      else process.env.TRUSTY_SQUIRE_FORCE_HEADLESS = saved;
    }
  });

  it("hasDisplay returns true on macOS and Windows without DISPLAY", () => {
    // The pre-0.5.3 regression: DISPLAY is a Unix concept that Mac
    // (Aqua) and Windows (Win32) don't set, so a DISPLAY-only check
    // would have routed both platforms into the headless noVNC rig
    // and failed at the missing Xvfb binary check.
    const savedDisplay = process.env.DISPLAY;
    const savedPlatform = process.platform;
    delete process.env.DISPLAY;
    try {
      for (const platform of ["darwin", "win32"]) {
        Object.defineProperty(process, "platform", { value: platform });
        expect(hasDisplay(), `${platform} should report a display`).toBe(true);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: savedPlatform });
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
    }
  });

  it("hasDisplay returns true on Linux only when DISPLAY is set", () => {
    const savedDisplay = process.env.DISPLAY;
    const savedPlatform = process.platform;
    const savedSshConnection = process.env.SSH_CONNECTION;
    const savedSshTty = process.env.SSH_TTY;
    const savedSessionType = process.env.XDG_SESSION_TYPE;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      delete process.env.SSH_CONNECTION;
      delete process.env.SSH_TTY;
      delete process.env.XDG_SESSION_TYPE;
      delete process.env.DISPLAY;
      expect(hasDisplay()).toBe(false);
      process.env.DISPLAY = ":0";
      expect(hasDisplay()).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: savedPlatform });
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
      else delete process.env.DISPLAY;
      if (savedSshConnection !== undefined) process.env.SSH_CONNECTION = savedSshConnection;
      else delete process.env.SSH_CONNECTION;
      if (savedSshTty !== undefined) process.env.SSH_TTY = savedSshTty;
      else delete process.env.SSH_TTY;
      if (savedSessionType !== undefined) process.env.XDG_SESSION_TYPE = savedSessionType;
      else delete process.env.XDG_SESSION_TYPE;
    }
  });

  it("hasDisplay routes SSH/TTY Linux sessions to noVNC even when DISPLAY is set", () => {
    const savedDisplay = process.env.DISPLAY;
    const savedPlatform = process.platform;
    const savedSshConnection = process.env.SSH_CONNECTION;
    const savedSessionType = process.env.XDG_SESSION_TYPE;
    const savedForceDisplay = process.env.TRUSTY_SQUIRE_FORCE_DISPLAY;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      process.env.DISPLAY = ":99";
      process.env.SSH_CONNECTION = "203.0.113.1 12345 203.0.113.2 22";
      process.env.XDG_SESSION_TYPE = "tty";
      delete process.env.TRUSTY_SQUIRE_FORCE_DISPLAY;
      expect(hasDisplay()).toBe(false);
      process.env.TRUSTY_SQUIRE_FORCE_DISPLAY = "true";
      expect(hasDisplay()).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: savedPlatform });
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
      else delete process.env.DISPLAY;
      if (savedSshConnection !== undefined) process.env.SSH_CONNECTION = savedSshConnection;
      else delete process.env.SSH_CONNECTION;
      if (savedSessionType !== undefined) process.env.XDG_SESSION_TYPE = savedSessionType;
      else delete process.env.XDG_SESSION_TYPE;
      if (savedForceDisplay !== undefined)
        process.env.TRUSTY_SQUIRE_FORCE_DISPLAY = savedForceDisplay;
      else delete process.env.TRUSTY_SQUIRE_FORCE_DISPLAY;
    }
  });
});

describe("classifyGoogleAuthState (T5)", () => {
  it("detects the OAuth consent screen", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/signin/oauth/consent?client_id=x",
        "Render wants access to your Google Account",
      ),
    ).toBe("consent");
  });

  it("classifies a Google login page as needs_login", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/v3/signin/identifier?continue=x",
        "Sign in — Use your Google Account. Email or phone",
      ),
    ).toBe("needs_login");
  });

  it("classifies the password step as needs_login, not challenge", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/v3/signin/challenge/pwd?x",
        "Welcome — Enter your password",
      ),
    ).toBe("needs_login");
  });

  it("detects a 2FA challenge", () => {
    expect(
      classifyGoogleAuthState(
        "https://accounts.google.com/v3/signin/challenge/totp?x",
        "2-Step Verification — Enter the code",
      ),
    ).toBe("challenge");
  });

  it("returns not_google off a Google host or on a bad URL", () => {
    expect(classifyGoogleAuthState("https://dashboard.render.com/", "Welcome")).toBe("not_google");
    expect(classifyGoogleAuthState("not-a-url", "")).toBe("not_google");
  });

  it("defaults an unrecognized accounts.google.com page to needs_login", () => {
    expect(classifyGoogleAuthState("https://accounts.google.com/odd/page", "")).toBe("needs_login");
  });
});

describe("extractGoogleNumberMatch", () => {
  it("reads the number from the 'tap N on your phone' phrasing", () => {
    expect(extractGoogleNumberMatch("Verify it's you — Tap 28 on your phone to sign in")).toBe(
      "28",
    );
  });

  it("reads the number from the '<N> on your other device' phrasing", () => {
    expect(
      extractGoogleNumberMatch(
        "Match the number — 47 on your other device. Google wants to make sure it's really you",
      ),
    ).toBe("47");
  });

  it("falls back to a 2-digit number on a recognized challenge page", () => {
    expect(
      extractGoogleNumberMatch("Match the number  Google wants to make sure it's really you  89"),
    ).toBe("89");
  });

  it("returns null on unrelated pages", () => {
    expect(extractGoogleNumberMatch("Sign in with your password")).toBeNull();
    expect(extractGoogleNumberMatch("")).toBeNull();
  });
});

describe("scrapeGoogleScopePhrases", () => {
  it("flags a Drive read scope", () => {
    const phrases = scrapeGoogleScopePhrases(
      "Vercel will get to: See and download all your Google Drive files. Continue",
    );
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]).toMatch(/see and download/i);
  });

  it("flags a contacts manage scope", () => {
    const phrases = scrapeGoogleScopePhrases("App will be able to: Manage your contacts. Allow");
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]).toMatch(/manage your contacts/i);
  });

  it("flags a send-mail-as-you scope", () => {
    const phrases = scrapeGoogleScopePhrases("Send email on your behalf to anyone you choose");
    expect(phrases.length).toBeGreaterThan(0);
  });

  it("returns empty on a basic-only consent / chooser / confirmation page", () => {
    expect(
      scrapeGoogleScopePhrases(
        "Continue to Vercel. Vercel wants access to your Google Account. Allow",
      ),
    ).toEqual([]);
    expect(scrapeGoogleScopePhrases("Choose an account to continue to Vercel")).toEqual([]);
    expect(scrapeGoogleScopePhrases("")).toEqual([]);
  });
});

describe("extractOAuthScopes (T7)", () => {
  it("reads space-separated scopes off the consent URL", () => {
    expect(
      extractOAuthScopes(
        "https://accounts.google.com/signin/oauth/consent?scope=openid%20email%20profile",
      ),
    ).toEqual(["openid", "email", "profile"]);
  });

  it("tolerates '+' as the scope separator", () => {
    expect(
      extractOAuthScopes("https://accounts.google.com/o/oauth2/v2/auth?scope=openid+email"),
    ).toEqual(["openid", "email"]);
  });

  it("finds scopes nested inside a `continue` param", () => {
    const inner = encodeURIComponent(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=openid%20email",
    );
    expect(
      extractOAuthScopes(`https://accounts.google.com/signin/oauth/consent?continue=${inner}`),
    ).toEqual(["openid", "email"]);
  });

  it("returns null when no scope param is present anywhere", () => {
    expect(
      extractOAuthScopes("https://accounts.google.com/signin/oauth/consent?client_id=x"),
    ).toBeNull();
    expect(extractOAuthScopes("not-a-url")).toBeNull();
  });
});

describe("scopesAreBasic (T7)", () => {
  it("accepts only the basic-identity allowlist", () => {
    expect(scopesAreBasic(["openid", "email", "profile"])).toBe(true);
    expect(scopesAreBasic(["openid", "https://www.googleapis.com/auth/userinfo.email"])).toBe(true);
  });

  it("rejects any broader scope", () => {
    expect(scopesAreBasic(["openid", "https://www.googleapis.com/auth/gmail.readonly"])).toBe(
      false,
    );
    expect(scopesAreBasic(["https://www.googleapis.com/auth/drive"])).toBe(false);
  });

  it("rejects an empty scope list — absence is not confirmation", () => {
    expect(scopesAreBasic([])).toBe(false);
  });
});
