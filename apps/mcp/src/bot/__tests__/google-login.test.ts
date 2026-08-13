// Covers the pure environment helpers in google-login.ts (T2). The
// login orchestration itself spawns real processes (Xvfb, x11vnc,
// cloudflared) and is validated by running it, not unit-tested — these
// are the deterministic pieces that can be.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { shortenVncUrl } from "../../api-client.js";
import { childProcessIsRunning, withChromeStartupLock } from "../browser.js";
import {
  acquireProfileOperationGuard,
  launchWithProfileGate,
  ProfileBusyError,
} from "../profile.js";
import {
  binaryOnPath,
  installHint,
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
  ensureOAuthSession,
  runInBotChrome,
  type HeadlessRig,
} from "../google-login.js";

describe("canonical profile operation guard", () => {
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
    const waiting = teardownLoginBrowser(() => new Promise<void>(() => undefined), forceClose, 100);

    await vi.advanceTimersByTimeAsync(100);
    await waiting;

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

describe("login browser lifecycle guards", () => {
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

describe("login seed publication platform gate", () => {
  it("refuses login before Chrome opens when process closure cannot be proven", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await expect(
      runInBotChrome({
        profileDir: "/unused/nonlinux-profile",
        url: "https://accounts.google.com/",
        deadline: Date.now() + 1_000,
        bannerLabel: "unused",
        pollUntilDone: async () => false,
      }),
    ).rejects.toThrow("operator profile seed publication requires Linux process identity");
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

// Regression guard for the connect-flow "Provider session check failed
// (continuing)" ✗. Every persistent-context launch in this module must pass
// channel:"chrome" — the system Chrome the login flow signs in with. The
// provider-session probe once omitted it, reaching for an absent bundled
// Chromium and throwing on EVERY connect, while the stale on-disk marker still
// printed "connected". A source-shape invariant is the cheapest durable guard:
// the launches spawn real Chrome and can't be unit-exercised here.
describe("bot Chrome launch consistency", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../google-login.ts", import.meta.url)),
    "utf8",
  );

  it('every launchPersistentContext call sets channel:"chrome"', () => {
    // `.launchPersistentContext(` matches real calls; the bare interface-method
    // declaration (no leading dot) is intentionally excluded.
    const calls = [...source.matchAll(/\.launchPersistentContext\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    // For each call site, the option object (up to the closing of the call)
    // must declare channel:"chrome". Scan the ~600 chars after each call open.
    for (const m of calls) {
      const window = source.slice(m.index, m.index + 600);
      expect(window).toMatch(/channel:\s*"chrome"/);
    }
  });
});

describe("extractGoogleAccountEmail (PR3 capture-at-login)", () => {
  it("prefers the OneGoogle account-chip aria-label", () => {
    const text = "Google Account: Ada Lovelace (ada.lovelace@example.com)\nInbox\nads@notme.com";
    expect(extractGoogleAccountEmail(text)).toBe("ada.lovelace@example.com");
  });

  it("falls back to the first email token when no chip is present", () => {
    expect(extractGoogleAccountEmail("Signed in as user@gmail.com — Manage")).toBe(
      "user@gmail.com",
    );
  });

  it("returns null when there is no email in the text", () => {
    expect(extractGoogleAccountEmail("My Account · Security · Privacy")).toBeNull();
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
