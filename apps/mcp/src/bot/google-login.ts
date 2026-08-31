// google-login.ts — Phase 1, T2 (/plan-eng-review).
//
// Ensures the bot's persistent Chrome profile holds a valid Google
// session. This is the one-time interactive login; every signup after
// it is fully automated.
//
// Interactive login uses a local visible Chrome window when one exists. On a
// headless host it starts a login-scoped Xvfb + noVNC tunnel so a human can
// drive that same browser remotely. Automated operator sessions do not use
// this module's display stack and remain on Chrome's new-headless path.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import chalk from "chalk";
import {
  CHROME_PROFILE_DIR,
  closeProfileWithProof,
  currentProfileHolderPid,
  launchWithProfileGate,
  profileProcessIdentity,
  PROFILE_BUSY_MESSAGE,
  ProfileBusyError,
  reapProfileHolderIfOwned,
  type ProfileCloseState,
  type ProfileProcessIdentity,
  waitForProfileFree,
  withProfileOperationGuard,
} from "./profile.js";
import {
  closeBrowserContextWithin,
  extractGoogleAccountEmail,
  launchPlainLoginBrowser,
  launchSelfManagedLoginContext,
  registerLocalBrowserLaunch,
  resolveChannelBinary,
  selfLaunchEnabled,
} from "./browser.js";
export { extractGoogleAccountEmail };
import {
  startInstallCompletionListener,
  withInstallCompletionCallback,
} from "./install-completion.js";
import {
  markOwnerBrowserLaunchTerminal,
  terminateOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "./owner-process-reaper.js";
import type { BrowserContext } from "playwright";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  canonicalIdentitySnapshotDisposition,
  GOOGLE_LOGIN_COOKIE_MARKERS,
  readCanonicalIdentityMetadata,
  writeCanonicalIdentitySnapshot,
  type BrowserStorageState,
} from "./session-state.js";
import {
  assertRemoteLoginRigLive,
  createRemoteLoginRig,
  exposeRemoteLoginDisplay,
  registerRemoteLoginRigCleanup,
  remoteLoginEnvironment,
  startRemoteLoginDisplay,
  teardownRemoteLoginRig,
} from "./remote-login-display.js";
export { extractOAuthScopes, scopesAreBasic, scrapeGoogleScopePhrases } from "./oauth-scope.js";

const require = createRequire(import.meta.url);

export type LoginProxyDisposition = {
  server: string;
  username?: string;
  password?: string;
} | null;

function loginProxyOption(): Exclude<LoginProxyDisposition, null> | undefined {
  return undefined;
}

function selfLaunchProxyDisposition(
  proxy: Exclude<LoginProxyDisposition, null> | undefined,
): LoginProxyDisposition {
  return proxy === undefined ? null : { server: proxy.server };
}

// --- stealth chromium (mirrors BrowserController) ----------------------
export interface PersistentLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<BrowserContext>;
}

export interface PersistentLoginContext {
  readonly context: BrowserContext;
  readonly marker: string;
  close(): Promise<void>;
}

export async function launchPersistentLoginContext(
  launcher: PersistentLauncher,
  userDataDir: string,
  options: Record<string, unknown>,
  runtime: {
    registerLocalBrowserLaunch?: typeof registerLocalBrowserLaunch;
    markTerminal?: typeof markOwnerBrowserLaunchTerminal;
    terminate?: typeof terminateOwnerBrowserLaunch;
    untrack?: typeof untrackOwnerBrowserLaunch;
    closeTimeoutMs?: number;
  } = {},
): Promise<PersistentLoginContext> {
  const register = runtime.registerLocalBrowserLaunch ?? registerLocalBrowserLaunch;
  const markTerminal = runtime.markTerminal ?? markOwnerBrowserLaunchTerminal;
  const terminate = runtime.terminate ?? terminateOwnerBrowserLaunch;
  const untrack = runtime.untrack ?? untrackOwnerBrowserLaunch;
  const ownership = register(
    userDataDir,
    (options.env as NodeJS.ProcessEnv | undefined) ?? process.env,
  );
  let context: BrowserContext;
  try {
    context = await launcher.launchPersistentContext(userDataDir, {
      ...options,
      env: ownership.env,
      channel: "chrome",
    });
  } catch (error) {
    markTerminal(ownership.marker);
    if (await terminate(ownership.marker).catch(() => false)) untrack(ownership.marker);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    context,
    marker: ownership.marker,
    close: (): Promise<void> => {
      closing ??= (async () => {
        markTerminal(ownership.marker);
        await closeBrowserContextWithin(context, runtime.closeTimeoutMs);
        const terminated = await terminate(ownership.marker).catch(() => false);
        if (!terminated) throw new Error("persistent login browser closure unproven");
        untrack(ownership.marker);
      })();
      return closing;
    },
  };
}

function resolveChromium(): PersistentLauncher {
  try {
    const extra = require("playwright-extra") as {
      chromium: PersistentLauncher & { use: (plugin: unknown) => unknown };
    };
    const stealth = require("puppeteer-extra-plugin-stealth") as () => unknown;
    extra.chromium.use(stealth());
    return extra.chromium;
  } catch {
    return (require("playwright") as { chromium: PersistentLauncher }).chromium;
  }
}

export async function captureProfileStorageState(
  profileDir: string,
  runtime: {
    resolveChannelBinary: typeof resolveChannelBinary;
    launchSelfManagedLoginContext: typeof launchSelfManagedLoginContext;
    teardownLoginBrowser: typeof teardownLoginBrowser;
  } = {
    resolveChannelBinary,
    launchSelfManagedLoginContext,
    teardownLoginBrowser,
  },
): Promise<{ storageState: BrowserStorageState; googleAccountEmail?: string }> {
  const lifecycle = createTrackedLoginBrowserLifecycle();
  let state: BrowserStorageState | undefined;
  let googleAccountEmail: string | null = null;
  let closeState: ProfileCloseState = "unknown";
  let captureContextAcquired = false;
  try {
    const binary = runtime.resolveChannelBinary("chrome");
    if (binary === null) throw new Error("no Chrome binary found for identity capture");
    let tracked = false;
    const trackBrowser = (browser: {
      teardown: () => Promise<void>;
      forceTeardown: () => void;
      isRunning: () => boolean;
      marker: string;
    }): void => {
      if (tracked) return;
      tracked = true;
      lifecycle.browserLaunched(
        async () =>
          await runtime.teardownLoginBrowser({
            profileDir,
            identity: null,
            closeBrowser: browser.teardown,
            forceClose: browser.forceTeardown,
            isRunning: browser.isRunning,
          }),
      );
    };
    const browser = await runtime.launchSelfManagedLoginContext({
      binary,
      profileDir,
      initialUrl: "about:blank",
      appMode: false,
      window: { width: 1280, height: 800 },
      env: process.env,
      proxyServer: null,
      extraArgs: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"],
      onSpawned: trackBrowser,
    });
    trackBrowser(browser);
    const context = browser.context;
    captureContextAcquired = true;
    googleAccountEmail = await detectGoogleAccountEmailInContext(context);
    state = await context.storageState({ indexedDB: true });
  } catch (error) {
    if (!captureContextAcquired) lifecycle.throwIfCancelled();
    throw error;
  } finally {
    closeState = await lifecycle.finish();
  }
  lifecycle.throwIfCancelled();
  if (closeState !== "closed") {
    throw new Error(`login identity capture closed without proof (${closeState})`);
  }
  return {
    storageState: state!,
    ...(googleAccountEmail === null ? {} : { googleAccountEmail }),
  };
}

async function detectGoogleAccountEmailInContext(context: BrowserContext): Promise<string | null> {
  let page: Awaited<ReturnType<BrowserContext["newPage"]>> | null = null;
  try {
    page = await context.newPage();
    await page.goto("https://myaccount.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (new URL(page.url()).hostname !== "myaccount.google.com") return null;
    const labels = await page
      .locator("[aria-label]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label") ?? ""),
      );
    for (const label of labels) {
      const email = extractGoogleAccountEmail(label.trim());
      if (email !== null) return email;
    }
    return null;
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => undefined);
  }
}

// --- config ------------------------------------------------------------
// Provider cookie markers for `mcp login` (T13). A cookie proves the provider
// login succeeded; the Trusty Squire vault return proves its OAuth handoff also
// finished before the portable session is published.
interface LoginTarget {
  provider: OAuthProviderId;
  label: string;
  cookieOrigin: string;
  cookies: readonly string[];
}
const LOGIN_TARGETS: Record<OAuthProviderId, LoginTarget> = {
  google: {
    provider: "google",
    label: "Google",
    cookieOrigin: "https://www.google.com",
    cookies: GOOGLE_LOGIN_COOKIE_MARKERS,
  },
  github: {
    provider: "github",
    label: "GitHub",
    cookieOrigin: "https://github.com",
    cookies: ["user_session", "__Host-user_session_same_site"],
  },
};
const DEFAULT_LOGIN_WEB_BASE = "https://trustysquire.ai";

export function explicitLoginStartUrl(
  provider: OAuthProviderId,
  webBase = process.env.TRUSTY_SQUIRE_WEB_BASE ?? DEFAULT_LOGIN_WEB_BASE,
): string {
  const url = new URL(`/v1/auth/oauth/${provider}/start`, webBase);
  url.searchParams.set("next", "/vault");
  return url.toString();
}

interface ExplicitLoginContext {
  cookies(url: string): Promise<Array<{ name: string }>>;
  pages(): Array<{ url(): string }>;
}

export async function explicitLoginCompleted(
  context: ExplicitLoginContext,
  provider: OAuthProviderId,
  webBase = process.env.TRUSTY_SQUIRE_WEB_BASE ?? DEFAULT_LOGIN_WEB_BASE,
): Promise<boolean> {
  const target = LOGIN_TARGETS[provider];
  const cookies = await context.cookies(target.cookieOrigin);
  if (!cookies.some((cookie) => target.cookies.includes(cookie.name))) return false;
  const expected = new URL(webBase);
  const page = context.pages()[0];
  if (page === undefined) return false;
  try {
    const current = new URL(page.url());
    return (
      current.origin === expected.origin &&
      (current.pathname === "/vault" || current.pathname.startsWith("/vault/"))
    );
  } catch {
    return false;
  }
}
export interface LoginResult {
  status: "logged_in" | "already_valid" | "timeout" | "error";
  detail?: string;
}

// --- session detection -------------------------------------------------
async function hasProviderSession(context: BrowserContext, target: LoginTarget): Promise<boolean> {
  const cookies = await context.cookies(target.cookieOrigin);
  return cookies.some((c) => target.cookies.includes(c.name));
}

// Exported for the connect claim loop: does this LIVE context already hold the
// given provider's session cookies? The force-relogin teardown gates on this so
// it never closes the visible browser on the bare API claim while the
// interactive sign-in (e.g. Google's cold-profile second challenge) is in flight.
export async function contextHasProviderSession(
  context: BrowserContext,
  provider: OAuthProviderId,
): Promise<boolean> {
  return hasProviderSession(context, LOGIN_TARGETS[provider]);
}

function providerIdentityMarkerCount(
  state: BrowserStorageState,
  provider: OAuthProviderId,
  nowSeconds = Date.now() / 1_000,
): number {
  if (provider === "google") {
    return state.cookies.filter((cookie) => {
      const host = cookie.domain.replace(/^\./, "");
      return (
        /(^|\.)google\.com$/i.test(host) &&
        GOOGLE_LOGIN_COOKIE_MARKERS.includes(
          cookie.name as (typeof GOOGLE_LOGIN_COOKIE_MARKERS)[number],
        ) &&
        cookie.value.length > 10 &&
        (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > nowSeconds)
      );
    }).length;
  }
  return state.cookies.filter((cookie) => {
    const host = cookie.domain.replace(/^\./, "");
    return (
      /(^|\.)github\.com$/i.test(host) &&
      LOGIN_TARGETS.github.cookies.includes(cookie.name) &&
      cookie.value.length > 0 &&
      (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > nowSeconds)
    );
  }).length;
}

function capturedPageLocations(context: BrowserContext): string[] {
  return context.pages().flatMap((page) => {
    try {
      const url = new URL(page.url());
      return [`${url.origin}${url.pathname}`];
    } catch {
      return [];
    }
  });
}

const PROVIDER_COOKIE_MARKERS: Record<OAuthProviderId, readonly string[]> = {
  google: GOOGLE_LOGIN_COOKIE_MARKERS,
  github: ["user_session"],
};

export function profileHasProviderCookies(profileDir: string, provider: OAuthProviderId): boolean {
  const markers = PROVIDER_COOKIE_MARKERS[provider];
  const bases = [join(profileDir, "Default", "Cookies"), join(profileDir, "Cookies")];
  const root = provider === "google" ? "google.com" : "github.com";
  for (const path of bases) {
    if (!existsSync(path)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(path, {
        readonly: true,
        fileMustExist: true,
        timeout: 250,
      });
      const placeholders = markers.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT 1
             FROM cookies
            WHERE (host_key = ? OR host_key = ? OR host_key LIKE ?)
              AND name IN (${placeholders})
            LIMIT 1`,
        )
        .get(root, `.${root}`, `%.${root}`, ...markers);
      if (row !== undefined) return true;
    } catch {
      continue;
    } finally {
      db?.close();
    }
  }
  return false;
}

// VALIDATE a session instead of just spotting a cookie. A provider session that
// expired server-side often leaves its `user_session` cookie sitting in the
// profile, so name-presence false-positives ("the GitHub marker lies"). Here we
// navigate to the provider once — which forces it to refresh its ground-truth
// auth state — and read that, so a dead-but-present session reports false.
// GitHub: an anonymous/expired visit sets `logged_in=no`; a live one, `=yes`.
async function validateProviderSession(
  context: BrowserContext,
  target: LoginTarget,
): Promise<boolean> {
  // Cheap negative: no session cookie at all → definitely not logged in.
  if (!(await hasProviderSession(context, target))) return false;
  if (target.provider !== "github") return true; // only GitHub's marker is known to lie
  const page = await context.newPage();
  try {
    await page
      .goto(target.cookieOrigin, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => undefined);
    const cookies = await context.cookies("https://github.com");
    const loggedIn = cookies.find((c) => c.name === "logged_in");
    // logged_in is GitHub's explicit auth flag; the visit above just refreshed
    // it to the real state. Treat a missing flag as not-logged-in (fail closed).
    return loggedIn?.value === "yes";
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

// Inspect the bot Chrome profile on disk and return the set of OAuth
// providers whose session cookies are currently present. The marker
// file at logged-in-providers.json is a write-once memo from prior
// runs and can lie (cookies expire, the user logs out from the
// provider's site, etc.). This function is the source of truth.
//
// Cost is ~1-1.5s for the persistent-context launch + cookie read +
// teardown. We only call it at install boundaries (after the install
// confirm seeds whatever provider the user clicked, before the
// secondary-provider prompt fires) so the latency is acceptable.
export async function detectActiveProviderSessions(
  profileDir: string = CHROME_PROFILE_DIR,
): Promise<OAuthProviderId[]> {
  return await withProfileOperationGuard(profileDir, async () => {
    // Quick best-effort gate — this runs at install boundaries, so a short
    // wait is fine: reclaim a stale lock, or briefly yield to a live run.
    await waitForProfileFree(profileDir, { deadlineMs: 15_000, pollMs: 500 });
    const chromium = resolveChromium();
    const persistent = await launchWithProfileGate(profileDir, () =>
      launchPersistentLoginContext(chromium, profileDir, {
        headless: true,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }),
    );
    const ctx = persistent.context;
    try {
      const present: OAuthProviderId[] = [];
      for (const id of Object.keys(LOGIN_TARGETS) as OAuthProviderId[]) {
        // ALWAYS validate (not just cookie-present) — this kills the "GitHub
        // marker lies" class on EVERY path, including the hot provision start, not
        // just the install display. validateProviderSession is cheap: it returns
        // a fast false when no cookie is present (no navigation), and only pays
        // the github.com round-trip when a github cookie EXISTS and must be proven
        // live. Google stays presence-based (it doesn't lie this way).
        if (await validateProviderSession(ctx, LOGIN_TARGETS[id])) present.push(id);
      }
      return present;
    } finally {
      await persistent.close();
    }
  });
}

// --- T5: Google auth-page state detection ------------------------------
// After the bot clicks "Sign in with Google" on a service the browser
// lands on a Google page. This classifies which one — so the OAuth
// signup flow (T6) proceeds ONLY on a consent screen and otherwise
// stops. CRITICAL: a `needs_login` or `challenge` result means the bot
// must hand back to the human and NEVER type into Google's form — there
// is no password to give, and driving Google's login is exactly what
// trips its automation detection.
export type GoogleAuthState =
  | "consent" // valid session — Google is asking to share account info
  | "needs_login" // session absent/expired — Google wants credentials
  | "challenge" // Google interrupted with a verify-it's-you / 2FA step
  | "not_google"; // not on a Google auth page (flow moved on, or completed)

export function classifyGoogleAuthState(url: string, bodyText: string): GoogleAuthState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not_google";
  }
  if (!/(^|\.)accounts\.google\.com$/i.test(parsed.hostname)) {
    return "not_google";
  }
  const path = parsed.pathname.toLowerCase();
  const text = bodyText.toLowerCase();

  // Consent — a valid session; Google is asking to share account data.
  if (
    path.includes("/oauth/consent") ||
    path.includes("/signin/oauth") ||
    text.includes("wants access to your google account") ||
    text.includes("wants to access your google account") ||
    (text.includes("to continue to") && (text.includes("allow") || text.includes("continue")))
  ) {
    return "consent";
  }

  // Challenge — a verify-it's-you / 2FA step. Not /challenge/pwd, which
  // is the password step of an ordinary login (→ needs_login).
  if (
    (path.includes("/challenge/") && !path.includes("/challenge/pwd")) ||
    text.includes("verify it's you") ||
    text.includes("verify it’s you") ||
    text.includes("2-step verification")
  ) {
    return "challenge";
  }

  // Everything else on accounts.google.com → Google wants credentials.
  // Erring toward needs_login is the safe default: it stops the bot
  // rather than risk it proceeding into a page it must not automate.
  return "needs_login";
}

// Google's "number-match" challenge (URL: /signin/challenge/dp) shows
// ONE big number on the desktop browser; the user's phone shows three
// options and they tap the matching one. The number is the only piece
// of state the user needs to complete the challenge — extract it from
// the page text so the bot can surface it to the user. Returns null
// when the text isn't a number-match page.
//
// Exported for unit testing — phrasing varies by locale/version.
export function extractGoogleNumberMatch(text: string): string | null {
  const m1 = text.match(/tap\s+(\d{1,3})\s+on\s+your/i);
  if (m1 && m1[1] !== undefined) return m1[1];
  const m2 = text.match(/\b(\d{1,3})\s+on\s+your\s+(?:phone|other\s+device)/i);
  if (m2 && m2[1] !== undefined) return m2[1];
  // Fallback: text mentions the number-match challenge but used a
  // phrasing we don't know yet. Pull the most plausible digit group —
  // a 2-digit number is the current Google pattern.
  if (/match the number|tap the number|google wants to make sure/i.test(text)) {
    const digits = text.match(/\b\d{1,3}\b/g);
    if (digits) {
      const twoDigit = digits.find((d) => d.length === 2);
      if (twoDigit !== undefined) return twoDigit;
      if (digits[0] !== undefined) return digits[0];
    }
  }
  return null;
}

// --- environment helpers ----------------------------------------------
export function hasDisplay(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // macOS (Aqua) and Windows (Win32) have native windowing; Linux needs
  // an existing user-visible X display.
  if (platform === "darwin" || platform === "win32") return true;
  if (typeof env.DISPLAY !== "string" || env.DISPLAY.trim().length === 0) return false;
  if (
    (typeof env.SSH_CONNECTION === "string" && env.SSH_CONNECTION.trim().length > 0) ||
    (typeof env.SSH_TTY === "string" && env.SSH_TTY.trim().length > 0) ||
    env.XDG_SESSION_TYPE?.trim().toLowerCase() === "tty"
  ) {
    return false;
  }
  return true;
}

export async function teardownLoginBrowser(opts: {
  profileDir: string;
  identity: ProfileProcessIdentity | null;
  closeBrowser: () => Promise<void>;
  forceClose: () => unknown;
  isRunning?: () => boolean;
  timeoutMs?: number;
}): Promise<ProfileCloseState> {
  let profileState: ProfileCloseState;
  if (opts.identity === null && opts.isRunning !== undefined) {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      Promise.resolve()
        .then(opts.closeBrowser)
        .then(
          () => true,
          () => false,
        ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const waitForExit = async (): Promise<boolean> => {
      const deadline = Date.now() + 2_000;
      while (opts.isRunning!() && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      return !opts.isRunning!();
    };
    if (closed && (await waitForExit())) profileState = "closed";
    else {
      opts.forceClose();
      profileState = (await waitForExit()) ? "closed" : "force_closed_unproven";
    }
  } else {
    profileState = await closeProfileWithProof({
      profileDir: opts.profileDir,
      identity: opts.identity,
      close: opts.closeBrowser,
      forceClose: opts.forceClose,
      ...(opts.timeoutMs !== undefined ? { closeTimeoutMs: opts.timeoutMs } : {}),
    });
  }
  return profileState;
}

// --- shutdown coordination with the operator server -------------------
// Every in-flight login run registers a cancel closure here so an external
// shutdown owner (the MCP server's disconnect coordinator) can close the
// OAuth-bootstrap Chrome instead of orphaning it. The closures wrap the run's
// own proof-checked teardown (closeProfileWithProof over the launch-time
// process identity), so cancellation never signals a PID it cannot prove
// ownership of.
const activeLoginBrowserCancels = new Set<() => Promise<void>>();

// Returns the unregister disposer for the normal completion path.
export function trackActiveLoginBrowser(cancel: () => Promise<void>): () => void {
  activeLoginBrowserCancels.add(cancel);
  return (): void => {
    activeLoginBrowserCancels.delete(cancel);
  };
}

// Cancel every in-flight login run's browser. Called by the MCP server's
// shutdown path; idempotent and
// best-effort — a failed teardown must not stall the process exit, whose
// process-level exit hooks still force-kill anything identity-proven.
export async function cancelActiveLoginBrowsers(): Promise<void> {
  const pending = [...activeLoginBrowserCancels];
  activeLoginBrowserCancels.clear();
  await Promise.all(pending.map((cancel) => cancel().catch(() => undefined)));
}

interface TrackedLoginBrowserLifecycle {
  cancellation: Promise<void>;
  cancel(): Promise<void>;
  throwIfCancelled(): void;
  browserLaunched(teardown: () => Promise<ProfileCloseState>): void;
  finish(): Promise<ProfileCloseState>;
}

function createTrackedLoginBrowserLifecycle(
  teardownRun?: () => Promise<void>,
): TrackedLoginBrowserLifecycle {
  let cancelled = false;
  let launchSettled = false;
  let resolveLaunchSettlement: (() => void) | undefined;
  const launchSettlement = new Promise<void>((resolve) => {
    resolveLaunchSettlement = resolve;
  });
  let teardownBrowser: (() => Promise<ProfileCloseState>) | undefined;
  let browserTeardown: Promise<ProfileCloseState> | undefined;
  let runTeardown: Promise<void> | undefined;
  let cancellation: Promise<void> | undefined;
  let resolveCancellation!: () => void;
  const cancellationSignal = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  let finishing: Promise<ProfileCloseState> | undefined;

  const settleLaunch = (): void => {
    if (launchSettled) return;
    launchSettled = true;
    resolveLaunchSettlement?.();
  };
  const closeBrowser = (): Promise<ProfileCloseState> => {
    if (teardownBrowser === undefined) return Promise.resolve("unknown");
    browserTeardown ??= teardownBrowser();
    return browserTeardown;
  };
  const closeRun = (): Promise<void> => {
    if (teardownRun === undefined) return Promise.resolve();
    runTeardown ??= teardownRun();
    return runTeardown;
  };
  let lifecycle!: TrackedLoginBrowserLifecycle;
  const untrack = trackActiveLoginBrowser(async () => await lifecycle.cancel());
  lifecycle = {
    cancellation: cancellationSignal,
    cancel: (): Promise<void> => {
      cancelled = true;
      resolveCancellation();
      cancellation ??= (async () => {
        await launchSettlement;
        try {
          await closeBrowser();
        } finally {
          await closeRun();
        }
      })();
      return cancellation;
    },
    throwIfCancelled: (): void => {
      if (cancelled) throw new Error("login browser cancelled during shutdown");
    },
    browserLaunched: (teardown): void => {
      teardownBrowser = teardown;
      settleLaunch();
      lifecycle.throwIfCancelled();
    },
    finish: (): Promise<ProfileCloseState> => {
      settleLaunch();
      finishing ??= (async () => {
        let closeState: ProfileCloseState = "unknown";
        try {
          closeState = await closeBrowser();
        } finally {
          try {
            await closeRun();
          } finally {
            untrack();
          }
        }
        return closeState;
      })();
      return finishing;
    },
  };
  return lifecycle;
}

// Open the bot's visible Chrome at `url` and run `pollUntilDone`
// against the live context until it resolves true, the deadline passes,
// or the browser/status check fails. Returns whether the poll succeeded.
//
// Extracted so both `mcp login` (poll for Google/GitHub cookies in the
// bot's profile) AND `install` (poll the API for the install claim)
// share the same browser-launch infrastructure — one Chrome instance,
// one Google login event for both use cases.
export interface RunInBotChromeOpts {
  profileDir: string;
  url: string;
  deadline: number;
  // Returns true once the desired side effect has happened (cookies
  // present, install claimed, etc.). Re-polled every ~3s.
  pollUntilDone: (context: BrowserContext) => Promise<boolean>;
  // Short label shown after the local Chrome window opens.
  bannerLabel: string;
  // Optional pre-flight check that decides we don't need a browser at
  // all (e.g. an existing session covers it). Returns true to short-
  // circuit before launching Chrome.
  preflight?: (context: BrowserContext) => Promise<boolean>;
  // Optional hook called AFTER pollUntilDone returns true, while the
  // Chrome context is still open. Use this to inspect the freshly-
  // mutated profile (e.g. read which provider cookies got set) before
  // tear-down — opening a second persistent context to the same
  // profile right after close is racy (profile lock contention) and
  // can silently fail.
  onSuccess?: (context: BrowserContext) => Promise<void>;
  // The install flow has a sign-in phase followed by an explicit Finish
  // step. Resolve this lazily so its heartbeat describes the current phase.
  heartbeatMessage?: string | (() => string);
  // PLAIN-BROWSER MODE (connect claim). When set, the login browser is launched
  // as plain Chrome with NO CDP attach — required because Google's OAuth
  // "secure browser" check rejects a CDP-attached Chrome (see
  // launchPlainLoginBrowser). In this mode the browser is never driven: the
  // user signs in in the visible browser, and completion is detected via `plainPollUntilDone`
  // (which reads the API + the SQLite cookie store, not a live context). The
  // context-taking `pollUntilDone`/`onSuccess`/`preflight` above are IGNORED in
  // this mode. `mcp login` does NOT set this (it stays on the CDP path).
  plainProfileLogin?: boolean;
  // Plain-mode completion predicate. Receives the profileDir instead of a live
  // context; re-polled every ~3s. Required when plainProfileLogin is set.
  plainPollUntilDone?: (profileDir: string) => Promise<boolean>;
  // Plain-mode success hook, run after plainPollUntilDone returns true while the
  // browser is still open (read which provider cookies seeded, etc.).
  plainOnSuccess?: (profileDir: string) => Promise<void>;
  onProxyDisposition?: (proxy: LoginProxyDisposition) => void;
  onConfirmedLogin?: () => Promise<void>;
  seedProvider?: OAuthProviderId | (() => OAuthProviderId | null);
  confirmedProviders?: readonly OAuthProviderId[] | (() => readonly OAuthProviderId[]);
  // Test/local IdP seam for asserting the just-captured live context before
  // any canonical file is written. Production provider logins use the stricter
  // seedProvider marker check below.
  validateCapturedState?: (state: BrowserStorageState) => void | Promise<void>;
}

const LOGIN_BROWSER_CLOSED_ERROR =
  "the login browser closed before the session completed — re-run the command after closing any other Trusty Squire session";
const LOGIN_STATUS_CHECK_STALLED_ERROR =
  "the login status check stopped responding before the session completed";

export async function runInBotChrome(
  opts: RunInBotChromeOpts,
): Promise<{ status: "completed" | "preflight_satisfied" | "timeout" }> {
  return await withProfileOperationGuard(opts.profileDir, async () => {
    const result = await runInBotChromeWithProfileGuard(opts);
    await finalizeLoginRun(opts, result);
    return { status: result.status };
  });
}

export interface LoginRunResult {
  status: "completed" | "preflight_satisfied" | "timeout";
  closeState: ProfileCloseState;
  storageState?: BrowserStorageState;
  googleAccountEmail?: string;
  captureSource?: "displayed-live-context" | "remote-live-context";
  capturedPageLocations?: string[];
}

async function captureClosedPlainLoginState(
  profileDir: string,
  status: LoginRunResult["status"],
  closeState: ProfileCloseState,
  capture: typeof captureProfileStorageState,
): Promise<Pick<LoginRunResult, "storageState" | "googleAccountEmail">> {
  if (status !== "completed" || closeState !== "closed") return {};
  return await capture(profileDir);
}

export async function finalizeLoginRun(
  opts: Pick<
    RunInBotChromeOpts,
    | "profileDir"
    | "onConfirmedLogin"
    | "seedProvider"
    | "confirmedProviders"
    | "validateCapturedState"
  >,
  result: LoginRunResult,
): Promise<void> {
  if (result.status !== "completed" && result.status !== "preflight_satisfied") return;
  if (result.closeState !== "closed" || result.storageState === undefined) {
    throw new Error("login identity snapshot closed without publishable state");
  }
  const seedProvider =
    typeof opts.seedProvider === "function" ? opts.seedProvider() : opts.seedProvider;
  const confirmedProviders =
    typeof opts.confirmedProviders === "function"
      ? opts.confirmedProviders()
      : (opts.confirmedProviders ?? []);
  const providerMarkerCount =
    seedProvider === undefined || seedProvider === null
      ? 0
      : providerIdentityMarkerCount(result.storageState, seedProvider);
  await opts.validateCapturedState?.(result.storageState);
  const priorMetadata = await readCanonicalIdentityMetadata(opts.profileDir);
  if (seedProvider !== undefined && seedProvider !== null && result.status === "completed") {
    if (providerMarkerCount === 0) {
      if (result.captureSource !== undefined) {
        console.error(
          `[login:capture] ${JSON.stringify({
            status: "rejected_missing_provider_cookie",
            source: result.captureSource,
            profileDir: opts.profileDir,
            pages: result.capturedPageLocations ?? [],
            cookieCount: result.storageState.cookies.length,
            provider: seedProvider,
            providerMarkerCount,
          })}`,
        );
      }
      const label = seedProvider === "google" ? "Google" : "GitHub";
      throw new Error(`${label} login completed without a live identity marker`);
    }
  }
  const metadata =
    result.googleAccountEmail !== undefined
      ? { googleAccountEmail: result.googleAccountEmail }
      : seedProvider === "google" && result.status === "completed"
        ? undefined
        : priorMetadata;
  const disposition = canonicalIdentitySnapshotDisposition(result.storageState, metadata);
  if (disposition === "oversized") {
    await opts.onConfirmedLogin?.();
    return;
  }
  const published = await writeCanonicalIdentitySnapshot(
    opts.profileDir,
    result.storageState,
    metadata,
    () => true,
    confirmedProviders,
  );
  if (!published) throw new Error("login identity snapshot could not be published");
  if (result.captureSource !== undefined) {
    console.error(
      `[login:capture] ${JSON.stringify({
        status: "published",
        source: result.captureSource,
        profileDir: opts.profileDir,
        pages: result.capturedPageLocations ?? [],
        cookieCount: result.storageState.cookies.length,
        provider: seedProvider ?? null,
        providerMarkerCount,
      })}`,
    );
  }
  await opts.onConfirmedLogin?.();
}

async function runInBotChromeWithProfileGuard(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  // `mcp login` runs in a SEPARATE process from the MCP server, so the
  // in-process OAuth mutex can't serialize it against an in-flight signup.
  // Chrome's SingletonLock is the cross-process semaphore: reclaim a stale
  // holder, but fail immediately for a live one.
  const free = await waitForProfileFree(opts.profileDir, {
    deadlineMs: 0,
  });
  if (!free) {
    throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
  }
  return await runLoginBrowserForEnvironment(opts);
}

export async function runLoginBrowserForEnvironment(
  opts: RunInBotChromeOpts,
  runtime: {
    hasDisplay: () => boolean;
    runDisplayedChrome: (opts: RunInBotChromeOpts) => Promise<LoginRunResult>;
    runRemoteLoginChrome: (opts: RunInBotChromeOpts) => Promise<LoginRunResult>;
  } = { hasDisplay, runDisplayedChrome, runRemoteLoginChrome },
): Promise<LoginRunResult> {
  return runtime.hasDisplay()
    ? await runtime.runDisplayedChrome(opts)
    : await runtime.runRemoteLoginChrome(opts);
}

export async function runDisplayedChrome(
  opts: RunInBotChromeOpts,
  runtime: {
    resolveChannelBinary: typeof resolveChannelBinary;
    launchPlainLoginBrowser: typeof launchPlainLoginBrowser;
    captureProfileStorageState?: typeof captureProfileStorageState;
  } = { resolveChannelBinary, launchPlainLoginBrowser },
): Promise<LoginRunResult> {
  // PLAIN-BROWSER path (connect claim): launch plain Chrome, never attach CDP,
  // detect completion off the API + SQLite cookie store. See
  // launchPlainLoginBrowser / RunInBotChromeOpts.plainProfileLogin.
  if (opts.plainProfileLogin === true) {
    if (opts.plainPollUntilDone === undefined) {
      throw new Error("plainProfileLogin set without plainPollUntilDone");
    }
    const binary = runtime.resolveChannelBinary("chrome");
    if (binary === null) {
      throw new Error("no Chrome binary found for the plain login browser");
    }
    const proxyOpt = loginProxyOption();
    const proxyDisposition =
      proxyOpt !== undefined && proxyOpt.password === undefined
        ? selfLaunchProxyDisposition(proxyOpt)
        : null;
    opts.onProxyDisposition?.(proxyDisposition);
    const lifecycle = createTrackedLoginBrowserLifecycle();
    let status: LoginRunResult["status"] = "timeout";
    let closeState: ProfileCloseState = "unknown";
    try {
      const browser = await runtime.launchPlainLoginBrowser({
        binary,
        profileDir: opts.profileDir,
        url: opts.url,
        window: { width: 1280, height: 800 },
        env: process.env,
        // Self-launch/--proxy-server can't carry proxy auth — drop a credentialed
        // proxy (direct). Connect from the box is the point anyway.
        proxyServer: proxyDisposition?.server ?? null,
        extraArgs: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      lifecycle.browserLaunched(
        async () =>
          await teardownLoginBrowser({
            profileDir: opts.profileDir,
            identity: browser.identity,
            closeBrowser: browser.teardown,
            forceClose: browser.forceTeardown,
            isRunning: browser.isRunning,
          }),
      );
      console.error(`\n[login] A Chrome window has opened. ${opts.bannerLabel}\n`);
      const ok = await pollUntil(
        opts.deadline,
        () => opts.plainPollUntilDone!(opts.profileDir),
        opts.heartbeatMessage,
        () => {
          if (!browser.isRunning()) throw new Error(LOGIN_BROWSER_CLOSED_ERROR);
        },
      );
      if (ok && opts.plainOnSuccess !== undefined) {
        try {
          await opts.plainOnSuccess(opts.profileDir);
        } catch {
          /* swallow */
        }
      }
      status = ok ? "completed" : "timeout";
    } finally {
      closeState = await lifecycle.finish();
    }
    const captured = await captureClosedPlainLoginState(
      opts.profileDir,
      status,
      closeState,
      runtime.captureProfileStorageState ?? captureProfileStorageState,
    );
    return {
      status,
      closeState,
      ...captured,
    };
  }
  const chromium = resolveChromium();
  const proxyOpt = loginProxyOption();
  opts.onProxyDisposition?.(proxyOpt ?? null);
  const lifecycle = createTrackedLoginBrowserLifecycle();
  let status: LoginRunResult["status"] = "timeout";
  let closeState: ProfileCloseState = "unknown";
  let storageState: BrowserStorageState | undefined;
  let googleAccountEmail: string | null = null;
  let pageLocations: string[] | undefined;
  try {
    const persistent = await launchWithProfileGate(
      opts.profileDir,
      () =>
        launchPersistentLoginContext(chromium, opts.profileDir, {
          headless: false,
          viewport: { width: 1280, height: 800 },
          // Drop Playwright's default --enable-automation switch: it paints the
          // "Chrome is being controlled by automated test software" infobar AND
          // is itself an automation fingerprint the provider can read during the
          // sign-in (so removing it also helps the session survive).
          ignoreDefaultArgs: ["--enable-automation"],
          args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
          ],
          ...(proxyOpt !== undefined ? { proxy: proxyOpt } : {}),
        }),
      { failFast: true },
    );
    const context = persistent.context;
    const holderPid = currentProfileHolderPid(opts.profileDir);
    const identity = holderPid === null ? null : profileProcessIdentity(holderPid, opts.profileDir);
    lifecycle.browserLaunched(
      async () =>
        await teardownLoginBrowser({
          profileDir: opts.profileDir,
          identity,
          closeBrowser: persistent.close,
          forceClose: () => reapProfileHolderIfOwned(opts.profileDir, identity),
        }),
    );
    const preflightSatisfied =
      opts.preflight !== undefined &&
      (await checkLoginStatusWithin(opts.deadline, () => opts.preflight!(context)));
    if (preflightSatisfied) {
      status = "preflight_satisfied";
    } else {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(opts.url, { waitUntil: "domcontentloaded" });
      console.error(`\n[login] A Chrome window has opened. ${opts.bannerLabel}\n`);
      const ok = await pollUntil(
        opts.deadline,
        () => opts.pollUntilDone(context),
        opts.heartbeatMessage,
      );
      if (ok && opts.onSuccess !== undefined) {
        try {
          await opts.onSuccess(context);
        } catch {
          /* swallow */
        }
      }
      status = ok ? "completed" : "timeout";
    }
    if (status === "completed" || status === "preflight_satisfied") {
      // Snapshot the exact context whose completion predicate just passed.
      // Metadata probing opens another Google page and must never get between
      // the authoritative vault return and the cookie-jar capture.
      storageState = await context.storageState({ indexedDB: true });
      pageLocations = capturedPageLocations(context);
      const seedProvider =
        typeof opts.seedProvider === "function" ? opts.seedProvider() : opts.seedProvider;
      if (seedProvider === "google") {
        googleAccountEmail = await detectGoogleAccountEmailInContext(context);
      }
    }
  } finally {
    closeState = await lifecycle.finish();
  }
  return {
    status,
    closeState,
    ...(storageState === undefined ? {} : { storageState }),
    ...(googleAccountEmail === null ? {} : { googleAccountEmail }),
    ...(storageState === undefined
      ? {}
      : {
          captureSource: "displayed-live-context" as const,
          capturedPageLocations: pageLocations ?? [],
        }),
  };
}

export async function runRemoteLoginChrome(
  opts: RunInBotChromeOpts,
  runtime: { captureProfileStorageState?: typeof captureProfileStorageState } = {},
): Promise<LoginRunResult> {
  const rig = createRemoteLoginRig();
  let activeTeardown: (() => Promise<void>) | undefined;
  let plainBrowserIsRunning: (() => boolean) | undefined;
  const removeRigCleanup = registerRemoteLoginRigCleanup(rig, () => activeTeardown);
  const lifecycle = createTrackedLoginBrowserLifecycle(
    async () => await teardownRemoteLoginRig(rig),
  );
  activeTeardown = lifecycle.cancel;
  let storageState: BrowserStorageState | undefined;
  let pageLocations: string[] | undefined;

  try {
    await startRemoteLoginDisplay(rig);
    lifecycle.throwIfCancelled();

    const proxyOpt = loginProxyOption();
    const chromeBinary = resolveChannelBinary("chrome");
    const useSelfLaunch =
      selfLaunchEnabled() &&
      chromeBinary !== null &&
      (proxyOpt === undefined || proxyOpt.password === undefined);
    const sharedChromeArgs = [
      "--disable-blink-features=AutomationControlled",
      "--test-type",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ] as const;
    const browserEnv = remoteLoginEnvironment(rig);
    let context: BrowserContext | undefined;

    if (opts.plainProfileLogin === true) {
      if (opts.plainPollUntilDone === undefined) {
        throw new Error("plainProfileLogin set without plainPollUntilDone");
      }
      if (chromeBinary === null) {
        throw new Error("no Chrome binary found for the plain login browser");
      }
      const proxyDisposition =
        proxyOpt !== undefined && proxyOpt.password === undefined
          ? selfLaunchProxyDisposition(proxyOpt)
          : null;
      opts.onProxyDisposition?.(proxyDisposition);
      const browser = await launchPlainLoginBrowser({
        binary: chromeBinary,
        profileDir: opts.profileDir,
        url: opts.url,
        window: { width: rig.width, height: rig.height },
        env: browserEnv,
        proxyServer: proxyDisposition?.server ?? null,
        extraArgs: sharedChromeArgs,
      });
      lifecycle.browserLaunched(
        async () =>
          await teardownLoginBrowser({
            profileDir: opts.profileDir,
            identity: browser.identity,
            closeBrowser: browser.teardown,
            forceClose: browser.forceTeardown,
          }),
      );
      plainBrowserIsRunning = browser.isRunning;
    } else if (useSelfLaunch && chromeBinary !== null) {
      const proxyDisposition = selfLaunchProxyDisposition(proxyOpt);
      opts.onProxyDisposition?.(proxyDisposition);
      const browser = await launchSelfManagedLoginContext({
        binary: chromeBinary,
        profileDir: opts.profileDir,
        initialUrl: opts.url,
        appMode: true,
        window: { width: rig.width, height: rig.height },
        env: browserEnv,
        proxyServer: proxyDisposition?.server ?? null,
        extraArgs: sharedChromeArgs,
      });
      lifecycle.browserLaunched(
        async () =>
          await teardownLoginBrowser({
            profileDir: opts.profileDir,
            identity: browser.identity,
            closeBrowser: browser.teardown,
            forceClose: browser.forceTeardown,
          }),
      );
      context = browser.context;
    } else {
      const chromium = resolveChromium();
      opts.onProxyDisposition?.(proxyOpt ?? null);
      const persistent = await launchWithProfileGate(
        opts.profileDir,
        () =>
          launchPersistentLoginContext(chromium, opts.profileDir, {
            headless: false,
            viewport: null,
            env: browserEnv,
            ignoreDefaultArgs: ["--enable-automation"],
            ...(proxyOpt !== undefined ? { proxy: proxyOpt } : {}),
            args: [
              "--window-position=0,0",
              `--window-size=${rig.width},${rig.height}`,
              `--app=${opts.url}`,
              ...sharedChromeArgs,
            ],
          }),
        { failFast: true },
      );
      const holderPid = currentProfileHolderPid(opts.profileDir);
      const identity =
        holderPid === null ? null : profileProcessIdentity(holderPid, opts.profileDir);
      lifecycle.browserLaunched(
        async () =>
          await teardownLoginBrowser({
            profileDir: opts.profileDir,
            identity,
            closeBrowser: persistent.close,
            forceClose: () => reapProfileHolderIfOwned(opts.profileDir, identity),
          }),
      );
      context = persistent.context;
    }

    try {
      if (context !== undefined) {
        const preflightSatisfied =
          opts.preflight !== undefined &&
          (await checkLoginStatusWithin(opts.deadline, () => opts.preflight!(context)));
        if (preflightSatisfied) {
          storageState = await context.storageState({ indexedDB: true });
          pageLocations = capturedPageLocations(context);
          const closeState = await lifecycle.finish();
          return {
            status: "preflight_satisfied",
            closeState,
            storageState,
            captureSource: "remote-live-context",
            capturedPageLocations: pageLocations,
          };
        }
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(opts.url, { waitUntil: "domcontentloaded" });
      }

      await exposeRemoteLoginDisplay(rig, opts.bannerLabel);
      lifecycle.throwIfCancelled();

      const completed = await pollUntil(
        opts.deadline,
        () =>
          context !== undefined
            ? opts.pollUntilDone(context)
            : opts.plainPollUntilDone!(opts.profileDir),
        opts.heartbeatMessage,
        () => {
          assertRemoteLoginRigLive(rig);
          if (plainBrowserIsRunning !== undefined && !plainBrowserIsRunning()) {
            throw new Error(LOGIN_BROWSER_CLOSED_ERROR);
          }
        },
      );
      if (completed) {
        if (context !== undefined) {
          if (opts.onSuccess !== undefined) {
            try {
              await opts.onSuccess(context);
            } catch {
              // best-effort success metadata
            }
          }
          storageState = await context.storageState({ indexedDB: true });
          pageLocations = capturedPageLocations(context);
        } else if (opts.plainOnSuccess !== undefined) {
          try {
            await opts.plainOnSuccess(opts.profileDir);
          } catch {
            // best-effort success metadata
          }
        }
      }
      const closeState = await lifecycle.finish();
      const captured =
        context === undefined
          ? await captureClosedPlainLoginState(
              opts.profileDir,
              completed ? "completed" : "timeout",
              closeState,
              runtime.captureProfileStorageState ?? captureProfileStorageState,
            )
          : {};
      return {
        status: completed ? "completed" : "timeout",
        closeState,
        ...(storageState === undefined ? {} : { storageState }),
        ...(storageState === undefined || context === undefined
          ? {}
          : {
              captureSource: "remote-live-context" as const,
              capturedPageLocations: pageLocations ?? [],
            }),
        ...captured,
      };
    } finally {
      await lifecycle.finish();
      activeTeardown = undefined;
    }
  } finally {
    try {
      await lifecycle.finish();
    } finally {
      activeTeardown = undefined;
      removeRigCleanup();
    }
  }
}

// Shared timed-poll helper. `check` is invoked every 3s until it
// resolves true or the deadline passes.
// Emits a heartbeat to stderr every ~20s while waiting. After the local Chrome
// window or remote noVNC URL opens, this loop is otherwise silent for up to the full
// deadline — which is the connect-hang report: a headless box printed the
// sign-in URL and then sat on a blank cursor, looking frozen. The heartbeat
// (with remaining time) makes it obviously alive; quick completions (< 20s,
// e.g. an already-valid session) print nothing.
export async function pollUntil(
  deadline: number,
  check: () => Promise<boolean>,
  heartbeatMessage:
    | string
    | (() => string) = "Still waiting for you to finish signing in — the URL/window above stays live until you do.",
  assertStillLive?: () => void,
): Promise<boolean> {
  const beatEveryMs = 20_000;
  const maxCheckMs = 15_000;
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    if (await checkLoginStatusWithin(deadline, check, assertStillLive, maxCheckMs)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
    if (Date.now() - lastBeat >= beatEveryMs) {
      lastBeat = Date.now();
      const minsLeft = Math.max(1, Math.ceil((deadline - Date.now()) / 60_000));
      const message =
        typeof heartbeatMessage === "function" ? heartbeatMessage() : heartbeatMessage;
      console.error(chalk.dim(`   ⏳ ${message} (~${minsLeft} min left)`));
    }
  }
  return false;
}

export function checkLoginStatusWithin(
  deadline: number,
  check: () => Promise<boolean>,
  assertStillLive?: () => void,
  maxCheckMs = 15_000,
): Promise<boolean> {
  assertStillLive?.();
  const checkTimeoutMs = Math.min(maxCheckMs, Math.max(1, deadline - Date.now()));
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(checkTimer);
      if (livenessTimer !== undefined) clearInterval(livenessTimer);
      settle();
    };
    const checkTimer = setTimeout(
      () => finish(() => reject(new Error(LOGIN_STATUS_CHECK_STALLED_ERROR))),
      checkTimeoutMs,
    );
    const livenessTimer =
      assertStillLive === undefined
        ? undefined
        : setInterval(() => {
            try {
              assertStillLive();
            } catch (err) {
              finish(() => reject(err instanceof Error ? err : new Error(String(err))));
            }
          }, 1_000);
    void check().then(
      (result) => finish(() => resolve(result)),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

// --- public entry ------------------------------------------------------
// Ensures `profileDir` holds a valid session for `provider`, doing
// whichever login flow the environment calls for. Returns when the
// session is present, the deadline passes, or setup fails. T13: the
// provider defaults to Google; `mcp login --provider=github` reuses
// the same flow against github.com.
export async function ensureOAuthSession(opts?: {
  provider?: OAuthProviderId;
  profileDir?: string;
  timeoutMinutes?: number;
  // 0.8.3-rc.1 — skip the preflight session-cookie check so the
  // browser opens even when a valid session is already cached. Used
  // by `login --force-relogin` to surface the browser and let the
  // operator interactively clear a provider
  // security challenge (GitHub's "verify it's you" anti-abuse,
  // Google's number-match drift) the cached cookie alone doesn't
  // resolve.
  forceOpen?: boolean;
  webBase?: string;
}): Promise<LoginResult> {
  const provider: OAuthProviderId = opts?.provider ?? "google";
  const target = LOGIN_TARGETS[provider];
  const profileDir = opts?.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts?.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  try {
    const webBase = opts?.webBase ?? process.env.TRUSTY_SQUIRE_WEB_BASE ?? DEFAULT_LOGIN_WEB_BASE;
    const result = await runInBotChrome({
      profileDir,
      url: explicitLoginStartUrl(provider, webBase),
      deadline,
      bannerLabel: `You'll see a Chrome window — log into your ${target.label} account.`,
      // When forceOpen is true, the preflight ALSO clears the
      // provider's session cookies before returning false. Without
      // this the browser opens but pollUntilDone immediately sees the
      // still-valid cached session and exits — the operator never
      // gets a chance to interactively log in or clear a server-side
      // challenge (GitHub "verify it's you"). Clearing the cookies
      // forces the next page load to land on the provider's login
      // page in a real, interactive session.
      preflight: async (ctx) => {
        if (opts?.forceOpen === true) {
          try {
            // Clear ONLY this provider's session cookies — never a bare
            // ctx.clearCookies(), which wiped EVERY provider (a
            // force-relogin=github would nuke the live Google session and the
            // operate precondition gate would then fail "no Google session").
            // The named session cookies are what define the login; dropping
            // them forces the next load to the provider's login page.
            for (const name of target.cookies) {
              await ctx.clearCookies({ name });
            }
          } catch {
            // best-effort — if clear fails we still proceed and let
            // the operator signed out manually in the browser.
          }
          return false;
        }
        return hasProviderSession(ctx, target);
      },
      pollUntilDone: (ctx) => explicitLoginCompleted(ctx, provider, webBase),
      seedProvider: provider,
      confirmedProviders: [provider],
    });
    // Map runInBotChrome's status set to ensureOAuthSession's contract.
    let mapped: LoginResult;
    if (result.status === "preflight_satisfied") {
      mapped = { status: "already_valid" };
    } else if (result.status === "completed") {
      mapped = { status: "logged_in" };
    } else {
      mapped = { status: "timeout", detail: "no login completed before the deadline" };
    }
    return mapped;
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

// Public entry for the install flow: opens the trustysquire /install
// confirm URL in the bot's persistent Chrome profile, runs the
// user-supplied check until the active flow's completion gate passes
// (or the deadline expires), then tears down. The user's Google/GitHub
// sign-in happens inside this Chrome instance — so the bot's profile gets
// a provider session as a free side effect, and there's no separate
// "log into Google for the bot" step after install.
export async function openInstallConfirmInBotChrome(
  opts: {
    confirmUrl: string;
    // Returns claimed only after the install ceremony succeeds. The login browser
    // runs PLAIN (no CDP — Google's OAuth "secure browser" check rejects a CDP
    // attach), so the predicate gets the profileDir, NOT a live context: it
    // composes the API claim with either the normal wizard's per-run loopback
    // Finish callback or forced re-login's on-disk provider-session seed.
    pollUntilClaimed: (
      profileDir: string,
      wizardCompleted: boolean,
    ) => Promise<InstallClaimPollResult>;
    profileDir?: string;
    timeoutMinutes?: number;
    // Phase-aware terminal copy supplied by connect.
    heartbeatMessage?: string | (() => string);
  },
  runChrome: typeof runInBotChrome = runInBotChrome,
): Promise<{
  status: "claimed" | "timeout" | "error";
  detail?: string;
}> {
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let completion: Awaited<ReturnType<typeof startInstallCompletionListener>> | undefined;
  let observedGoogleIdentity = false;
  const completedProviders = new Set<OAuthProviderId>();
  const observedProviders = new Set<OAuthProviderId>();

  try {
    const doneUrl = new URL("/install/done", opts.confirmUrl).toString();
    completion = await startInstallCompletionListener(doneUrl, opts.confirmUrl);
    const confirmUrl = withInstallCompletionCallback(opts.confirmUrl, completion.callbackUrl);
    const result = await runChrome({
      profileDir,
      url: confirmUrl,
      deadline,
      bannerLabel:
        `You'll see a Chrome window with the Trusty Squire install page. ` +
        `Sign in there to connect this machine — you only sign in once.`,
      // PLAIN browser — no CDP. Google's OAuth flow (which this confirm page
      // initiates) rejects a CDP-attached Chrome (STATE.md 2026-07-20). The
      // context-taking pollUntilDone is never invoked in this mode; supply a
      // stub to satisfy the (CDP-path) type.
      plainProfileLogin: true,
      pollUntilDone: () => Promise.resolve(false),
      plainPollUntilDone: async (dir) => {
        const claim = await opts.pollUntilClaimed(dir, completion?.isCompleted() === true);
        if (typeof claim === "object" && claim.provider !== null) {
          completedProviders.add(claim.provider);
        }
        for (const provider of completion?.completedProviders() ?? []) {
          completedProviders.add(provider);
        }
        return installClaimPollCompleted(claim);
      },
      ...(opts.heartbeatMessage !== undefined ? { heartbeatMessage: opts.heartbeatMessage } : {}),
      // The user's sign-in inside this Chrome leaves a provider session in the
      // persistent profile. We don't know WHICH provider they used, so probe
      // both cookie sets (from the on-disk store — no live context in plain
      // mode) and mark whichever seeded.
      plainOnSuccess: async (dir) => {
        for (const provider of ["google", "github"] as const) {
          if (completedProviders.has(provider) && profileHasProviderCookies(dir, provider)) {
            observedProviders.add(provider);
            if (provider === "google" && completedProviders.has("google")) {
              observedGoogleIdentity = true;
            }
          }
        }
        // NB: eager Google-email capture (captureGoogleEmail) needed a live
        // context to scrape myaccount.google.com; the plain login path has
        // none. It was only an optimization ("provision proceeds without a
        // pre-known email" otherwise) — provision scrapes the email per-run
        // when unset, so dropping eager capture is safe and keeping CDP off
        // the OAuth login is the whole point of the plain path.
      },
      seedProvider: () => (observedGoogleIdentity ? "google" : null),
      confirmedProviders: () => [...observedProviders],
    });
    if (result.status === "completed") {
      return { status: "claimed" };
    }
    return { status: "timeout", detail: "no install completed before the deadline" };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await completion?.close().catch(() => undefined);
  }
}

export type InstallClaimPollResult =
  | "pending"
  | "expired"
  | { status: "claimed"; provider: OAuthProviderId | null };

export function installClaimPollCompleted(result: InstallClaimPollResult): boolean {
  if (result === "expired") {
    throw new Error("the install claim expired before sign-in completed");
  }
  return typeof result === "object" && result.status === "claimed";
}
