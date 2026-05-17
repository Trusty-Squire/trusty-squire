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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHROME_PROFILE_DIR } from "./profile.js";
import { randomBytes } from "node:crypto";
import type { BrowserContext } from "playwright";

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
const GOOGLE_LOGIN_URL = "https://accounts.google.com/";
// Auth cookies Google only sets after a completed login.
const GOOGLE_AUTH_COOKIES = ["__Secure-1PSID", "SAPISID", "SID"];
// Phone-shaped virtual display — small and portrait so it scales cleanly
// onto a phone via noVNC (the spike's 1920x1080 was the UX mistake).
const HEADLESS_W = 540;
const HEADLESS_H = 960;

export interface LoginResult {
  status: "logged_in" | "already_valid" | "timeout" | "error";
  detail?: string;
}

// --- session detection -------------------------------------------------
async function hasGoogleSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://www.google.com");
  return cookies.some((c) => GOOGLE_AUTH_COOKIES.includes(c.name));
}

async function pollForSession(
  context: BrowserContext,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await hasGoogleSession(context)) return true;
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
): Promise<LoginResult> {
  const chromium = resolveChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    if (await hasGoogleSession(context)) {
      return { status: "already_valid" };
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded" });
    console.error("\n[login] A Chrome window has opened. Log into your Google account there.\n");
    const ok = await pollForSession(context, deadline);
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
}

async function loginHeadless(profileDir: string, deadline: number): Promise<LoginResult> {
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
  const onExit = (): void => teardown(rig);
  process.once("exit", onExit);

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
      if (await hasGoogleSession(context)) {
        return { status: "already_valid" };
      }
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded" });

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

      // 4. noVNC web bridge — localhost only; cloudflared reaches it.
      rig.procs.push(
        spawnBg("websockify", [
          "--web=/usr/share/novnc",
          `127.0.0.1:${webPort}`,
          `localhost:${vncPort}`,
        ]),
      );
      await new Promise((r) => setTimeout(r, 1500));

      // 5. Outbound tunnel — no inbound port opened, no firewall fight.
      const cf = spawnBg("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${webPort}`]);
      rig.procs.push(cf);
      const tunnelUrl = await awaitTunnelUrl(cf, 30000);

      console.error(
        "\n" + "=".repeat(64) + "\n" +
          "[login] Open this on any device, any network:\n" +
          `        ${tunnelUrl}/vnc.html?scale=true\n` +
          `[login] VNC password: ${vncPassword}\n` +
          "[login] You'll see a Chrome window — log into your Google account.\n" +
          "=".repeat(64) + "\n",
      );

      // 6. Wait for the login, then tear the whole stack down.
      const ok = await pollForSession(context, deadline);
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
  }
}

// --- public entry ------------------------------------------------------
// Ensures `profileDir` holds a valid Google session, doing whichever
// login flow the environment calls for. Returns when the session is
// present, the deadline passes, or setup fails.
export async function ensureGoogleSession(opts?: {
  profileDir?: string;
  timeoutMinutes?: number;
}): Promise<LoginResult> {
  const profileDir = opts?.profileDir ?? CHROME_PROFILE_DIR;
  const timeoutMinutes = Math.max(1, opts?.timeoutMinutes ?? 15);
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  try {
    return hasDisplay()
      ? await loginWithDisplay(profileDir, deadline)
      : await loginHeadless(profileDir, deadline);
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
