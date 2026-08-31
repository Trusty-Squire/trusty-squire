// Covers deterministic Google-login helpers and lifecycle boundaries.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import {
  attachSelfManagedLoginContext,
  BrowserController,
  childProcessIsRunning,
  closeLocalBrowserLaunch,
  launchCancellablePersistentContext,
  launchPlainLoginBrowser,
  resolvePersistentFallbackIdentity,
  resolveAttachedProfileChildIdentity,
  terminateTrackedProfileChild,
  withChromeStartupLock,
  type PlainLoginBrowser,
} from "../browser.js";
import { stopOwnerProcessReaper } from "../owner-process-reaper.js";
import {
  acquireProfileOperationGuard,
  launchWithProfileGate,
  ProfileBusyError,
} from "../profile.js";
import { OPERATOR_BROWSER_MARKER_ENV } from "../operator-browser-watchdog.js";
import { loggedInProviders, markProviderLoggedIn } from "../login-state.js";
import {
  MAX_SESSION_STATE_BYTES,
  readCanonicalIdentityMetadata,
  readSessionState,
} from "../session-state.js";
import {
  cancelActiveLoginBrowsers,
  captureProfileStorageState,
  installClaimPollCompleted,
  openInstallConfirmInBotChrome,
  classifyGoogleAuthState,
  checkLoginStatusWithin,
  detectActiveProviderSessions,
  explicitLoginCompleted,
  explicitLoginStartUrl,
  extractGoogleAccountEmail,
  extractGoogleNumberMatch,
  extractOAuthScopes,
  hasDisplay,
  pollUntil,
  profileHasProviderCookies,
  runLoginBrowserForEnvironment,
  runDisplayedChrome,
  scopesAreBasic,
  scrapeGoogleScopePhrases,
  trackActiveLoginBrowser,
  ensureOAuthSession,
  finalizeLoginRun,
  launchPersistentLoginContext,
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

describe("interactive login display detection", () => {
  it("accepts native desktop windowing and Linux desktop displays", () => {
    expect(hasDisplay("darwin", {})).toBe(true);
    expect(hasDisplay("win32", {})).toBe(true);
    expect(hasDisplay("linux", { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" })).toBe(true);
    expect(hasDisplay("linux", { DISPLAY: ":1", XDG_SESSION_TYPE: "wayland" })).toBe(true);
  });

  it("rejects inherited displays in SSH and TTY sessions", () => {
    expect(
      hasDisplay("linux", {
        DISPLAY: ":99",
        SSH_CONNECTION: "203.0.113.1 12345 203.0.113.2 22",
      }),
    ).toBe(false);
    expect(hasDisplay("linux", { DISPLAY: ":99", SSH_TTY: "/dev/pts/2" })).toBe(false);
    expect(hasDisplay("linux", { DISPLAY: ":99", XDG_SESSION_TYPE: "tty" })).toBe(false);
  });

  it("rejects Linux sessions without a display", () => {
    expect(hasDisplay("linux", {})).toBe(false);
    expect(hasDisplay("linux", { DISPLAY: "  " })).toBe(false);
  });
});

describe("interactive login display routing", () => {
  const opts: RunInBotChromeOpts = {
    profileDir: "/unused/profile",
    url: "https://example.test/login",
    deadline: Date.now() + 60_000,
    pollUntilDone: async () => false,
    bannerLabel: "Complete sign-in.",
  };

  it("routes a headless login to the remote noVNC path", async () => {
    const displayed = vi.fn(async () => ({ status: "timeout", closeState: "closed" }) as const);
    const remote = vi.fn(async () => ({ status: "completed", closeState: "closed" }) as const);

    await expect(
      runLoginBrowserForEnvironment(opts, {
        hasDisplay: () => false,
        runDisplayedChrome: displayed,
        runRemoteLoginChrome: remote,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(remote).toHaveBeenCalledOnce();
    expect(displayed).not.toHaveBeenCalled();
  });

  it("keeps a user-visible desktop on the local headed path", async () => {
    const displayed = vi.fn(async () => ({ status: "completed", closeState: "closed" }) as const);
    const remote = vi.fn(async () => ({ status: "timeout", closeState: "closed" }) as const);

    await runLoginBrowserForEnvironment(opts, {
      hasDisplay: () => true,
      runDisplayedChrome: displayed,
      runRemoteLoginChrome: remote,
    });
    expect(displayed).toHaveBeenCalledOnce();
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("explicit provider login completion", () => {
  it("starts at Trusty Squire OAuth and returns to the vault", () => {
    expect(explicitLoginStartUrl("google", "https://trustysquire.ai")).toBe(
      "https://trustysquire.ai/v1/auth/oauth/google/start?next=%2Fvault",
    );
    expect(explicitLoginStartUrl("github", "https://trustysquire.ai")).toBe(
      "https://trustysquire.ai/v1/auth/oauth/github/start?next=%2Fvault",
    );
  });

  it("does not complete on a provider cookie until the OAuth callback reaches the vault", async () => {
    const cookies = vi.fn(async () => [
      { name: "SID", value: "live-google-session", domain: ".google.com", path: "/" },
    ]);
    const context = {
      cookies,
      pages: () => [
        { url: () => "https://myaccount.google.com/" },
        { url: () => "https://trustysquire.ai/vault" },
      ],
    };

    await expect(
      explicitLoginCompleted(context, "google", "https://trustysquire.ai"),
    ).resolves.toBe(false);

    context.pages = () => [{ url: () => "https://trustysquire.ai/vault" }];
    await expect(
      explicitLoginCompleted(context, "google", "https://trustysquire.ai"),
    ).resolves.toBe(true);
  });
});

function fakeProcess(name: string): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    unref: vi.fn(),
    spawnargs: [name],
    kill: vi.fn(),
  }) as unknown as ChildProcess;
}

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

  it("shares one teardown when shutdown cancels a deferred displayed launch", async () => {
    let finishLaunch: ((browser: PlainLoginBrowser) => void) | undefined;
    const launch = new Promise<PlainLoginBrowser>((resolve) => {
      finishLaunch = resolve;
    });
    const teardown = vi.fn(async () => undefined);
    const browser: PlainLoginBrowser = {
      identity: null,
      marker: "v1:1:deferred-display",
      teardown,
      forceTeardown: vi.fn(),
      isRunning: () => true,
    };
    const running = runDisplayedChrome(
      {
        profileDir: "/unused/profile",
        url: "https://example.test/login",
        deadline: Date.now() + 60_000,
        pollUntilDone: async () => false,
        bannerLabel: "Complete sign-in.",
        plainProfileLogin: true,
        plainPollUntilDone: async () => false,
      },
      {
        resolveChannelBinary: () => "/unused/chrome",
        launchPlainLoginBrowser: async () => await launch,
      },
    );
    await Promise.resolve();

    const shutdown = cancelActiveLoginBrowsers();
    finishLaunch?.(browser);

    await shutdown;
    await expect(running).rejects.toThrow("login browser cancelled during shutdown");
    expect(teardown).toHaveBeenCalledOnce();
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

    const controller = new BrowserController({ profileDir });
    const cleanupUnproven = vi.fn(async () => undefined);
    const internals = controller as unknown as {
      waitForPersistentFallbackIdentity: () => Promise<{ state: "unknown" }>;
      requirePersistentFallbackOwnership: (cleanup: () => Promise<void>) => Promise<unknown>;
    };
    internals.waitForPersistentFallbackIdentity = async () => ({ state: "unknown" });
    await expect(internals.requirePersistentFallbackOwnership(cleanupUnproven)).rejects.toThrow(
      "persistent browser launch identity could not be bound to owner custody",
    );
    expect(cleanupUnproven).toHaveBeenCalledOnce();
  });

  it("returns an unproven pre-launch close for quarantine", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-browser-cancel-"));
    const controller = new BrowserController({ profileDir });
    const internals = controller as unknown as {
      startBrowser: () => Promise<void>;
      closeBrowser: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    };
    const startImpl = vi.fn(() => new Promise<void>(() => undefined));
    const closeImpl = vi.fn(async () => "unknown" as const);
    internals.startBrowser = startImpl;
    internals.closeBrowser = closeImpl;

    try {
      void controller.start().catch(() => undefined);
      await vi.waitFor(() => expect(startImpl).toHaveBeenCalledOnce());
      await expect(controller.close({ cancelStart: true })).resolves.toBe("unknown");
      await expect(controller.close()).resolves.toBe("unknown");
      expect(closeImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("never adopts a replacement profile holder after cancellation", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-browser-replacement-"));
    const replacement = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)", "--", `--user-data-dir=${profileDir}`],
      {
        argv0: "chromium",
        env: {
          ...process.env,
          [OPERATOR_BROWSER_MARKER_ENV]: "v1:1:replacement",
        },
        stdio: "ignore",
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once("spawn", resolve);
        replacement.once("error", reject);
      });
      symlinkSync(`${hostname()}-${replacement.pid!}`, join(profileDir, "SingletonLock"));
      const controller = new BrowserController({ profileDir });
      const internals = controller as unknown as {
        startCancellationRequested: boolean;
      };
      internals.startCancellationRequested = true;

      await expect(controller.forceCloseOwnedProcessTree()).resolves.toBe("unknown");
      expect(() => process.kill(replacement.pid!, 0)).not.toThrow();
    } finally {
      replacement.kill("SIGKILL");
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("closes a committed launch immediately and cleans late settlement once", async () => {
    vi.useFakeTimers();
    const profileDir = mkdtempSync(join(tmpdir(), "ts-browser-cancel-"));
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const controller = new BrowserController({ profileDir });
    const internals = controller as unknown as {
      startLaunchCommitted: boolean;
      startBrowser: () => Promise<void>;
      closeBrowser: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    };
    const startImpl = vi.fn(() => startGate);
    const closeImpl = vi.fn(async () => "closed" as const);
    internals.startBrowser = startImpl;
    internals.closeBrowser = closeImpl;

    try {
      const starting = controller.start().catch((error: unknown) => error);
      await vi.waitFor(() => expect(startImpl).toHaveBeenCalledOnce());
      internals.startLaunchCommitted = true;
      const closing = controller.close({ cancelStart: true });
      await expect(closing).resolves.toBe("closed");
      await expect(controller.close()).resolves.toBe("closed");

      releaseStart?.();
      await vi.advanceTimersByTimeAsync(25);
      await expect(starting).resolves.toEqual(
        expect.objectContaining({ message: "BrowserController start cancelled" }),
      );
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
      startBrowser: () => Promise<void>;
      closeBrowser: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    };
    const startImpl = vi.fn(() => startGate);
    const closeImpl = vi.fn(async () => "closed" as const);
    internals.startBrowser = startImpl;
    internals.closeBrowser = closeImpl;

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
  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/google-chrome"))(
    "anchors the plain Google login browser before exposing it to the user",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ts-login-custody-"));
      const profileDir = join(root, "profile");
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", join(root, "reapers"));
      try {
        const browser = await launchPlainLoginBrowser({
          binary: "/usr/bin/google-chrome",
          profileDir,
          url: "about:blank",
          window: { width: 800, height: 600 },
          env: process.env,
          proxyServer: null,
          extraArgs: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"],
        });
        try {
          expect(browser.identity).not.toBeNull();
          expect(browser.marker).toMatch(/^v1:\d+:/);
        } finally {
          await browser.teardown();
        }
      } finally {
        stopOwnerProcessReaper();
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("keeps persistent launch custody through bounded terminal teardown", async () => {
    const context = { close: vi.fn(async () => undefined) };
    const launchPersistentContext = vi.fn().mockResolvedValue(context);
    const launcher = { launchPersistentContext } as unknown as PersistentLauncher;
    const marker = "v1:1:persistent-login";
    const markTerminal = vi.fn();
    const terminate = vi.fn(async () => true);
    const untrack = vi.fn();
    const bindLaunch = vi.fn(() => true);

    const persistent = await launchPersistentLoginContext(
      launcher,
      "/isolated-profile",
      {
        headless: true,
        channel: "bundled",
      },
      {
        registerLocalBrowserLaunch: (_profileDir, env = {}) => ({
          marker,
          env: { ...env, [OPERATOR_BROWSER_MARKER_ENV]: marker },
        }),
        markTerminal,
        terminate,
        untrack,
        bindLaunch,
      },
    );

    expect(persistent.context).toBe(context);
    expect(bindLaunch).toHaveBeenCalledWith(marker, "/isolated-profile");
    expect(markTerminal).not.toHaveBeenCalled();
    expect(launchPersistentContext).toHaveBeenCalledWith(
      "/isolated-profile",
      expect.objectContaining({
        headless: true,
        channel: "chrome",
        env: expect.objectContaining({
          TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER: expect.stringMatching(/^v1:/),
        }),
      }),
    );

    await persistent.close();

    expect(markTerminal).toHaveBeenCalledWith(marker);
    expect(context.close).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(marker, "/isolated-profile");
    expect(untrack).toHaveBeenCalledWith(marker);
  });

  it("retains persistent launch custody when exact-marker closure is unproven", async () => {
    const context = { close: vi.fn(async () => undefined) };
    const untrack = vi.fn();
    const persistent = await launchPersistentLoginContext(
      { launchPersistentContext: vi.fn(async () => context as never) },
      "/isolated-profile",
      {},
      {
        registerLocalBrowserLaunch: (_profileDir, env = {}) => ({
          marker: "v1:1:unproven-login",
          env,
        }),
        markTerminal: vi.fn(),
        terminate: vi.fn(async () => false),
        untrack,
        bindLaunch: () => true,
      },
    );

    await expect(persistent.close()).rejects.toThrow("persistent login browser closure unproven");
    expect(untrack).not.toHaveBeenCalled();
  });

  it("reaches exact-marker teardown when persistent context close hangs", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn(async () => true);
    const untrack = vi.fn();
    const persistent = await launchPersistentLoginContext(
      {
        launchPersistentContext: vi.fn(async () => ({
          close: async () => await new Promise<never>(() => undefined),
        })) as never,
      },
      "/isolated-profile",
      {},
      {
        registerLocalBrowserLaunch: (_profileDir, env = {}) => ({
          marker: "v1:1:hung-persistent-login",
          env,
        }),
        markTerminal: vi.fn(),
        terminate,
        untrack,
        bindLaunch: () => true,
        closeTimeoutMs: 10,
      },
    );

    const closing = persistent.close();
    await vi.advanceTimersByTimeAsync(10);
    await closing;

    expect(terminate).toHaveBeenCalledWith("v1:1:hung-persistent-login", "/isolated-profile");
    expect(untrack).toHaveBeenCalledWith("v1:1:hung-persistent-login");
  });

  it("uses exact-marker cleanup without the original login leader identity", async () => {
    const events: string[] = [];

    await expect(
      closeLocalBrowserLaunch("v1:1:surviving-login-renderer", "/isolated-profile", {
        markTerminal: () => {
          events.push("terminal");
        },
        terminate: async () => {
          events.push("terminate-marker");
          return true;
        },
        untrack: () => {
          events.push("untrack-marker");
        },
      }),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["terminal", "terminate-marker", "untrack-marker"]);
  });

  it("publishes the authenticated canonical cookie jar and rejects a cookie-less one", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-canonical-cookie-capture-"));
    const cookieDir = join(profileDir, "Default");
    mkdirSync(cookieDir, { recursive: true });
    const db = new Database(join(cookieDir, "Cookies"));
    db.exec(`CREATE TABLE cookies (
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      samesite INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO cookies
        (host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(".google.com", "SID", "authenticated-google-session-cookie", "/", 0, 1, 1, 2);
    db.close();
    try {
      const authenticated = await captureProfileStorageState(profileDir);
      expect(authenticated.storageState).toMatchObject({
        cookies: [
          expect.objectContaining({
            name: "SID",
            value: "authenticated-google-session-cookie",
            domain: ".google.com",
          }),
        ],
      });
      await finalizeLoginRun(
        { profileDir, seedProvider: "google", confirmedProviders: ["google"] },
        { status: "completed", closeState: "closed", ...authenticated },
      );
      await expect(readSessionState(profileDir)).resolves.toMatchObject({
        cookies: [expect.objectContaining({ name: "SID", domain: ".google.com" })],
      });

      const cookieLessDir = mkdtempSync(join(tmpdir(), "ts-cookie-less-profile-"));
      try {
        const cookieLess = await captureProfileStorageState(cookieLessDir);
        await expect(
          finalizeLoginRun(
            { profileDir, seedProvider: "google", confirmedProviders: ["google"] },
            { status: "completed", closeState: "closed", ...cookieLess },
          ),
        ).rejects.toThrow("without a live identity marker");
      } finally {
        rmSync(cookieLessDir, { recursive: true, force: true });
      }
      await expect(readSessionState(profileDir)).resolves.toMatchObject({
        cookies: [expect.objectContaining({ name: "SID", domain: ".google.com" })],
      });
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("publishes the plain-login identity after Chrome closes", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-plain-login-capture-"));
    const state = {
      cookies: [
        {
          name: "SID",
          value: "portable-google-session",
          domain: ".google.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    const events: string[] = [];
    const capture = vi.fn(async (capturedProfileDir: string) => {
      expect(capturedProfileDir).toBe(profileDir);
      events.push("capture");
      return { storageState: state, googleAccountEmail: "worker@example.com" };
    });
    try {
      const result = await runDisplayedChrome(
        {
          profileDir,
          url: "https://example.test/install",
          deadline: Date.now() + 60_000,
          pollUntilDone: async () => false,
          bannerLabel: "Complete sign-in.",
          plainProfileLogin: true,
          plainPollUntilDone: async () => true,
        },
        {
          resolveChannelBinary: () => "/unused/chrome",
          launchPlainLoginBrowser: async () => ({
            identity: {
              host: hostname(),
              pid: 2_147_483_000,
              start_time: "missing",
              user_data_dir: profileDir,
            },
            marker: "v1:1:plain-login-capture",
            teardown: async () => {
              events.push("close");
            },
            forceTeardown: vi.fn(),
            isRunning: () => true,
          }),
          captureProfileStorageState: capture,
        },
      );

      expect(result).toEqual({
        status: "completed",
        closeState: "closed",
        storageState: state,
        googleAccountEmail: "worker@example.com",
      });
      expect(events).toEqual(["close", "capture"]);
      await finalizeLoginRun({ profileDir }, result);
      await expect(readSessionState(profileDir)).resolves.toEqual(state);
      await expect(readCanonicalIdentityMetadata(profileDir)).resolves.toEqual({
        googleAccountEmail: "worker@example.com",
      });
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

describe("confirmed login finalization", () => {
  it("distinguishes a claimed install from pending and expired polls", () => {
    expect(installClaimPollCompleted("pending")).toBe(false);
    expect(installClaimPollCompleted({ status: "claimed", provider: "google" })).toBe(true);
    expect(() => installClaimPollCompleted("expired")).toThrow(/expired/);
  });

  it("refuses to confirm a login without a publishable identity snapshot", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    try {
      await expect(
        finalizeLoginRun(
          {
            profileDir,
            onConfirmedLogin: async () => markProviderLoggedIn("google", profileDir),
          },
          { status: "completed", closeState: "unknown" },
        ),
      ).rejects.toThrow("closed without publishable state");

      expect(loggedInProviders(profileDir)).toEqual([]);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("does not record a timed-out login", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const onConfirmedLogin = vi.fn();
    try {
      await finalizeLoginRun(
        { profileDir, onConfirmedLogin },
        { status: "timeout", closeState: "closed" },
      );

      expect(onConfirmedLogin).not.toHaveBeenCalled();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("writes a full captured storage state for every completed login", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    try {
      await finalizeLoginRun(
        { profileDir },
        {
          status: "completed",
          closeState: "closed",
          storageState: { cookies: [], origins: [] },
        },
      );
      expect(readFileSync(join(profileDir, "trusty-squire-session-state.json"), "utf8")).toContain(
        '"origins":[]',
      );
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("preserves prior account metadata when a later probe is inconclusive", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    try {
      await finalizeLoginRun(
        { profileDir },
        {
          status: "completed",
          closeState: "closed",
          storageState: { cookies: [], origins: [] },
          googleAccountEmail: "worker@example.com",
        },
      );
      await finalizeLoginRun(
        { profileDir },
        {
          status: "preflight_satisfied",
          closeState: "closed",
          storageState: {
            cookies: [],
            origins: [{ origin: "https://app.example.com", localStorage: [] }],
          },
        },
      );

      await expect(readCanonicalIdentityMetadata(profileDir)).resolves.toEqual({
        googleAccountEmail: "worker@example.com",
      });
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("requires live Google identity while keeping account metadata best-effort", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const liveGoogleState = {
      cookies: [
        {
          name: "SID",
          value: "live-google-session",
          domain: ".google.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    try {
      await finalizeLoginRun(
        { profileDir, seedProvider: "google", confirmedProviders: ["google"] },
        { status: "completed", closeState: "closed", storageState: liveGoogleState },
      );
      await expect(readSessionState(profileDir)).resolves.toEqual(liveGoogleState);
      expect(loggedInProviders(profileDir)).toEqual(["google"]);
      expect(
        JSON.parse(readFileSync(join(profileDir, "trusty-squire-session-state.json"), "utf8")),
      ).toMatchObject({ providerMarkers: ["google"] });
      await expect(
        finalizeLoginRun(
          { profileDir, seedProvider: "google", confirmedProviders: ["google"] },
          {
            status: "completed",
            closeState: "closed",
            storageState: { cookies: [], origins: [] },
            googleAccountEmail: "worker@example.com",
          },
        ),
      ).rejects.toThrow("without a live identity marker");
      await expect(readSessionState(profileDir)).resolves.toEqual(liveGoogleState);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("treats an oversized completed login snapshot as a clean skip", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const prior = { cookies: [], origins: [] };
    try {
      await finalizeLoginRun(
        { profileDir },
        { status: "completed", closeState: "closed", storageState: prior },
      );
      await finalizeLoginRun(
        { profileDir, confirmedProviders: ["google"] },
        {
          status: "completed",
          closeState: "closed",
          storageState: {
            cookies: [],
            origins: [
              {
                origin: "https://oversized.example",
                localStorage: [{ name: "state", value: "x".repeat(MAX_SESSION_STATE_BYTES) }],
              },
            ],
          },
        },
      );

      expect(loggedInProviders(profileDir)).toEqual([]);
      await expect(readSessionState(profileDir)).resolves.toEqual(prior);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("does not replace the prior snapshot when browser closure is unproven", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-finalize-"));
    const path = join(profileDir, "trusty-squire-session-state.json");
    const prior = '{"cookies":[{"name":"SID"}],"origins":[]}';
    writeFileSync(path, prior, { mode: 0o600 });
    try {
      await expect(
        finalizeLoginRun(
          { profileDir },
          {
            status: "completed",
            closeState: "unknown",
            storageState: { cookies: [], origins: [] },
          },
        ),
      ).rejects.toThrow("closed without publishable state");
      expect(readFileSync(path, "utf8")).toBe(prior);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("threads completed Google provenance without opening a validation browser", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-connect-seed-"));
    mkdirSync(join(profileDir, "Default"));
    const db = new Database(join(profileDir, "Default", "Cookies"));
    db.exec("CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL)");
    db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)").run(".google.com", "SID");
    db.close();
    const pollUntilClaimed = vi.fn(async () => ({ status: "claimed", provider: null }) as const);
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
        ),
      ).resolves.toEqual({ status: "claimed" });
      expect(pollUntilClaimed).toHaveBeenCalledWith(profileDir, true);
      expect(runChrome).toHaveBeenCalledOnce();
    } finally {
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
