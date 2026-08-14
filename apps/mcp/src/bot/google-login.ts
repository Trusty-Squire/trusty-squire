// google-login.ts — Phase 1, T2 (/plan-eng-review).
//
// Ensures the bot's persistent Chrome profile holds a valid Google
// session. This is the one-time interactive login; every signup after
// it is fully automated.
//
// TWO PATHS, by environment — deliberately just two (decided after the
// 2026-05-17 spike). Tailscale and Codespaces/Replit-native forwarding
// were considered and dropped: they add environment-detection code for
// a minority of users, and the cloudflared tunnel covers everyone.
//
//   1. A display is available → launch Chrome headed. A window opens,
//      the user logs in. No virtual display, no noVNC, no tunnel.
//
//   2. Headless (no DISPLAY) → run Chrome on a phone-shaped virtual
//      display (Xvfb), bridge it out with x11vnc + noVNC + a cloudflared
//      tunnel, and print one URL + a VNC password. The user logs in from
//      any browser on any network. The per-session stack and public URL
//      are removed when the flow completes, times out, errors, or is
//      interrupted; an operator-managed named tunnel remains external.
//
// Binaries the headless path needs: Xvfb, x11vnc, websockify
// (with /usr/share/novnc), cloudflared, and Google Chrome. Missing ones
// produce a clear, actionable error rather than a cryptic crash.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import boxen from "boxen";
import chalk from "chalk";
import { shortenVncUrl } from "../api-client.js";
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
  isSelfManagedChromeTerminationSignalExitEnabled,
  launchPlainLoginBrowser,
  launchSelfManagedLoginContext,
  resolveChannelBinary,
  selfLaunchEnabled,
  setSelfManagedChromeTerminationSignalExitEnabled,
} from "./browser.js";
export { extractGoogleAccountEmail } from "./browser.js";
import {
  startInstallCompletionListener,
  withInstallCompletionCallback,
} from "./install-completion.js";
import { markProviderLoggedIn } from "./login-state.js";
import { randomBytes } from "node:crypto";
import type { BrowserContext } from "playwright";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  canPublishOperatorProfileSeed,
  GOOGLE_LOGIN_COOKIE_MARKERS,
  publishOperatorProfileSeed,
  type OperatorSeedGoogleValidation,
} from "./operator-profile-pool.js";

const require = createRequire(import.meta.url);

// Route the INTERACTIVE login through the same proxy the bot uses, so the
// provider session is established from the bot's egress IP. Without this,
// GitHub/Google create the session from the box's (datacenter) IP, then the
// proxied bot run hits the provider from a residential IP — the big IP jump
// trips the provider's security and silently kills the session. That is the
// "logged-in marker lies" failure: the marker records a login whose auth
// cookie the provider already invalidated. Honors UNIVERSAL_BOT_PROXY_URL;
// unset (the default for end users) → direct, no change.
export type LoginProxyDisposition = {
  server: string;
  username?: string;
  password?: string;
} | null;

function loginProxyOption(): Exclude<LoginProxyDisposition, null> | undefined {
  const raw = process.env.UNIVERSAL_BOT_PROXY_URL;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.hostname.length === 0) return undefined;
    const opt: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username.length > 0) opt.username = decodeURIComponent(u.username);
    if (u.password.length > 0) opt.password = decodeURIComponent(u.password);
    return opt;
  } catch {
    return undefined;
  }
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
// Phone-shaped virtual display — portrait so it scales cleanly onto a
// phone via noVNC (the spike's 1920x1080 was the UX mistake). 720x1280
// is the smallest size that doesn't look pixel-y on a 1080p+ phone
// screen, and stays bandwidth-friendly compared to 1080x1920.
// Overridable via BOT_NOVNC_W/H — a desktop-width display (e.g. 1440x900) is
// needed when the remote page is a responsive app whose desktop-only controls
// (hover-revealed row menus in the Workspace Admin console) collapse at phone
// width. Defaults stay phone-shaped for the common login-from-phone case.
const HEADLESS_W = Number(process.env.BOT_NOVNC_W) || 720;
const HEADLESS_H = Number(process.env.BOT_NOVNC_H) || 1280;

// The Debian/Ubuntu `novnc` package installs its web assets here — the
// `core/` RFB library our branded page reuses (see runHeadlessChrome).
const NOVNC_INSTALL_DIR = "/usr/share/novnc";

// Resolve a bundled login asset (the branded vnc.html / interstitial).
// `../../assets/login/` from this module resolves to apps/mcp/assets/
// whether running from src/ (tsx) or dist/ (compiled) — assets/ sits
// beside both. Shipped via the package.json `files` allowlist.
function loginAssetPath(name: string): string {
  return fileURLToPath(new URL(`../../assets/login/${name}`, import.meta.url));
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
// it never closes the noVNC on the bare API claim while the interactive sign-in
// (e.g. Google's cold-profile second challenge) is still in flight.
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
export function hasDisplay(): boolean {
  if (process.env.TRUSTY_SQUIRE_FORCE_HEADLESS === "true") return false;
  if (process.env.TRUSTY_SQUIRE_FORCE_DISPLAY === "true") return true;
  // macOS (Aqua) and Windows (Win32) have native windowing — Chrome
  // opens a real window without an X server. DISPLAY is a Unix concept
  // they don't set, so a DISPLAY-only check would have wrongly routed
  // every Mac/Windows install into the headless+noVNC+cloudflared rig
  // (which needs Xvfb/x11vnc/etc. that aren't installed on those
  // platforms).
  if (process.platform === "darwin" || process.platform === "win32") return true;
  // Linux: a non-empty DISPLAY means there's an X server we can draw to.
  // Headless boxes often inherit an automation/Xvfb DISPLAY over SSH, though;
  // that is NOT a human-visible desktop. Prefer noVNC for SSH/TTY Linux
  // sessions unless explicitly overridden with TRUSTY_SQUIRE_FORCE_DISPLAY.
  if (
    process.env.SSH_CONNECTION !== undefined ||
    process.env.SSH_TTY !== undefined ||
    process.env.XDG_SESSION_TYPE === "tty"
  ) {
    return false;
  }
  return typeof process.env.DISPLAY === "string" && process.env.DISPLAY.length > 0;
}

// First :N (99..120) whose X socket is free.
function pickFreeDisplay(): string {
  for (let n = 99; n <= 120; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`;
  }
  throw new Error("no free X display number in :99..:120");
}

// An OS-assigned free TCP port.
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not resolve a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

// Standard install locations probed IN ADDITION to $PATH. A binary can be
// installed yet invisible to `binaryOnPath` when the process that spawned
// this one trimmed PATH — systemd units and agent/MCP spawns routinely drop
// /usr/local/bin, which is exactly where cloudflared lands. Probing the
// well-known dirs stops an installed binary from being reported "missing".
const STANDARD_BIN_DIRS = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
] as const;

// Is `bin` an executable on PATH (or in a standard bin dir)? A cheap
// synchronous `command -v` that also probes well-known locations so an
// installed-but-off-PATH binary isn't misreported as absent.
export function binaryOnPath(bin: string): boolean {
  const dirs = [...(process.env.PATH ?? "").split(":"), ...STANDARD_BIN_DIRS];
  return dirs.some((p) => p.length > 0 && existsSync(join(p, bin)));
}

// cloudflared's .deb is published per-arch; pick the suffix matching this
// machine so the suggested install command actually resolves.
function cloudflaredDebArch(): string {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    case "ia32":
      return "386";
    default:
      return "amd64";
  }
}

// Correct remediation for the specific binaries that are missing. cloudflared
// is NOT in Debian/Ubuntu's default repos, so an apt-get line can never
// install it — it needs Cloudflare's own package. The rest are plain apt
// packages (websockify's noVNC assets ship in the `novnc` package, so both).
export function installHint(missing: readonly string[]): string {
  const aptPkgs = missing.flatMap((n) => {
    if (n === "Xvfb") return ["xvfb"];
    if (n === "x11vnc") return ["x11vnc"];
    if (n === "websockify") return ["novnc", "websockify"];
    return [];
  });
  const lines: string[] = [];
  if (aptPkgs.length > 0) {
    lines.push(`On Debian/Ubuntu: sudo apt-get install -y ${aptPkgs.join(" ")}`);
  }
  if (missing.includes("cloudflared")) {
    const arch = cloudflaredDebArch();
    lines.push(
      "cloudflared is not in Debian/Ubuntu repos — install its package: " +
        `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb ` +
        "-o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb",
    );
  }
  return lines.join("\n");
}

function requireBinaries(names: readonly string[]): void {
  const missing = names.filter((n) => !binaryOnPath(n));
  if (missing.length > 0) {
    throw new Error(
      `headless login needs these not-installed binaries: ${missing.join(", ")}.\n` +
        installHint(missing),
    );
  }
}

// --- path 2: headless — virtual display + noVNC + cloudflared ----------
export interface HeadlessRig {
  procs: ChildProcess[];
  display: string;
  // Temp dir websockify serves (branded vnc.html + the installed
  // noVNC core). Removed on teardown.
  webDir?: string;
  // G14 — 0600 file holding the VNC password. x11vnc reads it via
  // `-passwdfile rm:…` (and self-removes), so the secret never appears
  // on the process command line where `ps` could read it. Tracked here
  // as a belt-and-suspenders unlink in case x11vnc never started.
  passFile?: string;
}

function spawnBg(cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
  });
  child.on("error", (e) => console.error(`[login] ${cmd} failed to spawn: ${String(e)}`));
  return child;
}

// Read cloudflared's output until it prints its public trycloudflare URL.
// Accumulates a rolling buffer rather than matching per-chunk — the URL
// can straddle two `data` events, and a per-chunk match would miss it
// and hang until the timeout.
function awaitTunnelUrl(cf: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("cloudflared did not produce a URL in time")),
      timeoutMs,
    );
    let acc = "";
    const scan = (buf: Buffer): void => {
      acc += buf.toString();
      const m = acc.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[0]);
      }
      // Bound memory if cloudflared is chatty before the URL appears.
      if (acc.length > 65536) acc = acc.slice(-4096);
    };
    cf.stdout?.on("data", scan);
    cf.stderr?.on("data", scan);
  });
}

// Width-aware, boxed VNC banner. Replaces the old hardcoded
// `"=".repeat(64)` lines that looked broken on narrow phone-via-SSH
// terminals and lost on wide ones. boxen handles the reflow.
function printBanner(opts: { tunnelUrl: string; vncPassword: string; label: string }): void {
  const width = Math.max(40, Math.min((process.stdout.columns ?? 80) - 2, 78));
  // OSC 8 hyperlink: modern terminals render the URL as cmd-clickable
  // (label = the URL itself so it still copies cleanly). Non-TTY
  // pipes get the raw URL — no escape garbage in logs. Wine-underlined
  // text inside the OSC 8 wrapper preserves a visual cue on terminals
  // that ignore the hyperlink escape.
  const styledUrl = process.stderr.isTTY
    ? `\x1b]8;;${opts.tunnelUrl}\x1b\\${chalk.hex("#cf3a52").underline(opts.tunnelUrl)}\x1b]8;;\x1b\\`
    : opts.tunnelUrl;
  const body =
    `Open this on any device, any network:\n\n` +
    `  ${styledUrl}\n\n` +
    `If asked for a VNC password:  ${chalk.bold(opts.vncPassword)}\n\n` +
    opts.label;
  console.error(
    "\n" +
      boxen(body, {
        title: "Sign in to Trusty Squire",
        titleAlignment: "left",
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: "single",
        borderColor: "#cf3a52",
        width,
      }) +
      "\n",
  );
}

const headlessRigTeardowns = new WeakMap<HeadlessRig, Promise<void>>();

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}

function removeHeadlessRigFiles(rig: HeadlessRig): void {
  if (rig.webDir !== undefined) {
    try {
      rmSync(rig.webDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  if (rig.passFile !== undefined) {
    try {
      rmSync(rig.passFile, { force: true });
    } catch {
      // best-effort
    }
  }
}

function releaseChildHandles(child: ChildProcess): void {
  try {
    child.stdout?.destroy();
  } catch {
    // best-effort
  }
  try {
    child.stderr?.destroy();
  } catch {
    // best-effort
  }
  try {
    child.unref();
  } catch {
    // best-effort
  }
}

function forceTeardownHeadlessRig(rig: HeadlessRig): void {
  for (const child of rig.procs) {
    try {
      if (!childHasExited(child)) child.kill("SIGKILL");
    } catch {
      // best-effort
    }
    releaseChildHandles(child);
  }
  removeHeadlessRigFiles(rig);
}

export function teardownHeadlessRig(rig: HeadlessRig, graceMs = 1_000): Promise<void> {
  const existing = headlessRigTeardowns.get(rig);
  if (existing !== undefined) return existing;
  const teardown = (async (): Promise<void> => {
    const running = rig.procs.filter((child) => !childHasExited(child));
    for (const child of running) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    await Promise.all(running.map((child) => waitForChildExit(child, graceMs)));
    const resistant = running.filter((child) => !childHasExited(child));
    for (const child of resistant) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }
    await Promise.all(resistant.map((child) => waitForChildExit(child, graceMs)));
    for (const child of rig.procs) releaseChildHandles(child);
    removeHeadlessRigFiles(rig);
  })();
  headlessRigTeardowns.set(rig, teardown);
  return teardown;
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

// Exported for tests; runDisplayedChrome/runHeadlessChrome are the real
// callers. Returns the unregister disposer for the normal completion path.
export function trackActiveLoginBrowser(cancel: () => Promise<void>): () => void {
  activeLoginBrowserCancels.add(cancel);
  return (): void => {
    activeLoginBrowserCancels.delete(cancel);
  };
}

// Cancel every in-flight login run's browser (and headless rig, where one
// exists). Called by the MCP server's shutdown path; idempotent and
// best-effort — a failed teardown must not stall the process exit, whose
// process-level exit hooks still force-kill anything identity-proven.
export async function cancelActiveLoginBrowsers(): Promise<void> {
  const pending = [...activeLoginBrowserCancels];
  activeLoginBrowserCancels.clear();
  await Promise.all(pending.map((cancel) => cancel().catch(() => undefined)));
}

type LoginProcessRuntime = Pick<NodeJS.Process, "once" | "removeListener" | "exit">;

// How registerHeadlessRigCleanup coordinates exit ownership with browser.ts's
// self-managed Chrome signal handlers. Injectable for tests; the default is
// the real process-wide flag.
export interface LoginSignalExitCoordination {
  enabled(): boolean;
  set(enabled: boolean): void;
}

const selfManagedSignalExitCoordination: LoginSignalExitCoordination = {
  enabled: isSelfManagedChromeTerminationSignalExitEnabled,
  set: setSelfManagedChromeTerminationSignalExitEnabled,
};

// Attach the per-login rig to every process termination route. The function
// returns a disposer for the normal completion path; callers must keep the
// browser teardown in the getter so an interrupt can also release the Chrome
// profile lock before Node exits. The hard cap prevents a wedged browser from
// keeping Xvfb/x11vnc/websockify (or cloudflared) alive indefinitely.
//
// Exit ownership is coordinated through `signalExit`, one owner at a time:
// - When self-managed signal exits are ENABLED (the CLI default), this login
//   takes sole ownership for its duration — it suspends browser.ts's
//   SIGKILL-and-exit handlers (which would otherwise preempt the capped
//   graceful teardown below on the same signal) and restores them on
//   disposal. The always-on `exit` hooks (here for the rig, browser.ts's for
//   identity-proven Chromes) stay as the force-kill backstop.
// - When they are DISABLED, a central shutdown coordinator (the MCP server's
//   requestShutdown) already owns process exit and drains this login via
//   cancelActiveLoginBrowsers(); installing exit-calling signal or
//   uncaughtException handlers here would race it (and would violate the
//   server's log-and-keep-serving process guards), so only the pure-cleanup
//   `exit` hook is registered.
export function registerHeadlessRigCleanup(
  rig: HeadlessRig,
  activeBrowserTeardown: () => (() => Promise<void>) | undefined,
  runtime: LoginProcessRuntime = process,
  signalExit: LoginSignalExitCoordination = selfManagedSignalExitCoordination,
): () => void {
  let finishing = false;

  const teardownBrowserWithin = async (): Promise<void> => {
    const closeBrowser = activeBrowserTeardown();
    if (closeBrowser === undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      void closeBrowser()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  };

  const exitAfterCleanup = (code: number): void => {
    if (finishing) {
      forceTeardownHeadlessRig(rig);
      runtime.exit(code);
      return;
    }
    finishing = true;
    void teardownBrowserWithin().finally(async () => {
      await teardownHeadlessRig(rig);
      runtime.exit(code);
    });
  };

  const onExit = (): void => forceTeardownHeadlessRig(rig);
  const onSigterm = (): void => exitAfterCleanup(143);
  const onSigint = (): void => exitAfterCleanup(130);
  const onUncaughtException = (error: Error): void => {
    console.error("[login] uncaught exception; tearing down the login browser", error);
    exitAfterCleanup(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    console.error("[login] unhandled rejection; tearing down the login browser", reason);
    exitAfterCleanup(1);
  };

  runtime.once("exit", onExit);
  const ownsTerminationExit = signalExit.enabled();
  if (ownsTerminationExit) {
    signalExit.set(false);
    runtime.once("SIGTERM", onSigterm);
    runtime.once("SIGINT", onSigint);
    runtime.once("uncaughtException", onUncaughtException);
    runtime.once("unhandledRejection", onUnhandledRejection);
  }

  return (): void => {
    runtime.removeListener("exit", onExit);
    if (!ownsTerminationExit) return;
    runtime.removeListener("SIGTERM", onSigterm);
    runtime.removeListener("SIGINT", onSigint);
    runtime.removeListener("uncaughtException", onUncaughtException);
    runtime.removeListener("unhandledRejection", onUnhandledRejection);
    signalExit.set(true);
  };
}

export function fallbackCloudflaredArgs(webPort: number): string[] {
  return ["tunnel", "--protocol", "http2", "--url", `http://127.0.0.1:${webPort}`];
}

// Assemble the directory websockify serves: a copy of the installed
// noVNC web assets (for the `core/` RFB library) with our branded
// vnc.html written over the stock one. A temp dir, NOT the package's
// own assets/ — under `npx` the package runs from a read-only cache,
// so the noVNC core cannot be copied into it. Torn down with the rig.
function buildVncWebDir(): string {
  const webDir = mkdtempSync(join(tmpdir(), "ts-novnc-"));
  cpSync(NOVNC_INSTALL_DIR, webDir, { recursive: true });
  // The branded page imports `./core/rfb.js`. If the distro's novnc
  // package put its core somewhere else, fail loudly here rather than
  // serving a page that 404s its own script and shows a blank screen.
  if (!existsSync(join(webDir, "core", "rfb.js"))) {
    rmSync(webDir, { recursive: true, force: true });
    throw new Error(
      `noVNC core not found at ${NOVNC_INSTALL_DIR}/core/rfb.js — the ` +
        `installed novnc package has an unexpected layout`,
    );
  }
  const branded = readFileSync(loginAssetPath("vnc.html"), "utf8");
  writeFileSync(join(webDir, "vnc.html"), branded);
  // Also write index.html so the URL printed to the user's terminal can
  // drop `/vnc.html` — every saved character matters on a phone, where
  // line-wrapping the URL across two terminal lines makes copy/paste
  // hostile. websockify's static server returns index.html for `/`.
  writeFileSync(join(webDir, "index.html"), branded);
  return webDir;
}

// Open the bot's Chrome at `url`, on whichever platform path applies
// (with-display or headless+noVNC+cloudflared), and run `pollUntilDone`
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
  // Optional: short label used in the headless VNC banner so the user
  // knows what they're being asked to do in the remote Chrome window.
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
  // G15: API base URL used to shorten the cloudflared tunnel URL
  // before printing it in the headless banner. When undefined, the
  // long cloudflared URL is printed verbatim. The headless path is
  // the only consumer; the display path skips the banner entirely.
  apiBaseUrl?: string;
  // The install flow has a sign-in phase followed by an explicit Finish
  // step. Resolve this lazily so its heartbeat describes the current phase.
  heartbeatMessage?: string | (() => string);
  // PLAIN-BROWSER MODE (connect claim). When set, the login browser is launched
  // as plain Chrome with NO CDP attach — required because Google's OAuth
  // "secure browser" check rejects a CDP-attached Chrome (see
  // launchPlainLoginBrowser). In this mode the browser is never driven: the
  // user signs in over noVNC, and completion is detected via `plainPollUntilDone`
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
  validateGoogleSeed?: (profileDir: string) => Promise<OperatorSeedGoogleValidation>;
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
}

export async function finalizeLoginRun(
  opts: Pick<
    RunInBotChromeOpts,
    "profileDir" | "onConfirmedLogin" | "seedProvider" | "validateGoogleSeed"
  >,
  result: LoginRunResult,
  publishSeed: typeof publishOperatorProfileSeed = publishOperatorProfileSeed,
): Promise<void> {
  if (result.status === "completed" || result.status === "preflight_satisfied") {
    await opts.onConfirmedLogin?.();
  }
  const provider =
    typeof opts.seedProvider === "function" ? opts.seedProvider() : (opts.seedProvider ?? null);
  const proof = { loginStatus: result.status, closeState: result.closeState, provider };
  if (canPublishOperatorProfileSeed(proof) && opts.validateGoogleSeed !== undefined) {
    await publishSeed(opts.profileDir, {
      proof,
      validateGoogleIdentity: opts.validateGoogleSeed,
    });
  }
}

export async function validateGoogleProfileSession(
  profileDir: string,
  proxyDisposition: LoginProxyDisposition,
  launcher: PersistentLauncher = resolveChromium(),
  closeValidationBrowser: typeof teardownLoginBrowser = teardownLoginBrowser,
): Promise<OperatorSeedGoogleValidation> {
  const context = await launchWithProfileGate(profileDir, () =>
    launchPersistentLoginContext(launcher, profileDir, {
      headless: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(proxyDisposition !== null ? { proxy: proxyDisposition } : {}),
    }),
  );
  const holderPid = currentProfileHolderPid(profileDir);
  const identity = holderPid === null ? null : profileProcessIdentity(holderPid, profileDir);
  let googleSignedIn = false;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://myaccount.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    googleSignedIn = new URL(page.url()).hostname === "myaccount.google.com";
  } catch {
    googleSignedIn = false;
  }
  const closeState = await closeValidationBrowser({
    profileDir,
    identity,
    closeBrowser: () => context.close(),
    forceClose: () => reapProfileHolderIfOwned(profileDir, identity),
  });
  return { googleSignedIn, closeState };
}

async function runInBotChromeWithProfileGuard(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  // `mcp login` runs in a SEPARATE process from the MCP server, so the
  // in-process OAuth mutex can't serialize it against an in-flight signup.
  // Chrome's SingletonLock is the cross-process semaphore: reclaim a stale
  // holder, but fail immediately for a live one. Waiting here used to leave a
  // second connect apparently frozen while a duplicate noVNC stack accumulated.
  const free = await waitForProfileFree(opts.profileDir, {
    deadlineMs: 0,
  });
  if (!free) {
    throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
  }
  if (hasDisplay()) {
    return await runDisplayedChrome(opts);
  }
  return await runHeadlessChrome(opts);
}

async function runDisplayedChrome(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  // PLAIN-BROWSER path (connect claim): launch plain Chrome, never attach CDP,
  // detect completion off the API + SQLite cookie store. See
  // launchPlainLoginBrowser / RunInBotChromeOpts.plainProfileLogin.
  if (opts.plainProfileLogin === true) {
    if (opts.plainPollUntilDone === undefined) {
      throw new Error("plainProfileLogin set without plainPollUntilDone");
    }
    const binary = resolveChannelBinary("chrome");
    if (binary === null) {
      throw new Error("no Chrome binary found for the plain login browser");
    }
    const proxyOpt = loginProxyOption();
    const proxyDisposition =
      proxyOpt !== undefined && proxyOpt.password === undefined
        ? selfLaunchProxyDisposition(proxyOpt)
        : null;
    opts.onProxyDisposition?.(proxyDisposition);
    const browser = await launchPlainLoginBrowser({
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
    let status: LoginRunResult["status"] = "timeout";
    let closeState: ProfileCloseState = "unknown";
    // Memoized so the normal finally and an external shutdown cancel share
    // one proof-checked teardown instead of racing two.
    let browserTeardown: Promise<ProfileCloseState> | undefined;
    const teardownBrowser = (): Promise<ProfileCloseState> => {
      browserTeardown ??= teardownLoginBrowser({
        profileDir: opts.profileDir,
        identity: browser.identity,
        closeBrowser: browser.teardown,
        forceClose: browser.forceTeardown,
      });
      return browserTeardown;
    };
    const untrackLoginRun = trackActiveLoginBrowser(async () => {
      await teardownBrowser();
    });
    try {
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
      untrackLoginRun();
      closeState = await teardownBrowser();
    }
    return { status, closeState };
  }
  const chromium = resolveChromium();
  const proxyOpt = loginProxyOption();
  opts.onProxyDisposition?.(proxyOpt ?? null);
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
  let status: LoginRunResult["status"] = "timeout";
  let closeState: ProfileCloseState = "unknown";
  let browserTeardown: Promise<ProfileCloseState> | undefined;
  const teardownBrowser = (): Promise<ProfileCloseState> => {
    browserTeardown ??= teardownLoginBrowser({
      profileDir: opts.profileDir,
      identity,
      closeBrowser: () => context.close(),
      forceClose: () => reapProfileHolderIfOwned(opts.profileDir, identity),
    });
    return browserTeardown;
  };
  const untrackLoginRun = trackActiveLoginBrowser(async () => {
    await teardownBrowser();
  });
  try {
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
  } finally {
    untrackLoginRun();
    closeState = await teardownBrowser();
  }
  return { status, closeState };
}

async function runHeadlessChrome(opts: RunInBotChromeOpts): Promise<LoginRunResult> {
  requireBinaries(["Xvfb", "x11vnc", "websockify", "cloudflared"]);
  if (!existsSync("/usr/share/novnc")) {
    throw new Error("noVNC web assets not found at /usr/share/novnc — install the `novnc` package");
  }

  // G16 — named-tunnel mode. When the operator has set up a dedicated
  // Cloudflare named tunnel pointing at a fixed local port, opt in via
  // env. The bot then:
  //   - binds websockify to that fixed local port (so the pre-configured
  //     tunnel's ingress finds it)
  //   - skips the per-session `cloudflared tunnel --url` spawn (the
  //     named tunnel runs as a systemd service outside this process)
  //   - prints the short branded URL instead of the long random one
  // Both env vars must be set; absence (default) keeps the existing
  // random `*.trycloudflare.com` flow.
  const namedTunnelHost = process.env.TS_LOGIN_PUBLIC_HOSTNAME;
  const namedTunnelPortStr = process.env.TS_LOGIN_LOCAL_PORT;
  const usingNamedTunnel =
    namedTunnelHost !== undefined &&
    namedTunnelHost.length > 0 &&
    namedTunnelPortStr !== undefined &&
    namedTunnelPortStr.length > 0;
  const display = pickFreeDisplay();
  const vncPort = await findFreePort();
  const webPort = usingNamedTunnel ? Number(namedTunnelPortStr) : await findFreePort();
  if (usingNamedTunnel && (!Number.isFinite(webPort) || webPort <= 0)) {
    throw new Error(
      `TS_LOGIN_LOCAL_PORT=${JSON.stringify(namedTunnelPortStr)} is not a valid port number`,
    );
  }
  const vncPassword = randomBytes(4).toString("hex"); // 8 chars — VNC's limit
  const rig: HeadlessRig = { procs: [], display };
  // Teardown for the login browser — for the self-launch path this ALSO kills
  // the spawned Chrome child (a bare context.close() over CDP leaves it
  // running), for the persistent fallback it's just context.close(). Tracked
  // so the signal handler can release the profile lock before exiting.
  let activeTeardown: (() => Promise<void>) | undefined;
  let plainBrowserIsRunning: (() => boolean) | undefined;

  // Cover normal cleanup, interrupts, and fatal process errors. The returned
  // disposer removes process-global listeners once this login finishes.
  const removeRigCleanup = registerHeadlessRigCleanup(rig, () => activeTeardown);
  // Register for external shutdown BEFORE the Chrome launch so the whole
  // starting phase is cancellable: a cancel mid-launch still tears the rig,
  // and once activeTeardown exists it closes the bootstrap Chrome through its
  // identity-proven teardown.
  const untrackLoginRun = trackActiveLoginBrowser(async () => {
    const closeBrowser = activeTeardown;
    if (closeBrowser !== undefined) await closeBrowser().catch(() => undefined);
    await teardownHeadlessRig(rig);
  });

  try {
    // 1. Virtual display — phone-shaped.
    rig.procs.push(
      spawnBg("Xvfb", [display, "-screen", "0", `${HEADLESS_W}x${HEADLESS_H}x24`, "-ac"]),
    );
    await new Promise((r) => setTimeout(r, 1500));

    // 2. Chrome on that display, persistent profile, window filling the display.
    //    Self-launch + connectOverCDP is the STATE.md 2026-06-12 launcher fix:
    //    a launchPersistentContext-driven Chrome carries the launch-time
    //    instrumentation anti-bot (Cloudflare Turnstile, and — the bug this
    //    ports the fix for — Google's sign-in device-prompt) reads as a bot,
    //    while a self-launched Chrome attached over CDP does not. The signup
    //    path (BrowserController) already migrated; the connect login was the
    //    last consumer of the detectable launcher. Fall back to the old
    //    launcher when self-launch is opted out (BOT_SELF_LAUNCH=0), Chrome
    //    isn't resolvable as a real binary, or a credentialed proxy is set
    //    (self-launch's --proxy-server can't carry proxy auth).
    const proxyOpt = loginProxyOption();
    const chromeBinary = resolveChannelBinary("chrome");
    const useSelfLaunch =
      selfLaunchEnabled() &&
      chromeBinary !== null &&
      (proxyOpt === undefined || proxyOpt.password === undefined);
    const sharedChromeArgs = [
      "--disable-blink-features=AutomationControlled",
      // --test-type suppresses the "unsupported command-line flag:
      // --no-sandbox" yellow infobar that otherwise eats the top strip of the
      // phone-shaped framebuffer once handed to noVNC. Standard automation
      // flag; doesn't affect OAuth/cookies.
      "--test-type",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ] as const;
    // PLAIN-BROWSER mode (connect claim): NO CDP at all — a CDP-attached Chrome
    // fails Google's OAuth "secure browser" check (STATE.md 2026-07-20, fully
    // bisected). `context` stays undefined; completion is read via
    // plainPollUntilDone (API + on-disk cookies), never a live context.
    const plain = opts.plainProfileLogin === true;
    let context: BrowserContext | undefined;
    let teardownContext: () => Promise<void>;
    let forceTeardownContext: () => void;
    let profileIdentity: ProfileProcessIdentity | null = null;
    if (plain) {
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
        window: { width: HEADLESS_W, height: HEADLESS_H },
        env: { ...process.env, DISPLAY: display },
        proxyServer: proxyDisposition?.server ?? null,
        extraArgs: sharedChromeArgs,
      });
      teardownContext = browser.teardown;
      forceTeardownContext = browser.forceTeardown;
      plainBrowserIsRunning = browser.isRunning;
      profileIdentity = browser.identity;
    } else if (useSelfLaunch && chromeBinary !== null) {
      const proxyDisposition = selfLaunchProxyDisposition(proxyOpt);
      opts.onProxyDisposition?.(proxyDisposition);
      const launched = await launchSelfManagedLoginContext({
        binary: chromeBinary,
        profileDir: opts.profileDir,
        // App mode (--app) strips tabs/URL bar so the install page gets the
        // full phone-shaped framebuffer under noVNC.
        initialUrl: opts.url,
        appMode: true,
        window: { width: HEADLESS_W, height: HEADLESS_H },
        env: { ...process.env, DISPLAY: display },
        proxyServer: proxyDisposition?.server ?? null,
        extraArgs: sharedChromeArgs,
      });
      context = launched.context;
      teardownContext = launched.teardown;
      forceTeardownContext = launched.forceTeardown;
      profileIdentity = launched.identity;
    } else {
      const chromium = resolveChromium();
      opts.onProxyDisposition?.(proxyOpt ?? null);
      const persistent = await launchWithProfileGate(
        opts.profileDir,
        () =>
          launchPersistentLoginContext(chromium, opts.profileDir, {
            headless: false,
            viewport: null, // use the real window size
            env: { ...process.env, DISPLAY: display },
            // Drop --enable-automation: kills the "controlled by automated test
            // software" infobar and the matching automation fingerprint.
            ignoreDefaultArgs: ["--enable-automation"],
            ...(proxyOpt !== undefined ? { proxy: proxyOpt } : {}),
            args: [
              `--window-position=0,0`,
              `--window-size=${HEADLESS_W},${HEADLESS_H}`,
              `--app=${opts.url}`,
              ...sharedChromeArgs,
            ],
          }),
        { failFast: true },
      );
      context = persistent;
      const persistentPid = currentProfileHolderPid(opts.profileDir);
      const persistentIdentity =
        persistentPid === null ? null : profileProcessIdentity(persistentPid, opts.profileDir);
      teardownContext = async (): Promise<void> => {
        await persistent.close();
      };
      forceTeardownContext = (): void => {
        reapProfileHolderIfOwned(opts.profileDir, persistentIdentity);
      };
      profileIdentity = persistentIdentity;
    }
    let browserTeardown: Promise<ProfileCloseState> | undefined;
    const teardownBrowser = (): Promise<ProfileCloseState> => {
      browserTeardown ??= teardownLoginBrowser({
        profileDir: opts.profileDir,
        identity: profileIdentity,
        closeBrowser: teardownContext,
        forceClose: forceTeardownContext,
      });
      return browserTeardown;
    };
    activeTeardown = async () => {
      await teardownBrowser();
    };
    try {
      // CDP path only: preflight + drive the first page to the URL. The plain
      // path has no context — plain Chrome's --app already opened opts.url.
      if (context !== undefined) {
        if (
          opts.preflight !== undefined &&
          (await checkLoginStatusWithin(opts.deadline, () => opts.preflight!(context)))
        ) {
          const closeState = await teardownBrowser();
          return { status: "preflight_satisfied", closeState };
        }
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(opts.url, { waitUntil: "domcontentloaded" });
      }

      // 3. x11vnc on the display — localhost-only, password-gated, -noshm
      //    (the box's X server lacks the shared-memory extension).
      //    G14 — pass the password via a 0600 file, NOT `-passwd <plain>`
      //    on argv (which any `ps` could read). `rm:` makes x11vnc unlink
      //    the file right after reading it.
      const passFile = join(tmpdir(), `tsq-vnc-${process.pid}-${vncPort}.pass`);
      writeFileSync(passFile, vncPassword, { mode: 0o600 });
      chmodSync(passFile, 0o600); // writeFileSync's mode is honored only on create
      rig.passFile = passFile;
      rig.procs.push(
        spawnBg("x11vnc", [
          "-display",
          display,
          "-rfbport",
          String(vncPort),
          "-passwdfile",
          `rm:${passFile}`,
          "-localhost",
          "-forever",
          "-shared",
          "-noshm",
          "-quiet",
        ]),
      );
      await new Promise((r) => setTimeout(r, 1500));

      // 4. noVNC web bridge — serves our branded vnc.html plus the
      //    installed noVNC core from a temp dir; localhost only,
      //    cloudflared reaches it.
      rig.webDir = buildVncWebDir();
      rig.procs.push(
        spawnBg("websockify", [
          `--web=${rig.webDir}`,
          `127.0.0.1:${webPort}`,
          `localhost:${vncPort}`,
        ]),
      );
      await new Promise((r) => setTimeout(r, 1500));

      // 5. Outbound tunnel.
      //
      // G16 named-tunnel mode (env-gated): the operator pre-provisioned
      // a dedicated cloudflared tunnel pointed at our fixed webPort
      // (running as a systemd service outside this process). No per-
      // session cloudflared spawn — saves ~5-10s of cold-start, and
      // the URL is short + branded (vnc.trustysquire.ai instead of
      // shouts-clean-mediawiki-cookies.trycloudflare.com).
      //
      // Random-tunnel fallback (default): spawn a fresh trycloudflare
      // tunnel per session. Works everywhere, no operator setup, but
      // the URL is ~80 chars and the cold-start hurts.
      let bannerUrl: string;
      if (usingNamedTunnel) {
        // The persistent operator-managed named tunnel lives outside this
        // process; run that service with `--protocol http2` too, avoiding the
        // same QUIC datagram-manager drops as the per-session fallback.
        // No `/vnc.html` — websockify serves the same content as
        // index.html (buildVncWebDir writes both). Shorter URL fits
        // one line on a phone terminal.
        bannerUrl = `https://${namedTunnelHost}/#p=${vncPassword}`;
      } else {
        const cf = spawnBg("cloudflared", fallbackCloudflaredArgs(webPort));
        rig.procs.push(cf);
        const tunnelUrl = await awaitTunnelUrl(cf, 30000);
        const longVncUrl = `${tunnelUrl}/#p=${vncPassword}`;

        // G15 (deprecated by G16): shorten the cloudflared URL through
        // the API when we have an API base — much less transcription-
        // hostile on a phone than the raw cloudflared subdomain. Still
        // used on the random-tunnel fallback path; the named-tunnel
        // path doesn't need it (URL is already short).
        bannerUrl = longVncUrl;
        if (opts.apiBaseUrl !== undefined) {
          bannerUrl = await shortenVncUrl(opts.apiBaseUrl, longVncUrl);
        }
      }

      // The VNC password rides in the URL *fragment* (#), not the query
      // string — a fragment is never sent to the server, so it stays
      // out of the cloudflared edge logs and any proxy in between. The
      // branded vnc.html reads it from location.hash and connects with
      // no prompt.
      printBanner({
        tunnelUrl: bannerUrl,
        vncPassword,
        label: opts.bannerLabel,
      });

      // 6. Wait for the side effect, run the success hook against the
      //    live context (e.g. inspect cookies that the user's sign-in
      //    set — opening a second context after teardown is racy and
      //    silently fails on profile lock), then tear the whole stack
      //    down.
      const ok = await pollUntil(
        opts.deadline,
        () =>
          context !== undefined
            ? opts.pollUntilDone(context)
            : opts.plainPollUntilDone!(opts.profileDir),
        opts.heartbeatMessage,
        () => {
          if (plainBrowserIsRunning !== undefined && !plainBrowserIsRunning()) {
            throw new Error(LOGIN_BROWSER_CLOSED_ERROR);
          }
        },
      );
      if (ok) {
        if (context !== undefined) {
          if (opts.onSuccess !== undefined) {
            try {
              await opts.onSuccess(context);
            } catch {
              /* swallow */
            }
          }
        } else if (opts.plainOnSuccess !== undefined) {
          try {
            await opts.plainOnSuccess(opts.profileDir);
          } catch {
            /* swallow */
          }
        }
      }
      const closeState = await teardownBrowser();
      return { status: ok ? "completed" : "timeout", closeState };
    } finally {
      // Idempotent (self-launch teardown guards with a `torn` flag; the
      // persistent fallback's close() is .catch-wrapped), so the success-path
      // call above and this finally can both fire safely.
      await teardownBrowser();
      // Torn down — the signal handler must not double-tear it.
      activeTeardown = undefined;
    }
  } finally {
    untrackLoginRun();
    await teardownHeadlessRig(rig);
    removeRigCleanup();
  }
}

// Shared timed-poll helper. `check` is invoked every 3s until it
// resolves true or the deadline passes.
// Emits a heartbeat to stderr every ~20s while waiting. After the noVNC banner
// (or the Chrome window) opens, this loop is otherwise silent for up to the full
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
  apiBaseUrl?: string;
  // 0.8.3-rc.1 — skip the preflight session-cookie check so the
  // browser opens even when a valid session is already cached. Used
  // by `login --force-relogin` to surface the noVNC URL on a
  // headless box and let the operator interactively clear a provider
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
  let proxyDisposition: LoginProxyDisposition = null;

  try {
    const result = await runInBotChrome({
      profileDir,
      url: target.loginUrl,
      deadline,
      bannerLabel: `You'll see a Chrome window — log into your ${target.label} account.`,
      // When forceOpen is true, the preflight ALSO clears the
      // provider's session cookies before returning false. Without
      // this the noVNC opens but pollUntilDone immediately sees the
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
            // the operator hit Sign Out manually in the noVNC.
          }
          return false;
        }
        return hasProviderSession(ctx, target);
      },
      pollUntilDone: (ctx) => hasProviderSession(ctx, target),
      onProxyDisposition: (proxy) => {
        proxyDisposition = proxy;
      },
      onConfirmedLogin: async () => markProviderLoggedIn(provider, profileDir),
      seedProvider: provider,
      validateGoogleSeed: (validationProfile) =>
        validateGoogleProfileSession(validationProfile, proxyDisposition),
      ...(opts?.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
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
    // G15: API base URL used to shorten the headless cloudflared
    // tunnel URL before printing it in the banner. Same value the
    // install handshake calls against; threaded down to the rig.
    apiBaseUrl?: string;
    // Phase-aware terminal copy supplied by connect.
    heartbeatMessage?: string | (() => string);
  },
  runChrome: typeof runInBotChrome = runInBotChrome,
  validateGoogleSeed: typeof validateGoogleProfileSession = validateGoogleProfileSession,
): Promise<{
  status: "claimed" | "timeout" | "error";
  detail?: string;
}> {
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let completion: Awaited<ReturnType<typeof startInstallCompletionListener>> | undefined;
  let observedGoogleIdentity = false;
  let proxyDisposition: LoginProxyDisposition = null;
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
      ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
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
      onProxyDisposition: (proxy) => {
        proxyDisposition = proxy;
      },
      seedProvider: () => (observedGoogleIdentity ? "google" : null),
      validateGoogleSeed: (validationProfile) =>
        validateGoogleSeed(validationProfile, proxyDisposition),
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
