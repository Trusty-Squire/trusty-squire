// google-login.ts — Phase 1, T2 (/plan-eng-review).
//
// Ensures the bot's persistent Chrome profile holds a valid Google
// session. This is the one-time interactive login; every signup after
// it is fully automated.
//
// Interactive login requires a user-visible Chrome window; virtual-display and
// remote-VNC support is intentionally absent.

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
import { launchPlainLoginBrowser, resolveChannelBinary } from "./browser.js";
export { extractGoogleAccountEmail } from "./browser.js";
import {
  startInstallCompletionListener,
  withInstallCompletionCallback,
} from "./install-completion.js";
import { markProviderLoggedIn } from "./login-state.js";
import type { BrowserContext } from "playwright";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  GOOGLE_LOGIN_COOKIE_MARKERS,
  writeSessionState,
  type BrowserStorageState,
} from "./session-state.js";

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

export async function launchPersistentLoginContext(
  launcher: PersistentLauncher,
  userDataDir: string,
  options: Record<string, unknown>,
): Promise<BrowserContext> {
  return await launcher.launchPersistentContext(userDataDir, {
    ...options,
    channel: "chrome",
  });
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

// --- config ------------------------------------------------------------
// Per-provider login targets for `mcp login` (T13). `cookies` are ones
// the provider only sets after a completed login — polling for them is
// how the flow detects the user finished.
interface LoginTarget {
  provider: OAuthProviderId;
  label: string;
  loginUrl: string;
  cookieOrigin: string;
  cookies: readonly string[];
}
const LOGIN_TARGETS: Record<OAuthProviderId, LoginTarget> = {
  google: {
    provider: "google",
    label: "Google",
    loginUrl: "https://accounts.google.com/",
    cookieOrigin: "https://www.google.com",
    cookies: GOOGLE_LOGIN_COOKIE_MARKERS,
  },
  github: {
    provider: "github",
    label: "GitHub",
    loginUrl: "https://github.com/login",
    cookieOrigin: "https://github.com",
    cookies: ["user_session", "__Host-user_session_same_site"],
  },
};
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
    const ctx = await launchWithProfileGate(profileDir, () =>
      launchPersistentLoginContext(chromium, profileDir, {
        headless: true,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }),
    );
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
      await ctx.close();
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

// --- T7: OAuth consent scope gate --------------------------------------
// After the bot clicks "Sign in with Google" and lands on a consent
// screen, the OAuth signup flow auto-approves it ONLY when every scope
// the service requested is a basic-identity scope. Anything broader
// (Gmail/Drive/contacts) aborts the run for human review — a
// prompt-injected or confused agent must not be able to grant a wide
// OAuth scope on the user's behalf (see the plan's Security Boundary).
//
// The allowlist is Google-OIDC vocabulary. GitHub (Phase 2, D7) gets
// its own provider-aware allowlist when that provider lands.
const BASIC_OAUTH_SCOPES: ReadonlySet<string> = new Set([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

// Pull the OAuth `scope` parameter off a Google consent URL. Robust by
// design (a spec refinement): a query-param read, never a DOM scrape or
// a vision call. Google nests the real authorize request inside a
// `continue=` (or similar) param on the consent/chooser URL, so this
// walks nested URL-valued params up to a small depth to find `scope`.
//
// Returns the parsed scope list, or null when no `scope` param is
// present anywhere — the caller treats "can't read the scopes" as
// "can't confirm they're basic" and pauses for human review.
//
// Exported for unit testing — the nested-URL walk is the error-prone bit.
export function extractOAuthScopes(rawUrl: string): string[] | null {
  const scopes: string[] = [];
  const visit = (urlStr: string, depth: number): void => {
    if (scopes.length > 0 || depth > 8) return;
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      return;
    }
    const scope = u.searchParams.get("scope");
    if (scope !== null && scope.trim().length > 0) {
      // Google separates scopes with spaces; tolerate "+" and "," too.
      for (const s of scope.split(/[\s,+]+/)) {
        const trimmed = s.trim();
        if (trimmed.length > 0) scopes.push(trimmed);
      }
      return;
    }
    // Recurse into any param whose value is itself a URL (Google's
    // `continue`, `authError`, etc. carry the nested authorize request).
    for (const value of u.searchParams.values()) {
      if (/^https?:\/\//i.test(value.trim())) visit(value, depth + 1);
    }
  };
  visit(rawUrl, 0);
  return scopes.length > 0 ? scopes : null;
}

// True when EVERY requested scope is in the basic-identity allowlist —
// the gate for auto-approving a consent screen. An empty list returns
// false: no scopes parsed means we could not confirm, so we do not
// auto-approve. Exported for unit testing.
export function scopesAreBasic(scopes: readonly string[]): boolean {
  return scopes.length > 0 && scopes.every((s) => BASIC_OAUTH_SCOPES.has(s));
}

// Defense-in-depth for the case where extractOAuthScopes returns null
// (no parseable scope= param) but the page IS a real scope-grant
// consent. Google's consent screen lists each scope visually with a
// templated verb phrase: "See your", "Manage your", "Edit your", "Send
// email", etc. A scope-summary / account-chooser / post-grant
// confirmation does not include these phrases. So when the URL gives
// us nothing, the visible-text phrases are the next best signal.
//
// Returns the list of suspicious phrases found (each capped at 80 chars
// so a runaway match cannot blow up the response). Empty list = the
// page does not appear to grant any sensitive scope.
export function scrapeGoogleScopePhrases(text: string): string[] {
  const patterns: RegExp[] = [
    /see\s+(?:and\s+download|and\s+manage)\s+[^.\n]+/gi,
    /manage\s+(?:your|all|all\s+your)\s+(?:contacts|google\s+drive|photos|calendars?|tasks|mail|gmail|files|account|youtube)[^.\n]*/gi,
    /edit\s+(?:your|all)\s+(?:contacts|google\s+drive|photos|calendars?|tasks|mail|gmail|files)[^.\n]*/gi,
    /send\s+(?:email|mail|messages)\s+(?:on\s+your\s+behalf|as\s+you)[^.\n]*/gi,
    /view\s+(?:your|all|all\s+your)\s+(?:contacts|google\s+drive|photos|calendars?|tasks|mail|gmail|files|youtube|location\s+history)[^.\n]*/gi,
    /access\s+your\s+(?:google\s+drive|gmail|contacts|calendars?|photos|youtube)[^.\n]*/gi,
    /delete\s+(?:your|all)\s+[^.\n]+/gi,
  ];
  const matches = new Set<string>();
  for (const p of patterns) {
    for (const m of text.matchAll(p)) {
      matches.add(m[0].slice(0, 80).trim());
    }
  }
  return Array.from(matches);
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
  timeoutMs?: number;
}): Promise<ProfileCloseState> {
  return await closeProfileWithProof({
    profileDir: opts.profileDir,
    identity: opts.identity,
    close: opts.closeBrowser,
    forceClose: opts.forceClose,
    ...(opts.timeoutMs !== undefined ? { closeTimeoutMs: opts.timeoutMs } : {}),
  });
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
    cancel: (): Promise<void> => {
      cancelled = true;
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
}

export async function finalizeLoginRun(
  opts: Pick<RunInBotChromeOpts, "profileDir" | "onConfirmedLogin" | "seedProvider">,
  result: LoginRunResult,
): Promise<void> {
  if (result.status === "completed" || result.status === "preflight_satisfied") {
    await opts.onConfirmedLogin?.();
  }
  // Plain Chrome has no context to capture. Leave the existing snapshot alone;
  // it is safer than erasing every saved login after an interactive connect.
  if (result.closeState === "closed" && result.storageState !== undefined) {
    await writeSessionState(opts.profileDir, result.storageState);
  }
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
  if (!hasDisplay()) {
    throw new Error(
      "interactive login requires a user-visible display; headless remote login is no longer supported",
    );
  }
  return await runDisplayedChrome(opts);
}

export async function runDisplayedChrome(
  opts: RunInBotChromeOpts,
  runtime: {
    resolveChannelBinary: typeof resolveChannelBinary;
    launchPlainLoginBrowser: typeof launchPlainLoginBrowser;
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
    return { status, closeState };
  }
  const chromium = resolveChromium();
  const proxyOpt = loginProxyOption();
  opts.onProxyDisposition?.(proxyOpt ?? null);
  const lifecycle = createTrackedLoginBrowserLifecycle();
  let status: LoginRunResult["status"] = "timeout";
  let closeState: ProfileCloseState = "unknown";
  let storageState: BrowserStorageState | undefined;
  try {
    const context = await launchWithProfileGate(
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
    const holderPid = currentProfileHolderPid(opts.profileDir);
    const identity = holderPid === null ? null : profileProcessIdentity(holderPid, opts.profileDir);
    lifecycle.browserLaunched(
      async () =>
        await teardownLoginBrowser({
          profileDir: opts.profileDir,
          identity,
          closeBrowser: () => context.close(),
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
      storageState = await context.storageState({ indexedDB: true });
    }
  } finally {
    closeState = await lifecycle.finish();
  }
  return { status, closeState, ...(storageState === undefined ? {} : { storageState }) };
}

// Shared timed-poll helper. `check` is invoked every 3s until it
// resolves true or the deadline passes.
// Emits a heartbeat to stderr every ~20s while waiting. After the Chrome window
// opens, this loop is otherwise silent for up to the full
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
}): Promise<LoginResult> {
  const provider: OAuthProviderId = opts?.provider ?? "google";
  const target = LOGIN_TARGETS[provider];
  const profileDir = opts?.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts?.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  try {
    const result = await runInBotChrome({
      profileDir,
      url: target.loginUrl,
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
      pollUntilDone: (ctx) => hasProviderSession(ctx, target),
      onConfirmedLogin: async () => markProviderLoggedIn(provider, profileDir),
      seedProvider: provider,
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
          if (profileHasProviderCookies(dir, provider)) {
            markProviderLoggedIn(provider, dir);
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
