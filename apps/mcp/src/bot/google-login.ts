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
import { CHROME_PROFILE_DIR } from "./profile.js";
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
// `core/` RFB library our branded page reuses (see loginHeadless).
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

async function pollForSession(
  context: BrowserContext,
  deadline: number,
  target: LoginTarget,
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await hasProviderSession(context, target)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
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

// --- path 1: a display is available -----------------------------------
async function loginWithDisplay(
  profileDir: string,
  deadline: number,
  target: LoginTarget,
): Promise<LoginResult> {
  const chromium = resolveChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    if (await hasProviderSession(context, target)) {
      return { status: "already_valid" };
    }
    const page = context.pages()[0] ?? (await context.newPage());
    // Show a branded interstitial first — a tool opening a browser to
    // ask for a Google/GitHub password is the scariest moment of the
    // flow; the interstitial explains it before the user is asked to
    // trust it. Best-effort: any failure falls back to going straight
    // to the provider's login page.
    try {
      const interstitial = readFileSync(loginAssetPath("interstitial.html"), "utf8")
        .split("{{PROVIDER}}").join(target.label)
        .split("{{URL}}").join(target.loginUrl);
      await page.setContent(interstitial, { waitUntil: "domcontentloaded" });
    } catch {
      await page.goto(target.loginUrl, { waitUntil: "domcontentloaded" });
    }
    console.error(
      `\n[login] A Chrome window has opened. Log into your ${target.label} account there.\n`,
    );
    const ok = await pollForSession(context, deadline, target);
    return ok
      ? { status: "logged_in" }
      : { status: "timeout", detail: "no login completed before the deadline" };
  } finally {
    await context.close();
  }
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
function awaitTunnelUrl(cf: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared did not produce a URL in time")), timeoutMs);
    const scan = (buf: Buffer): void => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    cf.stdout?.on("data", scan);
    cf.stderr?.on("data", scan);
  });
}

function teardown(rig: HeadlessRig): void {
  for (const p of rig.procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // best-effort
    }
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
  writeFileSync(
    join(webDir, "vnc.html"),
    readFileSync(loginAssetPath("vnc.html"), "utf8"),
  );
  return webDir;
}

async function loginHeadless(
  profileDir: string,
  deadline: number,
  target: LoginTarget,
): Promise<LoginResult> {
  requireBinaries(["Xvfb", "x11vnc", "websockify", "cloudflared"]);
  if (!existsSync("/usr/share/novnc")) {
    throw new Error("noVNC web assets not found at /usr/share/novnc — install the `novnc` package");
  }

  const display = pickFreeDisplay();
  const vncPort = await findFreePort();
  const webPort = await findFreePort();
  const vncPassword = randomBytes(4).toString("hex"); // 8 chars — VNC's limit
  const rig: HeadlessRig = { procs: [], display };

  // Ensure the rig is never orphaned if the process dies mid-login.
  // `exit` covers a normal return; SIGTERM/SIGINT cover an interrupted
  // run — once a signal listener is registered the default terminate
  // is suppressed, so the handler must tear down AND exit itself.
  // Folding login into `install` makes an interrupted run far more
  // likely (a backgrounded terminal, a dropped SSH session).
  const onExit = (): void => teardown(rig);
  const onSignal = (): void => {
    teardown(rig);
    process.exit(130);
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
    const context = await chromium.launchPersistentContext(profileDir, {
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

    try {
      if (await hasProviderSession(context, target)) {
        return { status: "already_valid" };
      }
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(target.loginUrl, { waitUntil: "domcontentloaded" });

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

      // The VNC password is embedded in the URL — the branded vnc.html
      // reads it and connects with no password prompt. Still printed
      // separately as a fallback for clients that strip query params.
      console.error(
        "\n" + "=".repeat(64) + "\n" +
          "[login] Open this on any device, any network:\n" +
          `        ${tunnelUrl}/vnc.html?password=${vncPassword}\n` +
          `[login] (if asked for a VNC password: ${vncPassword})\n` +
          `[login] You'll see a Chrome window — log into your ${target.label} account.\n` +
          "=".repeat(64) + "\n",
      );

      // 6. Wait for the login, then tear the whole stack down.
      const ok = await pollForSession(context, deadline, target);
      await context.close();
      return ok
        ? { status: "logged_in" }
        : { status: "timeout", detail: "no login completed before the deadline" };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    teardown(rig);
    process.removeListener("exit", onExit);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
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
}): Promise<LoginResult> {
  const target = LOGIN_TARGETS[opts?.provider ?? "google"];
  const profileDir = opts?.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts?.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  try {
    return hasDisplay()
      ? await loginWithDisplay(profileDir, deadline, target)
      : await loginHeadless(profileDir, deadline, target);
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
