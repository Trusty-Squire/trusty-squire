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
//      any browser on any network. The whole stack is torn down the
//      instant the session lands — the public URL lives for one login.
//
// Binaries the headless path needs: Xvfb, x11vnc, websockify
// (with /usr/share/novnc), cloudflared, and Google Chrome. Missing ones
// produce a clear, actionable error rather than a cryptic crash.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import boxen from "boxen";
import chalk from "chalk";
import { shortenVncUrl } from "../api-client.js";
import { CHROME_PROFILE_DIR } from "./profile.js";
import { markProviderLoggedIn } from "./login-state.js";
import { randomBytes } from "node:crypto";
import type { BrowserContext } from "playwright";
import type { OAuthProviderId } from "./oauth-providers.js";

const require = createRequire(import.meta.url);

// --- stealth chromium (mirrors BrowserController) ----------------------
interface PersistentLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<BrowserContext>;
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
    cookies: ["__Secure-1PSID", "SAPISID", "SID"],
  },
  github: {
    provider: "github",
    label: "GitHub",
    loginUrl: "https://github.com/login",
    cookieOrigin: "https://github.com",
    cookies: ["user_session", "__Host-user_session_same_site"],
  },
};
// Phone-shaped virtual display — small and portrait so it scales cleanly
// onto a phone via noVNC (the spike's 1920x1080 was the UX mistake).
const HEADLESS_W = 540;
const HEADLESS_H = 960;

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
async function hasProviderSession(
  context: BrowserContext,
  target: LoginTarget,
): Promise<boolean> {
  const cookies = await context.cookies(target.cookieOrigin);
  return cookies.some((c) => target.cookies.includes(c.name));
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
    (text.includes("to continue to") &&
      (text.includes("allow") || text.includes("continue")))
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
    if (scopes.length > 0 || depth > 4) return;
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

// --- environment helpers ----------------------------------------------
export function hasDisplay(): boolean {
  if (process.env.TRUSTY_SQUIRE_FORCE_HEADLESS === "true") return false;
  // macOS (Aqua) and Windows (Win32) have native windowing — Chrome
  // opens a real window without an X server. DISPLAY is a Unix concept
  // they don't set, so a DISPLAY-only check would have wrongly routed
  // every Mac/Windows install into the headless+noVNC+cloudflared rig
  // (which needs Xvfb/x11vnc/etc. that aren't installed on those
  // platforms).
  if (process.platform === "darwin" || process.platform === "win32") return true;
  // Linux: a non-empty DISPLAY means there's an X server we can draw to.
  // Headless boxes (Hetzner, Codespaces, Docker, SSH) won't have it
  // and fall through to the noVNC path.
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

function requireBinaries(names: readonly string[]): void {
  const missing = names.filter((n) => !binaryOnPath(n));
  if (missing.length > 0) {
    throw new Error(
      `headless login needs these not-installed binaries: ${missing.join(", ")}. ` +
        `On Debian/Ubuntu: sudo apt-get install -y xvfb x11vnc novnc websockify`,
    );
  }
}

// Is `bin` an executable on PATH? A cheap synchronous `command -v`.
export function binaryOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p.length > 0 && existsSync(join(p, bin)));
}

// --- path 2: headless — virtual display + noVNC + cloudflared ----------
interface HeadlessRig {
  procs: ChildProcess[];
  display: string;
  // Temp dir websockify serves (branded vnc.html + the installed
  // noVNC core). Removed on teardown.
  webDir?: string;
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
    const timer = setTimeout(() => reject(new Error("cloudflared did not produce a URL in time")), timeoutMs);
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
  const body =
    `Open this on any device, any network:\n\n` +
    `  ${chalk.cyan.underline(opts.tunnelUrl)}\n\n` +
    `If asked for a VNC password:  ${chalk.bold(opts.vncPassword)}\n\n` +
    opts.label;
  console.error(
    "\n" +
      boxen(body, {
        title: "Sign in with Trusty Squire",
        titleAlignment: "left",
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: "cyan",
        width,
      }) +
      "\n",
  );
}

function teardown(rig: HeadlessRig): void {
  for (const p of rig.procs) {
    try { p.kill("SIGTERM"); } catch { /* best-effort */ }
    // SIGTERM is the polite request; the child may take a moment to
    // exit. Meanwhile the parent's stdio pipes to the child keep
    // Node's event loop alive — destroy them so Node can exit even
    // if the child is mid-shutdown. unref() tells Node "this child
    // doesn't count toward keeping the process alive."
    try { p.stdout?.destroy(); } catch { /* best-effort */ }
    try { p.stderr?.destroy(); } catch { /* best-effort */ }
    try { p.unref(); } catch { /* best-effort */ }
  }
  if (rig.webDir !== undefined) {
    try {
      rmSync(rig.webDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
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
  writeFileSync(
    join(webDir, "vnc.html"),
    readFileSync(loginAssetPath("vnc.html"), "utf8"),
  );
  return webDir;
}

// Open the bot's Chrome at `url`, on whichever platform path applies
// (with-display or headless+noVNC+cloudflared), and run `pollUntilDone`
// against the live context until it resolves true OR the deadline
// passes. Returns whether the poll succeeded.
//
// Extracted so both `mcp login` (poll for Google/GitHub cookies in the
// bot's profile) AND `install` (poll the API for the install claim)
// share the same browser-launch infrastructure — one Chrome instance,
// one Google login event for both use cases.
interface RunInBotChromeOpts {
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
}

async function runInBotChrome(
  opts: RunInBotChromeOpts,
): Promise<{ status: "completed" | "preflight_satisfied" | "timeout" }> {
  if (hasDisplay()) {
    return await runDisplayedChrome(opts);
  }
  return await runHeadlessChrome(opts);
}

async function runDisplayedChrome(
  opts: RunInBotChromeOpts,
): Promise<{ status: "completed" | "preflight_satisfied" | "timeout" }> {
  const chromium = resolveChromium();
  const context = await chromium.launchPersistentContext(opts.profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    if (opts.preflight !== undefined && await opts.preflight(context)) {
      return { status: "preflight_satisfied" };
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    console.error(
      `\n[login] A Chrome window has opened. ${opts.bannerLabel}\n`,
    );
    const ok = await pollUntil(opts.deadline, () => opts.pollUntilDone(context));
    if (ok && opts.onSuccess !== undefined) {
      // Best-effort: a hook failure must not pretend the user's login
      // didn't happen. They did the work; the caller will read the
      // session marker (or not) on the next signup.
      try { await opts.onSuccess(context); } catch { /* swallow */ }
    }
    return { status: ok ? "completed" : "timeout" };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function runHeadlessChrome(
  opts: RunInBotChromeOpts,
): Promise<{ status: "completed" | "preflight_satisfied" | "timeout" }> {
  requireBinaries(["Xvfb", "x11vnc", "websockify", "cloudflared"]);
  if (!existsSync("/usr/share/novnc")) {
    throw new Error("noVNC web assets not found at /usr/share/novnc — install the `novnc` package");
  }

  const display = pickFreeDisplay();
  const vncPort = await findFreePort();
  const webPort = await findFreePort();
  const vncPassword = randomBytes(4).toString("hex"); // 8 chars — VNC's limit
  const rig: HeadlessRig = { procs: [], display };
  // The persistent Chrome context is NOT a member of `rig` — it is a
  // Playwright handle, closed via context.close(). Tracked here so the
  // signal handler can release the profile lock before exiting.
  let activeContext: BrowserContext | undefined;

  // Ensure nothing is orphaned if the process dies mid-flow. `exit`
  // covers a normal return; SIGTERM/SIGINT cover an interrupted run —
  // once a signal listener is registered the default terminate is
  // suppressed, so the handler must clean up AND exit itself.
  const onExit = (): void => teardown(rig);
  const onSignal = (): void => {
    const finish = (): void => {
      teardown(rig);
      process.exit(130);
    };
    if (activeContext !== undefined) {
      // Close the browser to release the persistent-profile lock — but
      // cap the wait: a wedged Chrome under Xvfb can hang close()
      // indefinitely, and the rig MUST still be torn down. Whichever
      // wins (clean close, or the 3s cap), `finish` runs.
      const capped = new Promise<void>((r) => setTimeout(r, 3000));
      Promise.race([activeContext.close().catch(() => undefined), capped]).then(
        finish,
        finish,
      );
    } else {
      finish();
    }
  };
  process.once("exit", onExit);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    // 1. Virtual display — phone-shaped.
    rig.procs.push(spawnBg("Xvfb", [display, "-screen", "0", `${HEADLESS_W}x${HEADLESS_H}x24`, "-ac"]));
    await new Promise((r) => setTimeout(r, 1500));

    // 2. Chrome on that display, persistent profile, window filling the display.
    const chromium = resolveChromium();
    const context = await chromium.launchPersistentContext(opts.profileDir, {
      channel: "chrome",
      headless: false,
      viewport: null, // use the real window size
      env: { ...process.env, DISPLAY: display },
      args: [
        `--window-position=0,0`,
        `--window-size=${HEADLESS_W},${HEADLESS_H}`,
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    activeContext = context;

    try {
      if (opts.preflight !== undefined && await opts.preflight(context)) {
        return { status: "preflight_satisfied" };
      }
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(opts.url, { waitUntil: "domcontentloaded" });

      // 3. x11vnc on the display — localhost-only, password-gated, -noshm
      //    (the box's X server lacks the shared-memory extension).
      rig.procs.push(
        spawnBg("x11vnc", [
          "-display", display,
          "-rfbport", String(vncPort),
          "-passwd", vncPassword,
          "-localhost", "-forever", "-shared", "-noshm", "-quiet",
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

      // 5. Outbound tunnel — no inbound port opened, no firewall fight.
      const cf = spawnBg("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${webPort}`]);
      rig.procs.push(cf);
      const tunnelUrl = await awaitTunnelUrl(cf, 30000);
      const longVncUrl = `${tunnelUrl}/vnc.html#password=${vncPassword}`;

      // G15: shorten the cloudflared URL through the API
      // (`trustysquire.ai/g/<slug>`) when we have an API base — much
      // less transcription-hostile on a phone than the raw
      // cloudflared subdomain. The shortener stores the long URL
      // verbatim (fragment included); the /g/[slug] route 302s the
      // browser to it, preserving the password fragment.
      //
      // shortenVncUrl returns the original long URL on any failure
      // path (network blip, API down), so this is never a hard
      // dependency — degrades to printing the cloudflared URL.
      let bannerUrl = longVncUrl;
      if (opts.apiBaseUrl !== undefined) {
        bannerUrl = await shortenVncUrl(opts.apiBaseUrl, longVncUrl);
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
      const ok = await pollUntil(opts.deadline, () => opts.pollUntilDone(context));
      if (ok && opts.onSuccess !== undefined) {
        try { await opts.onSuccess(context); } catch { /* swallow */ }
      }
      await context.close();
      return { status: ok ? "completed" : "timeout" };
    } finally {
      await context.close().catch(() => undefined);
      // Closed — the signal handler must not double-close it.
      activeContext = undefined;
    }
  } finally {
    teardown(rig);
    process.removeListener("exit", onExit);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

// Shared timed-poll helper. `check` is invoked every 3s until it
// resolves true or the deadline passes.
async function pollUntil(deadline: number, check: () => Promise<boolean>): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
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
      preflight: (ctx) => hasProviderSession(ctx, target),
      pollUntilDone: (ctx) => hasProviderSession(ctx, target),
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
    // A confirmed session — record it so the signup bot can auto-prefer
    // this provider's OAuth path without a probe round-trip.
    if (mapped.status === "logged_in" || mapped.status === "already_valid") {
      markProviderLoggedIn(provider, profileDir);
    }
    return mapped;
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

// Public entry for the install flow: opens the trustysquire /install
// confirm URL in the bot's persistent Chrome profile, runs the
// user-supplied check until the install is claimed (or the deadline
// passes), then tears down. The user's Google/GitHub sign-in happens
// inside this Chrome instance — so the bot's profile gets a provider
// session as a free side effect, and there's no separate "log into
// Google for the bot" step after install.
export async function openInstallConfirmInBotChrome(opts: {
  confirmUrl: string;
  // Returns true once the API has flipped the install to claimed.
  // Re-polled every 3s while Chrome is open.
  pollUntilClaimed: () => Promise<boolean>;
  profileDir?: string;
  timeoutMinutes?: number;
  // G15: API base URL used to shorten the headless cloudflared
  // tunnel URL before printing it in the banner. Same value the
  // install handshake calls against; threaded down to the rig.
  apiBaseUrl?: string;
}): Promise<{ status: "claimed" | "timeout" | "error"; detail?: string }> {
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  try {
    const result = await runInBotChrome({
      profileDir,
      url: opts.confirmUrl,
      deadline,
      bannerLabel:
        `You'll see a Chrome window with the Trusty Squire install page. ` +
        `Sign in there to connect this machine — you only sign in once.`,
      pollUntilDone: () => opts.pollUntilClaimed(),
      ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
      // The user's sign-in inside this Chrome leaves a provider session
      // in the persistent profile. We don't know WHICH provider they
      // used (Google or GitHub), so probe both cookie sets and mark
      // whichever has live cookies. Runs while the context is still
      // open — opening a second persistent context to the same profile
      // right after teardown is racy and silently fails on profile-
      // lock contention, which would leave the marker file empty and
      // make the signup bot fall back to manual on every subsequent
      // OAuth-only service.
      onSuccess: async (context) => {
        for (const provider of ["google", "github"] as const) {
          const target = LOGIN_TARGETS[provider];
          // Probe BOTH cookie origins — modern Google cookies are
          // `.google.com` domain so visible at www.google.com, but
          // some get set on accounts.google.com specifically. Checking
          // both catches the OAuth-redirect case (the user came
          // through accounts.google.com, never visited www.google.com).
          const origins = [target.cookieOrigin, "https://accounts.google.com"];
          let hit = false;
          for (const origin of origins) {
            const cookies = await context.cookies(origin);
            if (cookies.some((c) => target.cookies.includes(c.name))) {
              hit = true;
              break;
            }
          }
          if (hit) markProviderLoggedIn(provider, profileDir);
        }
      },
    });
    if (result.status === "completed") {
      return { status: "claimed" };
    }
    return { status: "timeout", detail: "no install completed before the deadline" };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
