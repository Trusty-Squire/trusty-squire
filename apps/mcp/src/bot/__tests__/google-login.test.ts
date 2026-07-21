// Covers the pure environment helpers in google-login.ts (T2). The
// login orchestration itself spawns real processes (Xvfb, x11vnc,
// cloudflared) and is validated by running it, not unit-tested — these
// are the deterministic pieces that can be.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  binaryOnPath,
  installHint,
  classifyGoogleAuthState,
  extractGoogleAccountEmail,
  extractGoogleNumberMatch,
  extractOAuthScopes,
  findFreePort,
  hasDisplay,
  pollUntil,
  profileHasProviderCookies,
  scopesAreBasic,
  scrapeGoogleScopePhrases,
} from "../google-login.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("profileHasProviderCookies (plain-login on-disk seed check)", () => {
  // The connect claim browser runs plain (no CDP — a CDP attach fails Google's
  // OAuth "secure browser" check), so seeding is read from the profile's raw
  // Cookies file. Chrome stores cookie NAMES as plaintext in the SQLite pages,
  // so a byte-substring match answers "did this session's cookie get written".
  const withProfile = (fileBytes: string | null, sub = "Default"): string => {
    const dir = mkdtempSync(join(tmpdir(), "phpc-"));
    if (fileBytes !== null) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, "Cookies"), Buffer.from(fileBytes, "latin1"));
    }
    return dir;
  };

  it("detects a Google session by its cookie name in the Cookies file", () => {
    const dir = withProfile("SQLite format 3\0 ... SAPISID ... __Secure-1PSID ...");
    expect(profileHasProviderCookies(dir, "google")).toBe(true);
    // Only Google cookies present → github stays false.
    expect(profileHasProviderCookies(dir, "github")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a GitHub session by user_session", () => {
    const dir = withProfile("SQLite format 3\0 ... user_session ...");
    expect(profileHasProviderCookies(dir, "github")).toBe(true);
    expect(profileHasProviderCookies(dir, "google")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a cookieless profile and never throws on a missing file", () => {
    const dir = withProfile("SQLite format 3\0 nothing useful here");
    expect(profileHasProviderCookies(dir, "google")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    const missing = withProfile(null);
    expect(profileHasProviderCookies(missing, "google")).toBe(false);
    rmSync(missing, { recursive: true, force: true });
  });

  it("also finds cookies in the bare <profile>/Cookies layout", () => {
    const dir = withProfile("SQLite format 3\0 SAPISID", ".");
    expect(profileHasProviderCookies(dir, "google")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
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

    const waiting = pollUntil(
      Date.now() + 60_000,
      async () => done,
      "fixed install heartbeat",
    );

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
    expect(stderr.mock.calls.at(-1)?.[0]).toContain(
      "Still waiting for you to finish signing in",
    );

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

  it("every launchPersistentContext call sets channel:\"chrome\"", () => {
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
    expect(extractGoogleAccountEmail("Signed in as user@gmail.com — Manage")).toBe("user@gmail.com");
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
      if (savedForceDisplay !== undefined) process.env.TRUSTY_SQUIRE_FORCE_DISPLAY = savedForceDisplay;
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
    expect(classifyGoogleAuthState("https://accounts.google.com/odd/page", "")).toBe(
      "needs_login",
    );
  });
});

describe("extractGoogleNumberMatch", () => {
  it("reads the number from the 'tap N on your phone' phrasing", () => {
    expect(
      extractGoogleNumberMatch(
        "Verify it's you — Tap 28 on your phone to sign in",
      ),
    ).toBe("28");
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
      extractGoogleNumberMatch(
        "Match the number  Google wants to make sure it's really you  89",
      ),
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
    const phrases = scrapeGoogleScopePhrases(
      "App will be able to: Manage your contacts. Allow",
    );
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]).toMatch(/manage your contacts/i);
  });

  it("flags a send-mail-as-you scope", () => {
    const phrases = scrapeGoogleScopePhrases(
      "Send email on your behalf to anyone you choose",
    );
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
    expect(extractOAuthScopes("https://accounts.google.com/signin/oauth/consent?client_id=x")).toBeNull();
    expect(extractOAuthScopes("not-a-url")).toBeNull();
  });
});

describe("scopesAreBasic (T7)", () => {
  it("accepts only the basic-identity allowlist", () => {
    expect(scopesAreBasic(["openid", "email", "profile"])).toBe(true);
    expect(
      scopesAreBasic([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
    ).toBe(true);
  });

  it("rejects any broader scope", () => {
    expect(
      scopesAreBasic(["openid", "https://www.googleapis.com/auth/gmail.readonly"]),
    ).toBe(false);
    expect(scopesAreBasic(["https://www.googleapis.com/auth/drive"])).toBe(false);
  });

  it("rejects an empty scope list — absence is not confirmation", () => {
    expect(scopesAreBasic([])).toBe(false);
  });
});
