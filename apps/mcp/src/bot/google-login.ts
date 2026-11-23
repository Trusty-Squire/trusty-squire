// google-login.ts — Phase 1, T2 (/plan-eng-review).
//
// Establishes and reads the provider sessions in the bot's persistent Chrome
// profile. `connect` (install/cli.ts) is the ONLY caller that opens a login;
// every signup after it is fully automated.
//
// Connect ceremony custody, display exposure, and provider-probe contracts are
// owned by docs/browser-broker.md. The broker daemon runs the ceremony
// (broker/ceremony.ts) and completes it on server-side facts: the claim and
// the person's Finish, both read from the install `/status`.

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CHROME_PROFILE_DIR,
  currentProfileHolderPid,
  launchWithProfileGate,
  ProfileBusyError,
  profileProcessIdentity,
  waitForProfileFree,
  withProfileOperationGuard,
} from "./profile.js";
import { loadBetterSqlite3 } from "./sqlite-native.js";
import { closeBrowserContextWithin, registerLocalBrowserLaunch } from "./browser.js";
import { connectBroker, resolveBrokerSocket } from "./broker/discovery.js";
import { BrokerRefusal } from "./broker/refusal.js";
import type { CeremonyRequest, CeremonyTab, CeremonyView } from "./broker/ceremony.js";
import type { BrokerClient } from "./broker/transport.js";
import { controlLabelV2, wireRoleToSafeRoleV2 } from "./compact-observation-v2.js";
import { extractGoogleAccountEmail } from "./oauth-login.js";
export { extractGoogleAccountEmail };
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
  namedTunnelConfig,
  type NamedLoginTunnel,
  registerRemoteLoginRigCleanup,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "./remote-login-display.js";
import { drawsWindowsNatively, hasDisplay } from "./display-env.js";
import type { CeremonyDisplayClip } from "./ceremony-window.js";
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
  return (require("patchright") as { chromium: PersistentLauncher }).chromium;
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
 * a byte copy without taking the profile lease. Presence is only a hint: the
 * caller must confirm a Google marker through the shared broker before it
 * claims the session is live. The post-ceremony probe may use this snapshot
 * while waiting for Chrome to commit fresh cookies.
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
    const Database = loadBetterSqlite3();
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

/** Gmail's per-account atom feed. Google serves it ONLY to a live session:
 * signed in is HTTP 200 with a title of `Gmail - Inbox for <email>`; a stale or
 * signed-out profile gets 401 (or a redirect to the sign-in page). Unlike
 * `myaccount.google.com`, the endpoint cannot be mistaken for the signed-in
 * state by a URL read that lands before a page-script redirect: it answers
 * server-side, so the response IS the answer. */
const GMAIL_FEED_URL = "https://mail.google.com/mail/u/0/feed/atom";
const GMAIL_FEED_TITLE = /<title>\s*Gmail\s*-\s*Inbox for\s+([^<\s]+@[^<\s]+)\s*<\/title>/i;

/** The account email a Gmail atom feed proves, or null when the response is not
 * a signed-in feed. */
export function gmailFeedAccountEmail(status: number | null, body: string | null): string | null {
  if (status !== 200 || body === null) return null;
  return GMAIL_FEED_TITLE.exec(body)?.[1] ?? null;
}

/** The live-session answer a feed response proves: true signed in, false
 * definitively stale/signed out, null when the check could not be made. A
 * non-200 that is not an auth refusal (a 5xx, a redirect off the feed) is
 * unknown, never a pass and never a re-pair trigger. */
export function googleSessionFromFeed(status: number | null, body: string | null): boolean | null {
  if (status === null) return null;
  if (status === 401 || status === 403) return false;
  if (status !== 200) return null;
  return gmailFeedAccountEmail(status, body) !== null;
}

/** Check Google's server-side session through the browser that owns the
 * profile. An identity-neutral `about:blank` ceremony tab gives us the shared
 * browser and closes without affecting sibling operator tabs; the answer then
 * comes from a plain request made through that browser's own cookie jar (not a
 * rendered page, and not a navigation to Google), so a stale session that
 * merely serves `myaccount.google.com` before its page-script redirect cannot
 * be read as signed in. `null` means the check failed, never "signed out".
 */
export async function probeGoogleSessionInBroker(profileDir: string): Promise<boolean | null> {
  let client: BrokerClient | undefined;
  let sessionId: string | undefined;
  try {
    client = await connectBroker(resolveBrokerSocket(profileDir));
    const opened = (await client.call("open", {
      serviceUrl: "about:blank",
      ceremony: true,
    })) as { sessionId?: string };
    sessionId = opened.sessionId;
    if (sessionId === undefined) return null;
    const fetched = (await operateCommand(client, sessionId, "operate_fetch_text", {
      url: GMAIL_FEED_URL,
    })) as { status?: number | null; body_text?: string | null } | null;
    if (fetched === null || typeof fetched !== "object") return null;
    const status = typeof fetched.status === "number" ? fetched.status : null;
    const body = typeof fetched.body_text === "string" ? fetched.body_text : null;
    return googleSessionFromFeed(status, body);
  } catch {
    return null;
  } finally {
    if (sessionId !== undefined) await client?.call("close", { sessionId }).catch(() => undefined);
    await client?.release().catch(() => undefined);
  }
}

/** Turn a cookie snapshot into a Google-liveness answer. GitHub remains the
 * snapshot's answer; an unreadable live Google probe is unknown, never a pass.
 */
export async function confirmLiveGoogleProviderSnapshot(
  profileDir: string,
  providers: OAuthProviderId[],
  probe: typeof probeGoogleSessionInBroker = probeGoogleSessionInBroker,
): Promise<OAuthProviderId[] | null> {
  if (!providers.includes("google")) return providers;
  const live = await probe(profileDir);
  if (live === null) return null;
  return live ? providers : providers.filter((provider) => provider !== "google");
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

// The ceremony has to land where the PERSON RUNNING CONNECT can see it, and
// that is the only question this answers. The broker's own environment does
// not decide: its Chrome may sit on the machine's screen while connect runs
// over SSH, or on a private Xvfb while connect runs at the desk. So the tab
// counts as visible only when the holder is on the machine's own screen AND
// this connect is at that machine (`callerHasDisplay`, which only connect can
// answer — this runs in the broker daemon); every other display gets noVNC.
// Discovery prefers the tracked launch display, then the browser process
// tree's environment (/proc on Linux); the helpers this call spawns are the
// daemon's own children, reaped when the ceremony ends, and never touch the
// display or the browser itself.
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
  onExpired?: () => void,
  windowControl?: {
    showPhone: () => Promise<CeremonyDisplayClip>;
    restore: () => Promise<void>;
  },
  callerHasDisplay: boolean = hasDisplay(),
  namedTunnel: NamedLoginTunnel | null = namedTunnelConfig(),
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
  if (!holder.owned && callerHasDisplay)
    return {
      kind: "already_visible",
      reason: "it runs on this machine's own screen, which you are signed in at",
    };
  const authFile = holder.authFile;
  let rig: RemoteLoginRig | undefined;
  let clip: CeremonyDisplayClip | undefined;
  try {
    rig = createRemoteLoginRig(namedTunnel);
    // FRESH VNC secrets of our own — createRemoteLoginSecrets would also mint
    // an Xauthority, but the display's authorization belongs to the broker's
    // Xvfb.
    createRemoteLoginVncSecrets(rig);
    rig.display = holder.display;
    if (authFile !== null) rig.authFile = authFile;
    clip = await windowControl?.showPhone();
  } catch (err) {
    if (rig !== undefined) await teardownRemoteLoginRig(rig).catch(() => undefined);
    await windowControl?.restore().catch(() => undefined);
    return {
      kind: "unshowable",
      reason: `preparing the noVNC rig failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const exposureRig = rig;
  const removeCleanup = registerRemoteLoginRigCleanup(exposureRig, () => windowControl?.restore, {
    ...(onExpired !== undefined ? { onExpired } : {}),
  });
  let url: string;
  try {
    url = await exposeRemoteLoginDisplay(rig, clip, namedTunnel);
  } catch (err) {
    removeCleanup();
    await teardownRemoteLoginRig(rig).catch(() => undefined);
    await windowControl?.restore().catch(() => undefined);
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
      try {
        await teardownRemoteLoginRig(exposureRig);
      } finally {
        await windowControl?.restore();
      }
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
export function sharedBrowserDisclosureWarning(placement: CeremonyBrowserPlacement): string | null {
  if (placement.kind !== "host_screen") return null;
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
export async function logoutProvidersThroughSession(
  tab: Pick<CeremonyTab, "command">,
  confirmUrl: string,
  providers: readonly OAuthProviderId[],
): Promise<void> {
  for (const provider of providers) {
    try {
      await tab.command("operate_navigate", { url: PROVIDER_LOGOUT_URLS[provider] });
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
          const observed = (await tab.command("operate_observe", {})) as {
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
            await tab.command("operate_click", {
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
  // Best-effort as well: if it fails the ceremony still reports honestly.
  try {
    await tab.command("operate_navigate", { url: confirmUrl });
  } catch (err) {
    console.error(
      `[login] could not return the shared browser's tab to the confirm page ` +
        `(${err instanceof Error ? err.message : String(err)}) — open it there to continue.`,
    );
  }
}

// --- public entry ------------------------------------------------------
// Connect's half of the ceremony: ask the profile's broker daemon to start
// (or report) the sign-in, and return as soon as it answers. The daemon opens
// the confirm page in its shared Chrome, exposes the display when nobody here
// can see it, polls the install claim, writes the session, and closes the
// window when the person presses Finish. Nothing in connect waits on a human.
//
// The broker is reached with nothing: connecting takes no credential and the
// ceremony names no account, because enrollment CREATES an account rather than
// acting as one. An identified resident's refusal (an unreclaimed pid, a
// handshake timeout, a profile held elsewhere) propagates verbatim.
export async function requestBrokerCeremony(
  profileDir: string,
  request: CeremonyRequest,
): Promise<CeremonyView> {
  const client = await connectBroker(resolveBrokerSocket(profileDir), { ceremony: true });
  try {
    return (await client.call("ceremony", request)) as CeremonyView;
  } catch (err) {
    // A broker started from a release before the daemon owned the ceremony
    // does not know the method. It keeps running its old code until its next
    // service start, so name that instead of a generic failure.
    if (err instanceof BrokerRefusal && err.code === "unknown_method") {
      throw new BrokerRefusal(
        "broker_outdated",
        "The browser service running on this machine is older than this connect and cannot " +
          "host the sign-in. Restart it (Linux: `systemctl --user restart 'trusty-squire-broker*'`; " +
          "macOS: `launchctl kickstart -k gui/$(id -u)/ai.trustysquire.trusty-squire-broker`) " +
          "and run connect again",
      );
    }
    throw err;
  } finally {
    await client.release().catch(() => undefined);
  }
}
