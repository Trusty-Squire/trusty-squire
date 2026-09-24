// google-login.ts — Phase 1, T2 (/plan-eng-review).
//
// Establishes and reads the provider sessions in the bot's persistent Chrome
// profile. `connect` (install/cli.ts) is the ONLY caller that opens a login;
// every signup after it is fully automated.
//
// Connect ceremony custody, display exposure, and provider-probe contracts are
// owned by docs/browser-broker.md. Completion is the install claim, which the
// CLI polls out of band, never inferred from a live page; the nonce-scoped
// Finish callback only closes the page early.

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";
import {
  CHROME_PROFILE_DIR,
  currentProfileHolderPid,
  launchWithProfileGate,
  ProfileBusyError,
  profileProcessIdentity,
  type ProfileCloseState,
  waitForProfileFree,
  withProfileOperationGuard,
} from "./profile.js";
import { closeBrowserContextWithin, registerLocalBrowserLaunch } from "./browser.js";
import { createSessionGuard } from "../session-guard.js";
import { connectOrLaunchBroker, resolveBrokerSocket } from "./broker/discovery.js";
import { BrokerRefusal } from "./broker/refusal.js";
import type { BrokerClient } from "./broker/transport.js";
import { controlLabelV2, wireRoleToSafeRoleV2 } from "./compact-observation-v2.js";
import { extractGoogleAccountEmail } from "./oauth-login.js";
export { extractGoogleAccountEmail };
import {
  startInstallCompletionListener,
  withInstallCompletionCallback,
} from "./install-completion.js";
import {
  bindOwnerBrowserLaunch,
  ownerTrackedBrowserDisplay,
  markOwnerBrowserLaunchTerminal,
  terminateOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "./owner-process-reaper.js";
import type { BrowserContext } from "playwright";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  createRemoteLoginRig,
  createRemoteLoginVncSecrets,
  exposeRemoteLoginDisplay,
  registerRemoteLoginRigCleanup,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "./remote-login-display.js";
import { drawsWindowsNatively, hasDisplay } from "./display-env.js";
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

function cookieProvesSession(
  row: ProfileCookieRow,
  target: LoginTarget,
  now = Date.now(),
): boolean {
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
// store for exactly this reason. `awaitProviders` names the providers THIS
// run must show in the snapshot before the poll may accept it early (the
// scoped --force-relogin refresh passes the requested provider): Google's
// cookies were committed days ago, so "any provider" would return before
// the provider the run actually cared about commits. `null` means the probe
// itself failed, which is not a pass.
export async function probeProviderSessionsAfterCeremony(
  profileDir: string = CHROME_PROFILE_DIR,
  runtime: {
    live?: typeof detectActiveProviderSessions;
    snapshot?: typeof detectProviderSessionsFromProfile;
    windowMs?: number;
    pollMs?: number;
    awaitProviders?: readonly OAuthProviderId[];
  } = {},
): Promise<OAuthProviderId[] | null> {
  try {
    return await (runtime.live ?? detectActiveProviderSessions)(profileDir);
  } catch (err) {
    if (!(err instanceof ProfileBusyError)) return null;
  }
  const deadline = Date.now() + (runtime.windowMs ?? COOKIE_COMMIT_WINDOW_MS);
  const snapshot = runtime.snapshot ?? detectProviderSessionsFromProfile;
  const awaited = runtime.awaitProviders ?? [];
  // A snapshot READ FAILURE is unknown, not a definite negative: collapsing it
  // to [] turned "could not read the store" into "no provider session" — the
  // exact conflation the absent-vs-unreadable distinction exists to prevent.
  // The probe returns null only when EVERY read in the window failed; a read
  // that SUCCEEDED and found nothing keeps returning [] — an empty store is
  // an answer. Reads resume every iteration: an awaited provider may still
  // land after a successful-but-empty early read.
  let sawSuccessfulRead = false;
  let found: OAuthProviderId[] = [];
  for (;;) {
    let read: OAuthProviderId[] | null = null;
    try {
      read = await snapshot(profileDir);
    } catch {
      read = null;
    }
    if (read !== null) {
      sawSuccessfulRead = true;
      found = read;
    }
    const satisfied =
      sawSuccessfulRead &&
      (awaited.length === 0 ? found.length > 0 : awaited.every((id) => found.includes(id)));
    if (satisfied || Date.now() >= deadline) return sawSuccessfulRead ? found : null;
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
// Public import surface stays here so existing callers do not move.
// The predicate lives in display-env.ts so browser-process-owner can
// ask it without forming a runtime cycle with this login module.
export { hasDisplay } from "./display-env.js";

// Where the ceremony browser ACTUALLY went, named by the path that placed it
// — the screen the person running connect is at, a display only the noVNC URL
// reaches, or nowhere showable at all. Nobody predicts this from their own
// environment before a browser exists.
export type CeremonyBrowserPlacement =
  | { kind: "host_screen"; display?: string }
  // A display nobody is sitting at, so it carries the address that reaches it.
  // The placement is reported the moment the browser lands, while the tunnel is
  // up and the run is still waiting — which is exactly when a caller needs to
  // hand that address to a person.
  | { kind: "virtual"; url: string }
  | { kind: "unreachable"; reason: string };

// Open the bot's visible Chrome at `url` and run `pollUntilDone` until it
// resolves true, the deadline passes, or the browser/status check fails.
//
// There is exactly ONE launch path: a tab in the broker's shared browser. The
// broker owns the Turnstile-safe launch (self-launched Chrome + connectOverCDP)
// and hands tabs out from it, so the ceremony and every operator session share
// the same Chrome, the same profile, and the same cookies. Nothing in this
// product launches a browser of its own. Nothing drives the user's sign-in:
// completion is the account claim `connect` polls out of band; the
// nonce-scoped Finish callback only lets the page close itself early.
export interface RunInBotChromeOpts {
  profileDir: string;
  url: string;
  deadline: number;
  // Returns true once the ceremony has completed. Re-polled every ~3s. It
  // takes no BrowserContext on purpose: completion is out of band (the
  // install claim `connect` polls), never a read off the live page.
  pollUntilDone: () => Promise<boolean>;
  onVncFinish?: () => Promise<void>;
  // Short label shown after the local Chrome window opens.
  bannerLabel: string;
  // The install flow has a sign-in phase; the claim ends it and the Finish
  // control only closes the page early. Resolve this lazily so its heartbeat
  // describes the current phase.
  heartbeatMessage?: string | (() => string);
  // Called once by the path that placed the browser, with where it landed.
  // The ceremony never launches its own Chrome, so `ownBrowserPid` is always
  // null here: the broker's browser belongs to the broker.
  onBrowserPlacement?: (placement: CeremonyBrowserPlacement, ownBrowserPid: number | null) => void;
  // Called when the noVNC rig's own lifetime expires — the wedged/never-polled
  // ceremony the rig bound exists for. That path tears the rig down and exits
  // the process, so it never returns through the caller's reporting frame and
  // the caller reports here instead.
  onCeremonyExpired?: (ownBrowserPid: number | null) => void;
  // Deferred --force-relogin clears: `clearProviderCookies` busy-failed
  // because the broker's browser holds the profile, so the old provider
  // sessions are signed out through the ceremony's own tab.
  forceReloginProviders?: readonly OAuthProviderId[];
}

const LOGIN_BROWSER_CLOSED_ERROR =
  "the login browser closed before the session completed — re-run the command after closing any other Trusty Squire session";
const LOGIN_STATUS_CHECK_STALLED_ERROR =
  "the login status check stopped responding before the session completed";

// The install-confirm ceremony: a tab in the shared broker browser, always.
// The broker is the only thing that owns a browser, so the ceremony never has
// to win the profile against one. A real screen wins INSIDE that Chrome:
// `ownedHeadedBrowserEnvironment` launches it on the host display whenever the
// daemon can see one. A daemon that inherited no DISPLAY (over SSH, from a
// user service) parked its Chrome on a private Xvfb before this connect ever
// ran; it keeps its noVNC exposure, because nothing here can move a live
// Chrome between X displays and the profile it holds is the one the ceremony
// needs.
export async function runInBotChrome(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  return await runCeremonyInSharedBroker(opts);
}

export interface LoginRunResult {
  status: "satisfied" | "timeout";
  closeState: ProfileCloseState;
}

// The ceremony has to land where the PERSON RUNNING CONNECT can see it, and
// that is the only question this answers. The broker's own environment does
// not decide: its Chrome may sit on the machine's screen while connect runs
// over SSH, or on a private Xvfb while connect runs at the desk. So the tab
// counts as visible only when the holder is on the machine's own screen AND
// this connect is at that machine; every other display gets noVNC — the same
// x11vnc + websockify + tunnel stack the standalone remote login uses.
// Discovery prefers the tracked launch display, then the browser process
// tree's environment (/proc on Linux); the helpers this call spawns are reaped
// at the ceremony's lease boundary and never touch the display or the browser
// itself.
//
// The result names WHY there is no noVNC exposure, because the ceremony
// must treat the states differently (round-12 review-3): "unshowable"
// means the tab provably cannot be shown to anyone (no discoverable
// display, or the noVNC attach failed) and the ceremony fails immediately
// instead of silently polling to its deadline; "already_visible" means the
// person running connect is already looking at the screen the tab is on.
// Neither failure path ever touches the display or the browser.
export type SharedCeremonyExposure =
  | { kind: "exposed"; url: string; stop: () => Promise<void> }
  | { kind: "already_visible"; reason: string }
  | { kind: "unshowable"; reason: string };

export async function exposeSharedBrokerCeremonyDisplay(
  profileDir: string,
  onExpired?: (ownBrowserPid: number | null) => void,
  onVncFinish?: () => Promise<void>,
): Promise<SharedCeremonyExposure> {
  const holder = holderCeremonyDisplay(profileDir);
  // Nothing to name. Where windows are drawn natively there is no X display to
  // discover and no rig this repo could have made, so the tab is on the screen
  // in front of whoever ran connect; anywhere else, an unnamed display is one
  // nothing here can show, and saying otherwise burns the deadline in silence.
  if (holder.kind === "unnamed")
    return drawsWindowsNatively()
      ? { kind: "already_visible", reason: "this machine draws its windows natively" }
      : { kind: "unshowable", reason: holder.reason };
  if (!holder.owned && hasDisplay())
    return {
      kind: "already_visible",
      reason: "it runs on this machine's own screen, which you are signed in at",
    };
  if (holder.authFile === null)
    return {
      kind: "unshowable",
      reason:
        "the browser holding the profile runs on a display with no XAUTHORITY in its launch " +
        "record or process tree, so nothing here can authorize a noVNC attach to it",
    };
  const authFile = holder.authFile;
  let rig: RemoteLoginRig | undefined;
  try {
    rig = createRemoteLoginRig();
    // FRESH VNC secrets of our own — createRemoteLoginSecrets would also mint
    // an Xauthority, but the display's authorization belongs to the broker's
    // Xvfb.
    createRemoteLoginVncSecrets(rig);
    rig.display = holder.display;
    rig.authFile = authFile;
  } catch (err) {
    if (rig !== undefined) await teardownRemoteLoginRig(rig).catch(() => undefined);
    return {
      kind: "unshowable",
      reason: `preparing the noVNC rig failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const exposureRig = rig;
  const removeCleanup = registerRemoteLoginRigCleanup(exposureRig, () => undefined, {
    onExpired: () => onExpired?.(null),
  });
  let url: string;
  try {
    url = await exposeRemoteLoginDisplay(rig, onVncFinish);
  } catch (err) {
    removeCleanup();
    await teardownRemoteLoginRig(rig).catch(() => undefined);
    return {
      kind: "unshowable",
      reason: `the noVNC attach failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return {
    kind: "exposed",
    url,
    stop: async () => {
      // Helpers only: the display and the browser belong to the broker daemon.
      removeCleanup();
      await teardownRemoteLoginRig(exposureRig);
    },
  };
}

// Where the browser holding the profile is drawing, read off that browser and
// nothing else. Discovery prefers the tracked launch record and falls back to
// the holder's process tree. `owned` says the display is a login rig this repo
// created, which is hidden until noVNC attaches to it.
type HolderCeremonyDisplay =
  | { kind: "named"; display: string; authFile: string | null; owned: boolean }
  | { kind: "unnamed"; reason: string };

function holderCeremonyDisplay(profileDir: string): HolderCeremonyDisplay {
  const holderPid = currentProfileHolderPid(profileDir);
  if (holderPid === null)
    return {
      kind: "unnamed",
      reason: "no live browser process holds the profile, so its display could not be discovered",
    };
  const tracked = ownerTrackedBrowserDisplay(profileDir, holderPid);
  const env = tracked === null ? readProcessTreeDisplay(holderPid) : null;
  const display = tracked?.display ?? env?.DISPLAY;
  const authFile = tracked?.authFile ?? env?.XAUTHORITY;
  if (display === undefined)
    return {
      kind: "unnamed",
      reason:
        "the browser holding the profile runs without a DISPLAY in its launch record or process tree",
    };
  // The rig's private-dir name is the ownership proof, tracked launch record
  // or not. A host XAUTHORITY (not a tsq-login- dir) is the machine's own
  // screen, and so is NO XAUTHORITY at all: every rig this repo starts sets
  // both vars, so a display missing one is provably not one of ours.
  return {
    kind: "named",
    display,
    authFile: authFile ?? null,
    owned: authFile !== undefined && isOwnedLoginRigXauthority(authFile),
  };
}

// The ownership signal for any holder display, tracked launch record or not:
// rigs this repo creates live in private dirs named `tsq-login-*`. The dir's
// PARENT is deliberately not compared against this process's temp root — the
// broker daemon and connect are different processes and may run under different
// TMPDIRs, and rejecting the broker's own rig on that difference strands a
// headless user with no noVNC URL until the deadline.
function isOwnedLoginRigXauthority(authFile: string): boolean {
  return basename(dirname(authFile)).startsWith("tsq-login-");
}

// Chrome can erase the main process's launch environment while crashpad and
// other descendants retain it. Inspect all threads' children (not just the main
// thread), then their descendants; process exits during discovery are ordinary.
function readProcessTreeDisplay(holderPid: number): NodeJS.ProcessEnv | null {
  const pending = [holderPid];
  const seen = new Set<number>();
  // A DISPLAY with no XAUTHORITY beside it is the host's own screen — several
  // display managers never export one — so it answers the question, but keep
  // looking for a descendant carrying both before settling for it.
  let displayOnly: NodeJS.ProcessEnv | null = null;
  for (const pid of pending) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const env = readProcessEnvironment(pid);
    if (env?.DISPLAY !== undefined && env.XAUTHORITY !== undefined) return env;
    if (env?.DISPLAY !== undefined) displayOnly ??= env;
    try {
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        try {
          const children = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
          pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
        } catch {
          // Thread exited during discovery.
        }
      }
    } catch {
      // Process exited, or /proc is unavailable.
    }
  }
  return displayOnly;
}

// Linux's exec-time environment is NUL-separated; other platforms have no
// equivalent. Missing reads leave discovery to the other available records.
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

// The accessible name of the confirm control on GitHub's logout page.
const GITHUB_SIGN_OUT_CONTROL_NAME = "Sign out";

// Whether to print the shared-browser disclosure, returned as the sentence to
// print. It earns a line in exactly ONE case: the ceremony tab is on a real
// human-facing screen, in the browser the person running connect is already
// using — the same browser every later Trusty Squire session opens tabs in, so
// from here on agent work shares a browser with their own browsing. Every
// other case is false or moot: on a headless display every other tab belongs
// to the same owner, acting for the same account, on a link handed to
// themselves, so nothing is disclosed. `null` means print nothing at all —
// there is deliberately no shortened or softened variant.
export function sharedBrowserDisclosureWarning(exposure: SharedCeremonyExposure): string | null {
  if (exposure.kind !== "already_visible") return null;
  return "Trusty Squire will keep opening tabs in this browser — the one you're using.";
}

async function operateCommand(
  client: BrokerClient,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // The daemon's OperatorBroker.command parses every operator schema, which
  // REQUIRES args.session_id, and refuses a mismatched one with stale_lease —
  // it does not inject the id for us. The reply is the CommandResult envelope
  // `{ result: <tool payload> }`, the same wire the MCP forwarder rides: send
  // the id inside args and unwrap the envelope.
  const reply = (await client.call("command", {
    sessionId,
    name,
    args: { ...args, session_id: sessionId },
  })) as { result?: unknown } | undefined;
  return reply?.result;
}

// A deferred --force-relogin clear runs through the very tab the ceremony
// opened: ordinary operator verbs (navigate +, for GitHub, an observe-then-
// click of its one confirm control) inside the shared browser — no second
// Chrome, no profile custody. Best-effort by design: a provider that is
// already signed out has nothing to clear (its logout page 404s or renders
// without the button), and a failed clear must not block the fresh sign-in
// the user asked for.
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
        // operate_click only accepts a ref a prior observation minted — a
        // bare text selector never resolves (stale_ref). Observe the logout
        // page, find the Sign out control in the returned action map, and
        // click its ref. The wanted alias comes from the same function that
        // MINTS the observation's labels, so this never drifts from the
        // `@slug` shape they actually carry (a disambiguating ordinal makes
        // it `@sign-out-2`, hence the prefix match).
        let signedOut = false;
        try {
          const observed = (await operateCommand(client, sessionId, "operate_observe", {})) as {
            safe_table?: unknown[];
          };
          // The wire's control rows are positional tuples `[ref, role, facts?]`
          // (compact-observation-v2 wireControl): the role is a wire letter
          // (b=button, l=link, …) and the facts are a `|`-joined list whose
          // FIRST element is the `@label` alias the observation minted. Decode
          // that shape here — object rows never travel this wire.
          const wanted = controlLabelV2(GITHUB_SIGN_OUT_CONTROL_NAME);
          const signOut = (observed?.safe_table ?? []).find((row) => {
            if (!Array.isArray(row)) return false;
            const [ref, roleWire, facts] = row as [unknown, unknown, unknown];
            const role = wireRoleToSafeRoleV2(String(roleWire));
            const label = typeof facts === "string" ? facts.split("|")[0]! : "";
            return (
              typeof ref === "string" &&
              (role === "button" || role === "link") &&
              wanted !== undefined &&
              label.toLowerCase().startsWith(wanted)
            );
          });
          if (signOut !== undefined) {
            await operateCommand(client, sessionId, "operate_click", {
              ref: (signOut as [string, unknown, unknown?])[0],
            });
            signedOut = true;
          }
        } catch {
          signedOut = false;
        }
        if (!signedOut) {
          console.error(
            `[login] GitHub's logout page did not show a Sign out control in the shared ` +
              `browser — it may already be signed out. Continuing.`,
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
 * Chrome. A `ceremony` open is identity-neutral by construction: when the
 * shared browser is already live under some identity (for example a proxied
 * operator session), the ceremony reuses it instead of requesting a bare
 * one — a bare request would be refused `incompatible_runtime` while other
 * sessions are live, or would recycle the shared Chrome underneath them
 * when none are.
 *
 * The broker is reached with nothing: connecting takes no credential and the
 * ceremony open names no account, because enrollment CREATES an account
 * rather than acting as one. A machine with no enrolled account — exactly the
 * machine that is being enrolled — therefore gets the shared browser, and the
 * connect-or-launch path starts the daemon when none is resident (the daemon
 * itself requires no enrollment). An identified resident's refusal (an
 * unreclaimed pid, a handshake timeout, a profile held elsewhere) propagates
 * verbatim, naming the process that holds it.
 */
export async function runCeremonyInSharedBroker(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  const session = await createSessionGuard().bind();
  const socket = resolveBrokerSocket(opts.profileDir);
  const connectOptions = {
    ...(session?.account_id === undefined ? {} : { accountId: session.account_id }),
    ...(session?.agent_session_token === undefined
      ? {}
      : { agentSessionToken: session.agent_session_token }),
  };
  let client: BrokerClient;
  try {
    client = await connectOrLaunchBroker(socket, connectOptions);
  } catch (err) {
    // Nothing left to fall back to: the broker is the only path that owns a
    // browser. An identified resident's refusal (a broker still serving
    // clients, an unreclaimed pid, a handshake timeout) names the resident
    // process and the recovery step, and swallowing it would replace that
    // message with a generic "another Trusty Squire session is already using
    // the browser".
    throw err;
  }
  let sessionId: string | undefined;
  let stopExposure: (() => Promise<void>) | null | undefined;
  try {
    const open = (await client.call("open", {
      serviceUrl: opts.url,
      // The ceremony IS what creates the live Google session. Keep its open
      // explicitly marked so it can never be mistaken for a Google-dependent
      // operator action. The same flag adopts the browser's live identity —
      // see OpenRequest.
      ceremony: true,
    })) as { sessionId?: string; observation?: unknown };
    sessionId = open.sessionId;
    if (sessionId === undefined) {
      // The broker minted no live session AND no tab. Nothing in this run
      // can show, navigate, or recover that state — the old behavior polled
      // to the deadline against something no code path could change (the
      // round-12 review-1 deadlock). Fail immediately with the broker's own
      // words and the recovery step.
      const detail = openHandbackDetail(open.observation);
      throw new Error(
        `[login] The shared browser opened no ceremony tab (the broker minted no live session).` +
          (detail !== "" ? ` ${detail}` : "") +
          ` Nothing in this run can show or navigate the page, so waiting out the deadline ` +
          `would only burn it. Re-run \`npx @trusty-squire/mcp connect\`; if it repeats, ` +
          `check the broker log at ~/.trusty-squire/.trusty-squire-broker-leases/launch/broker.log.`,
      );
    }
    if (opts.forceReloginProviders?.length) {
      await logoutProvidersThroughSession(client, sessionId, opts.url, opts.forceReloginProviders);
    }
    // Headless: the broker's Chrome is on a private Xvfb until this process
    // exposes that display over noVNC. A machine with a screen already sees
    // the tab (already_visible). A tab no human can see is a tab no human
    // can complete — and when it provably cannot be shown, waiting out the
    // deadline would only burn it (round-12 review-3): fail now.
    const exposure = await exposeSharedBrokerCeremonyDisplay(
      opts.profileDir,
      opts.onCeremonyExpired,
      opts.onVncFinish,
    );
    if (exposure.kind === "unshowable") {
      opts.onBrowserPlacement?.({ kind: "unreachable", reason: exposure.reason }, null);
      throw new Error(
        `\n[login] The install page opened as a tab in the shared browser's private ` +
          `display, which nothing here can show: ${exposure.reason}. Without a display ` +
          `nobody can see or complete the sign-in, so this run stops instead of waiting ` +
          `out its deadline. Recovery: install the noVNC helpers (x11vnc, websockify, ` +
          `cloudflared — or set TS_LOGIN_PUBLIC_HOSTNAME and TS_LOGIN_LOCAL_PORT to use ` +
          `your own tunnel) and run connect again.\n`,
      );
    }
    opts.onBrowserPlacement?.(
      exposure.kind === "already_visible"
        ? { kind: "host_screen" }
        : { kind: "virtual", url: exposure.url },
      null,
    );
    // Only a real human-facing display that is already showing the person this
    // browser — the one later sessions keep opening tabs in — earns the
    // disclosure. The headless noVNC path prints nothing: its banner already
    // carries the URL, and the tabs behind that URL are the same owner's.
    if (exposure.kind === "already_visible") {
      console.error(
        `\n[login] The install page opened as a tab in the shared browser's display ` +
          `(${exposure.reason}) — complete the sign-in on that screen.\n`,
      );
      const warning = sharedBrowserDisclosureWarning(exposure);
      if (warning !== null) console.error(`${warning}\n`);
    }
    stopExposure = exposure.kind === "exposed" ? exposure.stop : null;
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

// Pull one human-readable line out of a needs-user hand-back observation so
// the console message names what the broker actually asked for, not just that
// it asked.
function openHandbackDetail(observation: unknown): string {
  if (observation === null || typeof observation !== "object") return "";
  const record = observation as Record<string, unknown>;
  for (const key of ["guidance", "hint", "url"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return `${key}: ${value}`;
  }
  return "";
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
    // Returns claimed only after the install ceremony succeeds. Completion is
    // the account claim the caller polls; `wizardCompleted` carries the
    // browser's courtesy Finish callback, which may close the page early but
    // is never required (a single-use ceremony page can be unreachable).
    pollUntilClaimed: (wizardCompleted: boolean) => Promise<InstallClaimPollResult>;
    profileDir?: string;
    // Absolute local deadline (ms). The caller owns it because only the
    // caller knows what the ceremony is waiting on.
    deadline: number;
    // Phase-aware terminal copy supplied by connect.
    heartbeatMessage?: string | (() => string);
    // Where the ceremony browser landed, from the path that placed it.
    onBrowserPlacement?: (
      placement: CeremonyBrowserPlacement,
      ownBrowserPid: number | null,
    ) => void;
    // The ceremony's noVNC rig hit its own lifetime and is exiting the
    // process; the caller reports that outcome from here, with the ceremony
    // Chrome this run launched when there is one.
    onCeremonyExpired?: (ownBrowserPid: number | null) => void;
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
  const deadline = opts.deadline;
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
      onVncFinish: async () => {
        const callback = completion?.callbackUrl;
        if (!callback) throw new Error("install completion listener is unavailable");
        const response = await fetch(callback, {
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        });
        if (response.status !== 302) throw new Error("install completion callback was refused");
      },
      ...(opts.heartbeatMessage !== undefined ? { heartbeatMessage: opts.heartbeatMessage } : {}),
      ...(opts.onBrowserPlacement !== undefined
        ? { onBrowserPlacement: opts.onBrowserPlacement }
        : {}),
      ...(opts.onCeremonyExpired !== undefined
        ? { onCeremonyExpired: opts.onCeremonyExpired }
        : {}),
      ...(opts.forceReloginProviders?.length
        ? { forceReloginProviders: opts.forceReloginProviders }
        : {}),
    });
    if (result.status === "satisfied") {
      return { status: "claimed" };
    }
    return { status: "timeout", detail: "no install completed before the deadline" };
  } catch (err) {
    // A refusal that names another session holding the browser — the profile
    // gate's, or an identified resident broker's — is the caller's own typed
    // condition, and connect reports it as a holder. Flattening either to a
    // string turned "another browser has the profile" into "a sign-in is
    // outstanding", and sent the caller to claim the install elsewhere.
    if (err instanceof ProfileBusyError || err instanceof BrokerRefusal) throw err;
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
