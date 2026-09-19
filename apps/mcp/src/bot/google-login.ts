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
// through the nonce-scoped Finish callback. Only when no broker can serve
// (first connect on an unenrolled machine, or no live broker) does connect
// launch its own persistent-context browser on the bot profile — the same
// launcher class the operator uses. Completion never comes off a live
// BrowserContext in either path.
//
// The self-launched ceremony uses a local visible Chrome window when one
// exists. On a headless host it starts a login-scoped Xvfb + noVNC tunnel so
// a human can drive that same browser remotely. Automated operator sessions
// do not use this module's display stack and remain on Chrome's new-headless
// path.

import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import {
  CHROME_PROFILE_DIR,
  closeProfileWithProof,
  currentProfileHolderPid,
  launchWithProfileGate,
  profileProcessIdentity,
  type ProfileCloseState,
  type ProfileProcessIdentity,
  waitForProfileFree,
  withProfileOperationGuard,
} from "./profile.js";
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
 * liveness probe below still runs where it is affordable: after the ceremony,
 * on a profile this process has just closed.
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
// The login browser is always PLAIN Chrome — spawned with no
// `--remote-debugging-port` and never `connectOverCDP`ed — because Google's
// OAuth "secure browser" integrity check rejects a CDP-attached Chrome
// (STATE.md 2026-07-20). Nothing drives this browser: the user signs in
// themselves and completion arrives out of band, through `connect`'s
// nonce-scoped Finish callback.
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
  try {
    const open = (await client.call("open", { serviceUrl: opts.url })) as {
      sessionId?: string;
    };
    sessionId = open.sessionId;
    if (sessionId === undefined)
      throw new Error("the shared browser did not open the install-confirm tab");
    console.error(
      `\n[login] The install page opened as a tab in the shared browser. ${opts.bannerLabel}\n`,
    );
    const ok = await pollUntil(
      opts.deadline,
      () => opts.pollUntilDone(),
      opts.heartbeatMessage,
    );
    return { status: ok ? "satisfied" : "timeout", closeState: "closed" };
  } finally {
    // The session tab goes at this connection's lease boundary; releasing the
    // connection is the boundary itself.
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
    // Returns claimed only after the install ceremony succeeds. The plain login
    // browser intentionally has no CDP endpoint, so the per-run Finish callback
    // is the completion signal for every install path.
    pollUntilClaimed: (wizardCompleted: boolean) => Promise<InstallClaimPollResult>;
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
