// google-login.ts — Phase 1, T2 (/plan-eng-review).
//
// Establishes and reads the provider sessions in the bot's persistent Chrome
// profile. `connect` (install/cli.ts) is the ONLY caller that opens a login;
// every signup after it is fully automated.
//
// The install-confirm ceremony opens as a TAB in the shared browser: when a
// resident broker holds the profile, connect is an ordinary broker client —
// it opens one session tab at the confirm URL and watches for the Finish
// callback; the user signs in there and completion arrives out of band
// through the nonce-scoped Finish callback. Because the broker's Chrome runs
// on its own private Xvfb, connect also exposes that display over noVNC for
// the ceremony (same x11vnc + websockify + tunnel stack as the standalone
// remote login) — a tab no human can see is a tab no human can complete.
// Exposure is best-effort: any failure to attach degrades to the unexposed
// tab with a logged cause and the ceremony continues; it never blocks a
// connect that would otherwise succeed. A deferred --force-relogin clear
// rides the same tab as ordinary logout navigation. Only when no broker can
// serve (first connect on an unenrolled machine, or no live broker) does
// connect launch its own persistent-context browser on the bot profile — the
// same launcher class the operator uses.
// Completion never comes off a live BrowserContext in either path.
//
// The self-launched ceremony uses a local visible Chrome window when one
// exists. On a headless host it starts a login-scoped Xvfb + noVNC tunnel so
// a human can drive that same browser remotely. Automated operator sessions
// do not use this module's display stack and remain on Chrome's new-headless
// path.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";
import {
  CHROME_PROFILE_DIR,
  closeProfileWithProof,
  currentProfileHolderPid,
  launchWithProfileGate,
  ProfileBusyError,
  profileProcessIdentity,
  type ProfileCloseState,
  type ProfileProcessIdentity,
  waitForProfileFree,
  withProfileOperationGuard,
} from "./profile.js";
import { clearProviderCookiesFromContext } from "./login-state.js";
import {
  closeBrowserContextWithin,
  registerLocalBrowserLaunch,
} from "./browser.js";
import { createSessionGuard } from "../session-guard.js";
import { connectOrLaunchBroker, resolveBrokerSocket } from "./broker/discovery.js";
import type { BrokerClient } from "./broker/transport.js";
import { extractGoogleAccountEmail } from "./oauth-login.js";
export { extractGoogleAccountEmail };
import {
  startInstallCompletionListener,
  withInstallCompletionCallback,
} from "./install-completion.js";
import {
  bindOwnerBrowserLaunch,
  markOwnerBrowserLaunchTerminal,
  terminateOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "./owner-process-reaper.js";
import type { BrowserContext } from "playwright";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  assertRemoteLoginRigLive,
  createRemoteLoginRig,
  createRemoteLoginVncSecrets,
  exposeRemoteLoginDisplay,
  registerRemoteLoginRigCleanup,
  remoteLoginEnvironment,
  startRemoteLoginDisplay,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "./remote-login-display.js";
export { extractOAuthScopes, scopesAreBasic, scrapeGoogleScopePhrases } from "./oauth-scope.js";

const require = createRequire(import.meta.url);

export type LoginProxyDisposition = {
  server: string;
  username?: string;
  password?: string;
} | null;

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
    bindLaunch?: (marker: string, profileDir: string) => boolean;
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
  let context: BrowserContext | null = null;
  try {
    context = await launcher.launchPersistentContext(userDataDir, {
      ...options,
      env: ownership.env,
      channel: "chrome",
    });
    const bindLaunch =
      runtime.bindLaunch ??
      ((marker: string, profileDir: string): boolean => {
        const holderPid = currentProfileHolderPid(profileDir);
        const identity = holderPid === null ? null : profileProcessIdentity(holderPid, profileDir);
        return identity !== null && bindOwnerBrowserLaunch(marker, identity);
      });
    if (!bindLaunch(ownership.marker, userDataDir)) {
      throw new Error("persistent login browser identity could not be bound to owner custody");
    }
  } catch (error) {
    markTerminal(ownership.marker);
    if (context !== null) await closeBrowserContextWithin(context, runtime.closeTimeoutMs);
    if (await terminate(ownership.marker, userDataDir).catch(() => false)) {
      untrack(ownership.marker);
    }
    throw error;
  }
  if (context === null) throw new Error("persistent login browser did not start");
  const boundContext = context;
  let closing: Promise<void> | undefined;
  return {
    context: boundContext,
    marker: ownership.marker,
    close: (): Promise<void> => {
      closing ??= (async () => {
        markTerminal(ownership.marker);
        await closeBrowserContextWithin(boundContext, runtime.closeTimeoutMs);
        const terminated = await terminate(ownership.marker, userDataDir).catch(() => false);
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
  } catch (err) {
    // A probe failure is NOT proof of "signed out", but every caller treats a
    // null the same way, so name it. Losing this line is how a broken probe
    // reads as an empty profile.
    console.error(
      `[connect] Google identity probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    await page?.close().catch(() => undefined);
  }
}

// --- config ------------------------------------------------------------
// Provider cookie markers. A cookie proves the provider login succeeded; the
// live validation below proves the session behind it is still alive.
interface LoginTarget {
  provider: OAuthProviderId;
  label: string;
  cookieOrigin: string;
  cookies: readonly string[];
  /**
   * The markers that survive on DISK, for the read-only profile probe. A live
   * BrowserContext sees a provider's session cookies whether or not Chrome ever
   * writes them; the cookie store only ever holds the persistent ones. GitHub's
   * `user_session` is session-scoped and is never written, so reading the store
   * for it reports every signed-in profile as signed out. `dotcom_user` is the
   * row GitHub does persist while signed in, and it is removed on sign-out.
   */
  persistedCookies: readonly string[];
}
const LOGIN_TARGETS: Record<OAuthProviderId, LoginTarget> = {
  google: {
    provider: "google",
    label: "Google",
    cookieOrigin: "https://www.google.com",
    cookies: ["__Secure-1PSID", "SID", "HSID", "SSID", "APISID", "SAPISID"],
    persistedCookies: ["__Secure-1PSID", "SID", "HSID", "SSID", "APISID", "SAPISID"],
  },
  github: {
    provider: "github",
    label: "GitHub",
    cookieOrigin: "https://github.com",
    cookies: ["user_session", "__Host-user_session_same_site"],
    persistedCookies: ["dotcom_user"],
  },
};

// --- session detection -------------------------------------------------
async function hasProviderSession(context: BrowserContext, target: LoginTarget): Promise<boolean> {
  if (target.provider === "google") {
    return (await detectGoogleAccountEmailInContext(context)) !== null;
  }
  const cookies = await context.cookies(target.cookieOrigin);
  return cookies.some((cookie) => target.cookies.includes(cookie.name));
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
  if (target.provider === "google") {
    return (await detectGoogleAccountEmailInContext(context)) !== null;
  }
  // Cheap negative: no session cookie at all → definitely not logged in.
  if (!(await hasProviderSession(context, target))) return false;
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

/**
 * Read the providers whose session cookies are present in a profile WITHOUT
 * opening it: no profile lease, no wait for the profile to be free, no Chrome.
 *
 * `connect` asks this before it decides whether it needs the browser at all, and
 * the steady state on any machine that has used the MCP server is a resident
 * broker holding both the profile lease and a live Chrome on it. Opening the
 * profile to answer "are you already connected?" therefore contended with the
 * very browser the answer is about, and reported the profile as busy on exactly
 * the machines that were already connected.
 *
 * Chrome keeps the live cookie DB under an exclusive SQLite lock, so this reads
 * a byte copy: copying needs no lock, and a provider session cookie is
 * long-lived enough that a committed snapshot is the same answer. Presence is
 * all this proves — a cookie can outlive the session behind it, which is why
 * connect's "Already connected" says so and points at --force-relogin. The
 * liveness probe still runs where it is affordable (a profile this process
 * can take); on a busy profile probeProviderSessionsAfterCeremony falls back
 * to this snapshot and polls past Chrome's commit lag.
 *
 * An ABSENT profile or cookie store is an answer, not a failure: there is no
 * provider session, so the caller must run the sign-in ceremony. Only a store
 * that exists and cannot be read is unknown, and that one must not force a
 * re-pair. Conflating the two is how a machine whose profile was wiped —
 * `--force-relogin` does exactly that before the confirm — could never reach a
 * sign-in again.
 */
export async function detectProviderSessionsFromProfile(
  profileDir: string = CHROME_PROFILE_DIR,
): Promise<OAuthProviderId[]> {
  const snapshotDir = await mkdtemp(join(tmpdir(), "ts-cookie-snapshot-"));
  const snapshot = join(snapshotDir, "Cookies");
  try {
    try {
      await copyFile(join(profileDir, "Default", "Cookies"), snapshot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare("select host_key, name, expires_utc from cookies")
        .all() as ProfileCookieRow[];
      return (Object.keys(LOGIN_TARGETS) as OAuthProviderId[]).filter((id) =>
        rows.some((row) => cookieProvesSession(row, LOGIN_TARGETS[id])),
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

interface ProfileCookieRow {
  host_key: string;
  name: string;
  expires_utc: number;
}

// Chrome stores expiry as microseconds since 1601-01-01 UTC.
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

function cookieProvesSession(row: ProfileCookieRow, target: LoginTarget, now = Date.now()): boolean {
  if (!target.persistedCookies.includes(row.name)) return false;
  const host = new URL(target.cookieOrigin).hostname;
  const matchesHost = row.host_key.startsWith(".")
    ? host === row.host_key.slice(1) || host.endsWith(row.host_key)
    : host === row.host_key;
  if (!matchesHost) return false;
  // Only a row that CARRIES an expiry can be expired. A session cookie records
  // none, and reading its zero as "expired in 1601" rejects a live session.
  if (row.expires_utc === 0) return true;
  return row.expires_utc / 1000 - WINDOWS_EPOCH_OFFSET_MS > now;
}

// Inspect a live bot Chrome context and return the providers whose sessions are
// currently present. This is the source of truth for provider availability.
//
// Cost is ~1-1.5s for the persistent-context launch + cookie read +
// teardown. We only call it at install boundaries (after the install
// confirm establishes whichever provider the user clicked, before the
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
        // live. Google is verified by a My Account identity probe, since its
        // chooser cookies can survive after the account is signed out.
        if (await validateProviderSession(ctx, LOGIN_TARGETS[id])) present.push(id);
      }
      return present;
    } finally {
      await persistent.close();
    }
  });
}

// Chrome commits dirty cookie rows on its own ~30s timer, so immediately
// after a broker-hosted ceremony the fresh sign-in cookies may still be
// uncommitted inside the browser that holds the profile: the live probe
// cannot take the profile (ProfileBusyError) and a committed snapshot can
// lag. Probe the live path first; when the profile is busy, fall back to the
// committed-cookie snapshot and poll past the commit lag before accepting a
// negative. Presence-only evidence is the same class connect's preflight
// already accepts on a busy machine — "Already connected" reads the cookie
// store for exactly this reason. `null` means the probe itself failed, which
// is not a pass.
export async function probeProviderSessionsAfterCeremony(
  profileDir: string = CHROME_PROFILE_DIR,
  runtime: {
    live?: typeof detectActiveProviderSessions;
    snapshot?: typeof detectProviderSessionsFromProfile;
    windowMs?: number;
    pollMs?: number;
  } = {},
): Promise<OAuthProviderId[] | null> {
  try {
    return await (runtime.live ?? detectActiveProviderSessions)(profileDir);
  } catch (err) {
    if (!(err instanceof ProfileBusyError)) return null;
  }
  const deadline = Date.now() + (runtime.windowMs ?? COOKIE_COMMIT_WINDOW_MS);
  const snapshot = runtime.snapshot ?? detectProviderSessionsFromProfile;
  let found: OAuthProviderId[] = [];
  for (;;) {
    found = await snapshot(profileDir).catch(() => []);
    if (found.length > 0 || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, runtime.pollMs ?? COOKIE_COMMIT_POLL_MS));
  }
}

const COOKIE_COMMIT_WINDOW_MS = 45_000;
const COOKIE_COMMIT_POLL_MS = 3_000;

// Kept as the public import surface for existing callers. The pure helper is
// split out so browser.ts can consume it without forming a runtime cycle with
// this profile/login lifecycle module.
export {
  classifyGoogleAuthState,
  extractGoogleHumanChallenge,
  extractGoogleNumberMatch,
  type GoogleAuthState,
  type GoogleHumanChallenge,
} from "./google-auth-state.js";

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

// Open the bot's visible Chrome at `url` and run `pollUntilDone` until it
// resolves true, the deadline passes, or the browser/status check fails.
//
// Two launch paths (see the module header): the shared broker's tab, and the
// self-launched `launchPersistentContext` Chrome. NEITHER is the plain spawn
// STATE.md's 2026-07-20 bisect cleared — it names launchPersistentContext
// "also CDP" too, and that plain cell was replaced when the ceremony moved
// onto the shared browser. That bisect confirmed a CDP attach × Google OAuth
// failure for the OLD self-launch + connectOverCDP cell; whether either path
// here trips the same check is the open hypothesis the PATH A/B E2E proofs
// settle. Nothing drives the user's sign-in in either path: completion
// arrives out of band, through `connect`'s nonce-scoped Finish callback.
export interface RunInBotChromeOpts {
  profileDir: string;
  url: string;
  deadline: number;
  // Returns true once the ceremony has completed. Re-polled every ~3s. It
  // takes no BrowserContext on purpose: completion is out of band (the
  // nonce-scoped Finish callback), never a read off the live page.
  pollUntilDone: () => Promise<boolean>;
  // Short label shown after the local Chrome window opens.
  bannerLabel: string;
  // The install flow has a sign-in phase followed by an explicit Finish
  // step. Resolve this lazily so its heartbeat describes the current phase.
  heartbeatMessage?: string | (() => string);
  onProxyDisposition?: (proxy: LoginProxyDisposition) => void;
  // Deferred --force-relogin clears: `clearProviderCookies` busy-failed
  // because the broker's browser holds the profile, so the old provider
  // sessions are signed out through the ceremony's own tab instead (the
  // self-launch path clears them from its context directly).
  forceReloginProviders?: readonly OAuthProviderId[];
}

const LOGIN_BROWSER_CLOSED_ERROR =
  "the login browser closed before the session completed — re-run the command after closing any other Trusty Squire session";
const LOGIN_STATUS_CHECK_STALLED_ERROR =
  "the login status check stopped responding before the session completed";

// The install-confirm ceremony: a tab in the shared broker browser when one
// can serve, otherwise connect's own persistent-context browser (local window
// or, headless, the noVNC login rig). Both paths keep the user in the bot's
// persistent profile and both are watched by the same poll loop.
export async function runInBotChrome(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  const shared = await tryRunCeremonyInSharedBroker(opts);
  if (shared !== null) return shared;
  return await runLoginBrowserForEnvironment(opts);
}

export interface LoginRunResult {
  status: "satisfied" | "timeout";
  closeState: ProfileCloseState;
}

// The broker's Chrome runs headed on a private Xvfb rig owned by the daemon
// (`ownedHeadedBrowserEnvironment` always builds one), so a ceremony tab
// hosted there is invisible to the user unless this process exposes that
// display over noVNC — the same x11vnc + websockify + tunnel stack the
// standalone remote login uses. The display coordinates are discovered from
// the browser process's own environment (/proc on Linux); the helpers this
// call spawns are reaped at the ceremony's lease boundary and never touch
// the display or the browser itself. Returns null — never throws — when
// there is nothing to expose or exposure could not be set up: the tab is
// NOT on a rig this repo created (a real user display the human can already
// see, or a platform with no /proc), or the noVNC attach itself failed
// (logged; the ceremony continues without it — exposure shows the login,
// it is never a precondition for it).
export async function exposeSharedBrokerCeremonyDisplay(
  profileDir: string,
  label: string,
): Promise<(() => Promise<void>) | null> {
  const holderPid = currentProfileHolderPid(profileDir);
  if (holderPid === null) return null;
  const env = readProcessEnvironment(holderPid);
  const display = env?.DISPLAY;
  const authFile = env?.XAUTHORITY;
  if (display === undefined || authFile === undefined) return null;
  if (!isOwnedLoginRigXauthority(authFile)) return null;
  // Everything below is BEST-EFFORT exposure: the noVNC page is how the human
  // is SHOWN the login, not a precondition for logging in. Any failure —
  // missing helper binaries, tunnel misconfig, attach error — degrades to
  // "no exposure", is logged with its concrete cause, and the ceremony
  // continues. This function never throws and never refuses a connect.
  let rig: RemoteLoginRig;
  try {
    rig = createRemoteLoginRig();
    // FRESH VNC secrets of our own — createRemoteLoginSecrets would also mint
    // an Xauthority, but the display's authorization belongs to the broker's
    // Xvfb.
    createRemoteLoginVncSecrets(rig);
    rig.display = display;
    rig.authFile = authFile;
  } catch (err) {
    console.error(
      `[login] could not prepare a noVNC rig for the shared browser's display ` +
        `(${err instanceof Error ? err.message : String(err)}) — continuing without it.`,
    );
    return null;
  }
  const removeCleanup = registerRemoteLoginRigCleanup(rig, () => undefined);
  try {
    await exposeRemoteLoginDisplay(rig, label);
  } catch (err) {
    removeCleanup();
    await teardownRemoteLoginRig(rig).catch(() => undefined);
    console.error(
      `[login] could not expose the shared browser's display over noVNC ` +
        `(${err instanceof Error ? err.message : String(err)}) — continuing without it.`,
    );
    return null;
  }
  return async () => {
    // Helpers only: the display and the browser belong to the broker daemon.
    removeCleanup();
    await teardownRemoteLoginRig(rig);
  };
}

// Rigs this repo creates live in private dirs named `tsq-login-*` directly
// under the temp root; an Xauthority pointing anywhere else belongs to the
// machine's real display, which the user can already see.
function isOwnedLoginRigXauthority(authFile: string): boolean {
  const dir = dirname(authFile);
  return basename(dir).startsWith("tsq-login-") && dirname(dir) === tmpdir();
}

// The broker's Chrome inherits its display rig from the daemon's launch
// environment. On Linux, /proc/<pid>/environ is the live record of that
// environment (NUL-separated); other platforms have no equivalent, and a
// failed read just means "cannot discover" — the caller decides what that
// is worth.
function readProcessEnvironment(pid: number): NodeJS.ProcessEnv | null {
  if (process.platform !== "linux") return null;
  try {
    const raw = readFileSync(join("/proc", String(pid), "environ"));
    const env: NodeJS.ProcessEnv = {};
    for (const entry of raw.toString("utf-8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

const PROVIDER_LOGOUT_URLS: Record<OAuthProviderId, string> = {
  google: "https://accounts.google.com/Logout",
  github: "https://github.com/logout",
};

async function operateCommand(
  client: BrokerClient,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // The daemon injects session_id into the tool args itself; a caller that
  // guesses it is refused, so only the tool's own arguments travel.
  return await client.call("command", { sessionId, name, args });
}

// A deferred --force-relogin clear runs through the very tab the ceremony
// opened: ordinary operator verbs (navigate +, for GitHub, its one confirm
// click) inside the shared browser — no second Chrome, no profile custody.
// Best-effort by design: a provider that is already signed out has nothing
// to clear (its logout page 404s or renders without the button), and a
// failed clear must not block the fresh sign-in the user asked for.
async function logoutProvidersThroughSession(
  client: BrokerClient,
  sessionId: string,
  confirmUrl: string,
  providers: readonly OAuthProviderId[],
): Promise<void> {
  for (const provider of providers) {
    try {
      await operateCommand(client, sessionId, "operate_navigate", {
        url: PROVIDER_LOGOUT_URLS[provider],
      });
      if (provider === "github") {
        let signedOut = true;
        try {
          await operateCommand(client, sessionId, "operate_click", {
            ref: 'text="Sign out"',
          });
        } catch {
          signedOut = false;
        }
        if (!signedOut) {
          console.error(
            `[login] GitHub did not show a Sign out button in the shared browser — it may already be signed out. Continuing.`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[login] could not sign out of ${provider} in the shared browser ` +
          `(${err instanceof Error ? err.message : String(err)}) — continuing.`,
      );
    }
  }
  // Return the tab to the confirm page so the fresh sign-in starts there.
  // Best-effort as well: if it fails the poll reports honestly instead of
  // masking the failure as a clear success.
  try {
    await operateCommand(client, sessionId, "operate_navigate", { url: confirmUrl });
  } catch (err) {
    console.error(
      `[login] could not return the shared browser's tab to the confirm page ` +
        `(${err instanceof Error ? err.message : String(err)}) — open it there to continue.`,
    );
  }
}

/**
 * Open the confirm page as a session tab in the shared broker's browser — an
 * ordinary broker-client open of one tab family, no drain and no second
 * Chrome. On an enrolled machine with no resident broker, the ordinary
 * connect-or-launch path spawns the broker daemon, whose browser hosts the
 * tab (and keeps the prior-contract / stale-credential reclaim contracts).
 * Returns null when no broker can serve (unenrolled machine, or the broker
 * path failed): the caller then self-launches, which fail-fasts on the
 * profile gate if a browser actually holds the profile.
 */
export async function tryRunCeremonyInSharedBroker(
  opts: RunInBotChromeOpts,
): Promise<LoginRunResult | null> {
  const session = await createSessionGuard().bind();
  if (session?.agent_session_token === undefined || session.account_id === undefined) return null;
  let client: BrokerClient;
  try {
    client = await connectOrLaunchBroker(
      resolveBrokerSocket(opts.profileDir),
      session.agent_session_token,
      session.account_id,
    );
  } catch {
    // No live broker and none could be launched (or its credential was
    // refused): the self-launch path's profile gate reports the truth about
    // the profile instead of racing it.
    return null;
  }
  let sessionId: string | undefined;
  let stopExposure: (() => Promise<void>) | null | undefined;
  try {
    const open = (await client.call("open", { serviceUrl: opts.url })) as {
      sessionId?: string;
    };
    sessionId = open.sessionId;
    if (sessionId === undefined)
      throw new Error("the shared browser did not open the install-confirm tab");
    if (opts.forceReloginProviders?.length) {
      await logoutProvidersThroughSession(
        client,
        sessionId,
        opts.url,
        opts.forceReloginProviders,
      );
    }
    // The broker's Chrome runs on its own private Xvfb, so the tab is
    // invisible to the user until this process exposes that display over
    // noVNC. A tab no human can see is a tab no human can complete.
    stopExposure = await exposeSharedBrokerCeremonyDisplay(opts.profileDir, opts.bannerLabel);
    console.error(
      stopExposure === null
        ? `\n[login] The install page opened as a tab in the shared browser. ${opts.bannerLabel}\n`
        : `\n[login] The install page opened as a tab in the shared browser's display — open the noVNC URL above on any device to see and drive it.\n`,
    );
    const ok = await pollUntil(
      opts.deadline,
      () => opts.pollUntilDone(),
      opts.heartbeatMessage,
      () => {
        if (!client.isConnected()) throw new Error(LOGIN_BROWSER_CLOSED_ERROR);
      },
    );
    return { status: ok ? "satisfied" : "timeout", closeState: "closed" };
  } finally {
    // Exposure helpers go first (they are this process's own); the session
    // tab goes at this connection's lease boundary, and releasing the
    // connection is the boundary itself. The display and the browser stay
    // with the broker daemon throughout.
    if (stopExposure !== undefined && stopExposure !== null)
      await stopExposure().catch(() => undefined);
    if (sessionId !== undefined) await client.call("close", { sessionId }).catch(() => undefined);
    await client.release().catch(() => undefined);
  }
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

// The self-launched ceremony browser: a headed persistent-context Chrome on
// the bot profile — the same launcher class the operator uses, with operator
// launch custody (marker, reaper bind, graceful close). The profile gate
// fail-fasts when another browser holds the profile, so a machine with a
// resident broker that could not be reached is refused honestly instead of
// racing it.
export interface CeremonyBrowser {
  identity: ProfileProcessIdentity | null;
  isRunning: () => boolean;
  teardown: () => Promise<void>;
  forceTeardown: () => Promise<void>;
}

export async function launchCeremonyBrowserContext(
  params: {
    profileDir: string;
    url: string;
    window: { width: number; height: number };
    env: NodeJS.ProcessEnv;
    forceReloginProviders?: readonly OAuthProviderId[];
  },
  runtime: {
    launchPersistentLoginContext?: typeof launchPersistentLoginContext;
  } = {},
): Promise<CeremonyBrowser> {
  return await withProfileOperationGuard(params.profileDir, async () => {
    const login = await launchWithProfileGate(
      params.profileDir,
      async () =>
        await (runtime.launchPersistentLoginContext ?? launchPersistentLoginContext)(
          resolveChromium(),
          params.profileDir,
          {
            headless: false,
            viewport: null,
            args: [
              `--window-size=${params.window.width},${params.window.height}`,
              "--lang=en-US",
              "--no-first-run",
              "--no-default-browser-check",
              "--password-store=basic",
              "--no-sandbox",
              "--disable-dev-shm-usage",
            ],
          },
        ),
      { failFast: true },
    );
    const page = login.context.pages()[0] ?? (await login.context.newPage());
    if (params.forceReloginProviders?.length) {
      // Deferred --force-relogin clear: the earlier standalone clear
      // busy-failed, but this context now owns the profile, so the clear
      // finally has custody. Best-effort — a failed clear warns and continues
      // rather than recreating the hard refusal finding 3 was about.
      const both =
        params.forceReloginProviders.includes("google") &&
        params.forceReloginProviders.includes("github");
      const provider = both ? undefined : params.forceReloginProviders[0];
      try {
        const cleared = await clearProviderCookiesFromContext(login.context, provider);
        if (!cleared) {
          console.error(
            "[login] some provider cookies could not be cleared in the ceremony browser — continuing.",
          );
        }
      } catch (err) {
        console.error(
          `[login] provider cookie clear failed in the ceremony browser ` +
            `(${err instanceof Error ? err.message : String(err)}) — continuing.`,
        );
      }
    }
    await page.goto(params.url);
    const holderPid = currentProfileHolderPid(params.profileDir);
    const identity =
      holderPid === null ? null : profileProcessIdentity(holderPid, params.profileDir);
    const close = async (): Promise<void> => {
      await login.close();
    };
    return {
      identity,
      isRunning: () => currentProfileHolderPid(params.profileDir) !== null,
      teardown: close,
      forceTeardown: (): Promise<void> => close().catch(() => undefined),
    };
  });
}

export async function runDisplayedChrome(
  opts: RunInBotChromeOpts,
  runtime: {
    launchCeremonyBrowserContext: typeof launchCeremonyBrowserContext;
  } = { launchCeremonyBrowserContext },
): Promise<LoginRunResult> {
  opts.onProxyDisposition?.(null);
  const lifecycle = createTrackedLoginBrowserLifecycle();
  let status: LoginRunResult["status"] = "timeout";
  let closeState: ProfileCloseState = "unknown";
  try {
    const browser = await runtime.launchCeremonyBrowserContext({
      profileDir: opts.profileDir,
      url: opts.url,
      window: { width: 1280, height: 800 },
      env: process.env,
      ...(opts.forceReloginProviders?.length
        ? { forceReloginProviders: opts.forceReloginProviders }
        : {}),
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
      () => opts.pollUntilDone(),
      opts.heartbeatMessage,
      () => {
        if (!browser.isRunning()) throw new Error(LOGIN_BROWSER_CLOSED_ERROR);
      },
    );
    status = ok ? "satisfied" : "timeout";
  } finally {
    closeState = await lifecycle.finish();
  }
  return { status, closeState };
}

export async function runRemoteLoginChrome(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  const rig = createRemoteLoginRig();
  let activeTeardown: (() => Promise<void>) | undefined;
  const removeRigCleanup = registerRemoteLoginRigCleanup(rig, () => activeTeardown);
  const lifecycle = createTrackedLoginBrowserLifecycle(
    async () => await teardownRemoteLoginRig(rig),
  );
  activeTeardown = lifecycle.cancel;

  try {
    await startRemoteLoginDisplay(rig);
    lifecycle.throwIfCancelled();

    opts.onProxyDisposition?.(null);
    const browserEnv = remoteLoginEnvironment(rig);
    const browser = await launchCeremonyBrowserContext({
      profileDir: opts.profileDir,
      url: opts.url,
      window: { width: rig.width, height: rig.height },
      env: browserEnv,
      ...(opts.forceReloginProviders?.length
        ? { forceReloginProviders: opts.forceReloginProviders }
        : {}),
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
    try {
      await exposeRemoteLoginDisplay(rig, opts.bannerLabel);
      lifecycle.throwIfCancelled();

      const completed = await pollUntil(
        opts.deadline,
        () => opts.pollUntilDone(),
        opts.heartbeatMessage,
        () => {
          assertRemoteLoginRigLive(rig);
          if (!browser.isRunning()) throw new Error(LOGIN_BROWSER_CLOSED_ERROR);
        },
      );
      const closeState = await lifecycle.finish();
      return {
        status: completed ? "satisfied" : "timeout",
        closeState,
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
    // Returns claimed only after the install ceremony succeeds. No path reads
    // completion off the live page, so the per-run Finish callback is the
    // completion signal for every install path.
    pollUntilClaimed: (wizardCompleted: boolean) => Promise<InstallClaimPollResult>;
    profileDir?: string;
    timeoutMinutes?: number;
    // Phase-aware terminal copy supplied by connect.
    heartbeatMessage?: string | (() => string);
    // Deferred --force-relogin providers (cleared through the ceremony
    // itself when the standalone cookie-clear busy-failed).
    forceReloginProviders?: readonly OAuthProviderId[];
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
      pollUntilDone: async () =>
        installClaimPollCompleted(await opts.pollUntilClaimed(completion?.isCompleted() === true)),
      ...(opts.heartbeatMessage !== undefined ? { heartbeatMessage: opts.heartbeatMessage } : {}),
      ...(opts.forceReloginProviders?.length
        ? { forceReloginProviders: opts.forceReloginProviders }
        : {}),
    });
    if (result.status === "satisfied") {
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
