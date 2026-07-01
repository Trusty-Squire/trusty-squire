// Browser automation wrapper for universal signup bot
// Provides simple interface for AI agent to control browser.
//
// Two layers of bot-resistance:
//
// 1. Stealth fingerprinting (playwright-extra + puppeteer-extra-plugin-
//    stealth). Patches ~17 client-side tells: navigator.webdriver,
//    navigator.plugins, missing chrome runtime, WebGL vendor/renderer,
//    permissions.query for notifications, etc. This handles the
//    *fingerprint* side of bot detection.
//
// 2. Human-like behavior (this file, when humanize=true). Adds bezier
//    mouse paths to clicks, variable typing delays with thinking pauses,
//    dwell time after page loads, hover-then-click hesitations. This
//    handles the *behavior* side — the bit that fingerprint spoofing
//    alone won't get past, because modern Cloudflare/reCAPTCHA scoring
//    correlates mouse-path entropy and inter-keystroke timing.
//
// Together with the user's residential IP (the bot runs on user
// machines, not on Fly), these are sufficient for invisible-mode
// Turnstile/reCAPTCHA-v3 scoring on most SaaS signups. Visible-mode
// captchas still need the click-and-wait pattern (the Tier 2 captcha
// gate).

import { chromium as baseChromium } from "playwright";
import type { Browser, BrowserContext, CDPSession, Locator, Page } from "playwright";
import { createRequire } from "node:module";
import { Socket, createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { detectAsn, type AsnClass } from "./asn.js";
import {
  CHROME_PROFILE_DIR,
  clearStaleSingletonLock,
  launchWithProfileGate,
  ProfileBusyError,
  reapLeakedProfileHolder,
  waitForProfileFree,
} from "./profile.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import type { TwoCaptchaCoordinatesResult } from "./captcha-solver-2captcha.js";
import { startXvfb, xvfbAvailable, type XvfbRig } from "./xvfb.js";

// Lazy registration: installing the plugin mutates the chromium singleton
// from playwright-extra so we only do it once per process. We require()
// the CJS modules lazily (the stealth toolchain only ships CJS) and treat
// stealth as best-effort — a missing dep should never crash the bot.
const require = createRequire(import.meta.url);

export type StealthProfile = "baseline" | "cdp_hardened";

// Whether to use the CDP-hardened launcher (patchright, which runs
// evaluations in an isolated world and removes the automation tells —
// mainWorldExecution, navigator.webdriver, viewport — that Turnstile /
// reCAPTCHA-v3 / Google's consent SPA score on). See
// docs/ARCHITECTURE.md.
//
// 2026-06-08 — DEFAULT FLIPPED ON. The baseline (playwright-extra +
// stealth) self-inflicts a detectable navigator.webdriver via its manual
// defineProperty patch, so it is strictly WORSE on the fingerprint. The
// hardened launcher is all-green on the rebrowser bot-detector and was
// live-A/B'd: meilisearch's Google consent-SPA block became a (handleable)
// FedCM path, and render still signed up + extracted a key cleanly — no
// crash on either (the old crash was the retired rebrowser fork, not
// patchright). Default to hardened; opt out with BOT_CDP_HARDENED=0 for
// the baseline. If patchright isn't installed, getChromium() falls back to
// baseline gracefully.
function cdpHardeningRequested(): boolean {
  const v = process.env.BOT_CDP_HARDENED;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

let cachedChromium: typeof baseChromium | null = null;
// The stealth profile the cached launcher actually represents. Set the
// first time getChromium() resolves a launcher and read back via
// BrowserController.stealthProfile for the CaptchaEvent A/B tag. A
// patchright load failure degrades it to "baseline" truthfully rather
// than over-claiming "cdp_hardened" on a run that never got the patch.
let activeStealthProfile: StealthProfile = "baseline";

function activeStealthProfileValue(): StealthProfile {
  return activeStealthProfile;
}

function getChromium(): typeof baseChromium {
  if (cachedChromium !== null) return cachedChromium;
  const hardened = cdpHardeningRequested();
  try {
    if (hardened) {
      // patchright — a maintained Playwright fork that runs every
      // evaluation in an ISOLATED world (so the bot's DOM probing is
      // invisible to a page that traps DOM methods → closes the
      // `mainWorldExecution` tell) and handles `navigator.webdriver`
      // natively + correctly. Verified ALL-GREEN against the maintained
      // rebrowser bot-detector (mainWorldExecution, navigatorWebdriver,
      // viewport, runtimeEnableLeak all clean). It drives real Chrome
      // (channel) directly — the earlier rebrowser fork couldn't, which is
      // why the old hardened arm was forced onto bundled chromium and then
      // crashed the OAuth flow. NO playwright-extra/stealth wrap here: the
      // stealth plugin's manual `navigator.webdriver` defineProperty
      // RE-ADDS a detectable property (proven counterproductive) — patchright
      // does it right. See docs/ARCHITECTURE.md.
      const patchright = require("patchright") as { chromium: typeof baseChromium };
      cachedChromium = patchright.chromium;
      activeStealthProfile = "cdp_hardened";
      return cachedChromium;
    }
    // Baseline: playwright-extra + stealth (unchanged). addExtra(baseChromium)
    // is exactly what playwright-extra's default `chromium` export already is.
    const { addExtra } = require("playwright-extra") as {
      addExtra: (launcher: unknown) => { use: (plugin: unknown) => unknown };
    };
    const stealth = require("puppeteer-extra-plugin-stealth") as () => unknown;
    activeStealthProfile = "baseline";
    const extra = addExtra(baseChromium);
    extra.use(stealth());
    cachedChromium = extra as unknown as typeof baseChromium;
  } catch (err) {
    // Fall back to vanilla playwright if stealth (or the rebrowser fork)
    // isn't installed. The bot still works, it's just easier to
    // fingerprint as a bot — and the A/B tag stays truthfully "baseline".
    console.warn(
      `[operator] hardened launcher unavailable, falling back to vanilla chromium: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cachedChromium = baseChromium;
    activeStealthProfile = "baseline";
  }
  return cachedChromium;
}

export interface BrowserAction {
  type: "goto" | "click" | "type" | "screenshot" | "extract" | "wait";
  selector?: string;
  text?: string;
  url?: string;
}

export interface BrowserState {
  url: string;
  title: string;
  html: string;
  screenshot: string; // base64
}

const HCAPTCHA_UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function extractHcaptchaSitekeyFromHtml(html: string): string | null {
  if (!/hcaptcha\.com|h-captcha|hcaptcha/i.test(html)) return null;
  const normalized = html
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
  for (const src of normalized.matchAll(/<iframe[^>]+src=["']([^"']*hcaptcha[^"']*)["']/gi)) {
    const raw = src[1];
    if (raw === undefined) continue;
    try {
      const url = new URL(raw, "https://example.invalid");
      const direct = url.searchParams.get("sitekey");
      if (direct !== null && direct.length > 10) return direct;
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
      const fromHash = new URLSearchParams(hash).get("sitekey");
      if (fromHash !== null && fromHash.length > 10) return fromHash;
    } catch {
      const match = raw.match(new RegExp(`[?#&]sitekey=(${HCAPTCHA_UUID_RE})`, "i"));
      if (match?.[1] !== undefined) return match[1];
    }
  }
  const patterns = [
    // Standard hCaptcha/SDK naming.
    new RegExp(
      `(?:sitekey|site_key|site-key|hcaptcha_key|captchaApiKey|data-(?:hcaptcha-)?sitekey)["'\\s]*[:=]\\s*["'](${HCAPTCHA_UUID_RE})["']`,
      "i",
    ),
    // Stripe and similar app config JSON often names keys
    // `express_hcaptcha_site_key` or `hcaptcha_login_main_site_key`.
    new RegExp(
      `(?:hcaptcha[^"'<>]{0,80}site[_-]?key|express_hcaptcha_site_key)["'\\s]*[:=]\\s*["'](${HCAPTCHA_UUID_RE})["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function extractHcaptchaResponseKeyFromToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    for (const key of ["ekey", "eKey", "respKey", "responseKey", "key", "kr"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    return null;
  }
  return null;
}

export interface BrowserControllerOptions {
  // Adds human-like timing to clicks, typing, and page loads. Defaults
  // to true in production (we want to pass Cloudflare/reCAPTCHA scoring)
  // and should be disabled in unit tests so they run fast and
  // deterministically.
  humanize?: boolean;
  // Persistent Chrome profile directory. Signup runs launch from this
  // profile so an OAuth signup reuses the Google session google-login.ts
  // established. Defaults to CHROME_PROFILE_DIR.
  profileDir?: string;
  // Per-launch egress override. When set, this run routes through this proxy
  // instead of the env-global UNIVERSAL_BOT_PROXY_URL — so a fleet of verify
  // identities can each egress from a distinct residential IP in ONE process
  // (no containers). Subject to the same ASN-class gating + liveness probe as
  // the env proxy. Unset → fall back to the env behavior.
  proxyUrl?: string;
}

export type CaptchaKind = "turnstile" | "recaptcha" | "hcaptcha";

// Map a cookie jar to the OAuth providers that have a LIVE logged-in session.
// The auth cookies that mean "signed in": GitHub → `user_session`; Google →
// any of the *SID session cookies (NID / CONSENT / 1P_JAR are set even when
// logged out, so they are deliberately NOT signals). Host-scoped so a
// google.com cookie can't pass for github. Cookie NAMES + presence only;
// values are checked for non-triviality, never logged. Exported for tests.
export function sessionProvidersFromCookies(
  cookies: ReadonlyArray<{ name: string; value: string; domain: string }>,
): OAuthProviderId[] {
  const SIGNATURES: ReadonlyArray<{
    provider: OAuthProviderId;
    host: RegExp;
    names: readonly string[];
  }> = [
    { provider: "github", host: /(^|\.)github\.com$/i, names: ["user_session"] },
    {
      provider: "google",
      host: /(^|\.)google\.com$/i,
      names: ["SID", "__Secure-1PSID", "__Secure-3PSID"],
    },
  ];
  const live: OAuthProviderId[] = [];
  for (const sig of SIGNATURES) {
    const present = cookies.some(
      (c) =>
        sig.host.test(c.domain.replace(/^\./, "")) &&
        sig.names.includes(c.name) &&
        c.value.length > 10,
    );
    if (present) live.push(sig.provider);
  }
  return live;
}

// Finer-grained captcha classification for spike telemetry (T3.2).
// `recaptcha_v3` covers any score-mode reCAPTCHA with no clickable
// checkbox (true v3 and v2-invisible behave the same to the bot:
// nothing to solve). Static-vs-dynamic of a v2 grid is intentionally
// not split here — reliable pre-solve classification needs the grid
// inspection that T3.4 (Module A) builds; the spike's question is
// answered by family + challenge_rendered.
export type CaptchaVariant =
  | "turnstile"
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "hcaptcha"
  | "unknown";

function isCaptchaVariant(v: string): v is CaptchaVariant {
  return (
    v === "turnstile" ||
    v === "recaptcha_v2" ||
    v === "recaptcha_v3" ||
    v === "hcaptcha" ||
    v === "unknown"
  );
}

// Result of solveVisibleCaptcha(). `found: false` is the happy path
// for most pages — no widget, nothing to do, agent proceeds. `solved`
// is only meaningful when `found: true`.
export type CaptchaSolveResult =
  | { found: false }
  | { found: true; solved: true; kind: CaptchaKind }
  | { found: true; solved: false; kind: CaptchaKind };

export type HcaptchaCoordinateSolveResult =
  | { found: false; solved: false; reason: "no_visible_challenge" }
  | {
      found: true;
      solved: boolean;
      reason?: string;
      clicks: number;
      durationMs?: number;
    };

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Real-Chromium-family browser channels we'll prefer over the bundled
// Chromium binary when available. Chromium ships without Widevine,
// without proprietary codecs, with an empty navigator.plugins array,
// and with a chrome.runtime API surface that bot-detection scripts
// know to look for. Using a *real* installation papers over ~6 of
// those fingerprint bits at zero engineering cost.
//
// Order matters: pick the channel most likely to be present *and*
// hardest to fingerprint as automation. Stable Chrome > Edge >
// Beta/Canary > Brave. Brave isn't a Playwright channel but its
// binary path is well-known; we resolve it explicitly below.
const PREFERRED_CHANNELS: readonly string[] = [
  "chrome",
  "msedge",
  "chrome-beta",
  "chrome-canary",
];

// Per-channel binary search paths. Playwright's `executablePath()` is
// argumentless (returns the bundled Chromium path), so we can't ask it
// "is Chrome installed?" — we have to look ourselves. These are the
// canonical install locations on each platform; the first hit wins.
//
// Limitation: this misses sideloaded installs (Chrome installed via
// the user's package manager to a non-default path, dev-builds in
// home directories, etc.). For those, the user can set
// UNIVERSAL_BOT_CHANNEL=chrome to force Playwright to find it
// through its own resolution. We accept the false-negative because
// the alternative (asking Playwright to launch and seeing if it
// succeeds) costs ~1s of process startup per probe.
const CHANNEL_PATHS: Record<string, readonly string[]> = {
  chrome: [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    // Windows — Playwright resolves these via channel anyway, but list
    // for completeness on cross-platform Node runs.
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  msedge: [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  "chrome-beta": [
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/usr/bin/google-chrome-beta",
  ],
  "chrome-canary": [
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome-unstable",
  ],
};

// Detect a real-Chromium-family browser channel without launching it.
// Returns the channel name (passable as `channel:` to .launch) or null
// to mean "use bundled Chromium." Logs the selection to stderr so the
// telemetry path can see which browser the run ended up on without
// having to thread it through the agent state machine.
async function detectChromiumChannel(): Promise<string | null> {
  // Skip detection in tests / when explicitly opting out. The unit tests
  // launch hundreds of browsers and shouldn't probe the filesystem each
  // time; they also can't rely on real Chrome being present.
  if (process.env.UNIVERSAL_BOT_CHANNEL === "bundled") return null;
  if (process.env.UNIVERSAL_BOT_CHANNEL !== undefined) {
    // Explicit override — caller knows what they want.
    return process.env.UNIVERSAL_BOT_CHANNEL;
  }

  const fsMod = await import("node:fs");
  for (const channel of PREFERRED_CHANNELS) {
    const candidatePaths = CHANNEL_PATHS[channel] ?? [];
    for (const candidate of candidatePaths) {
      try {
        if (fsMod.existsSync(candidate)) return channel;
      } catch {
        // permission errors etc. — skip this candidate, try the next
      }
    }
  }
  return null;
}

// Resolve the on-disk Chrome binary for a detected channel, for the
// self-launch path (see launchSelfManagedContext). Playwright launches a
// channel by name; we have to spawn the binary ourselves, so we need the
// path. Returns null when the channel is unknown / not found on disk
// (caller falls back to launchPersistentContext).
export function resolveChannelBinary(channel: string | null): string | null {
  if (channel === null) return null; // bundled Chromium — no self-launch
  const explicit = process.env.UNIVERSAL_BOT_CHROME_BINARY;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = CHANNEL_PATHS[channel] ?? [];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // skip unreadable candidate
    }
  }
  return null;
}

// Whether to launch Chrome ourselves and attach over CDP, instead of
// Playwright's launchPersistentContext.
//
// WHY THIS EXISTS — the single decisive finding (2026-06-12, fully
// reproduced + falsifiable; see STATE.md "Cloudflare-Turnstile wall").
// Cloudflare Turnstile's interactive challenge FAILS a Playwright/patchright
// launchPersistentContext-driven Chrome and PASSES a Chrome the operator
// launches itself and then attaches to over CDP — every other variable held
// constant (same box, same datacenter IP, same Xvfb display, same Chrome 148
// binary, same software-WebGL, same humanized click). The discriminator
// matrix:
//   launchPersistentContext + CDP click   → "Verification failed"
//   launchPersistentContext + OS click     → "Verification failed"
//   plain google-chrome      + OS click     → "Success!"
//   plain google-chrome + connectOverCDP + page.mouse → token issued (len816)
// So the tell is NEITHER the live CDP attachment NOR the click mechanism —
// it is specifically the launch flags/instrumentation Playwright injects at
// launchPersistentContext time. Self-launching the binary (no
// --enable-automation et al.) and attaching with connectOverCDP avoids it.
// Default-ON; opt out with BOT_SELF_LAUNCH=0 for the old path. Exported for tests.
export function selfLaunchEnabled(): boolean {
  const v = process.env.BOT_SELF_LAUNCH;
  return v !== "0" && v !== "false" && v !== "off";
}

// Find an ephemeral TCP port for Chrome's --remote-debugging-port.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

// Poll Chrome's DevTools HTTP endpoint until it answers (the browser is up
// and accepting CDP), or the deadline passes. Returns the base endpoint URL
// connectOverCDP accepts.
async function waitForDevtools(port: number, deadlineMs: number): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + deadlineMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return base;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome DevTools endpoint never came up on ${base} (${lastErr})`);
}

async function withChromeStartupLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = "/tmp/trusty-squire-chrome-start.lock";
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 120_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Chrome startup lock at ${lockDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

const selfManagedChromePids = new Set<number>();
let selfManagedCleanupInstalled = false;
let orphanVerifyReapRan = false;

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone / not ours
  }
}

function cleanupSelfManagedChromes(): void {
  for (const pid of selfManagedChromePids) killPid(pid, "SIGKILL");
  selfManagedChromePids.clear();
}

function installSelfManagedChromeCleanup(): void {
  if (selfManagedCleanupInstalled) return;
  selfManagedCleanupInstalled = true;
  process.once("exit", cleanupSelfManagedChromes);
  const exitForSignal = (code: number): void => {
    cleanupSelfManagedChromes();
    process.exit(128 + code);
  };
  process.once("SIGINT", () => exitForSignal(2));
  process.once("SIGTERM", () => exitForSignal(15));
  process.once("SIGHUP", () => exitForSignal(1));
}

function registerSelfManagedChrome(child: ChildProcess): void {
  installSelfManagedChromeCleanup();
  if (child.pid !== undefined) selfManagedChromePids.add(child.pid);
  child.once("exit", () => {
    if (child.pid !== undefined) selfManagedChromePids.delete(child.pid);
  });
}

// Stale verifier browsers are the expensive leak mode: if the MCP process dies
// mid-verify, self-launched Chrome survives as PPID=1 with a
// ~/.trusty-squire/profiles/verify-* user-data-dir. It keeps the profile lock,
// burns memory, and may leave defunct helper children. A live verifier should
// never be parented to init, so these are safe to reap at the next browser
// startup. Best-effort and Linux-only; failure must not block signups.
function reapOrphanedVerifyBrowsersOnce(): void {
  if (orphanVerifyReapRan) return;
  orphanVerifyReapRan = true;
  if (process.platform !== "linux") return;
  let rows = "";
  try {
    rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch {
    return;
  }
  const pids: number[] = [];
  for (const line of rows.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3] ?? "";
    if (
      Number.isFinite(pid) &&
      ppid === 1 &&
      /(?:chrome|chromium)/i.test(args) &&
      /--user-data-dir=.*\.trusty-squire\/profiles\/verify-[^/\s]+/.test(args)
    ) {
      pids.push(pid);
    }
  }
  if (pids.length === 0) return;
  console.error(`[operator] reaping ${pids.length} orphaned verify Chrome process(es)`);
  for (const pid of pids) killPid(pid, "SIGTERM");
  setTimeout(() => {
    for (const pid of pids) killPid(pid, "SIGKILL");
  }, 2_000).unref();
}

// Classify an anti-bot interstitial page from its (title + body) text.
// `onInterstitial` matches the static Cloudflare/Turnstile challenge copy.
// `verificationPassed` is the signal the challenge SUCCEEDED — but
// Cloudflare leaves the static "Just a moment / Performing security
// verification" copy ON THE PAGE even after it appends "Verification
// successful. Waiting for…", so `onInterstitial` alone wrongly reads as
// "still blocked" and the bot bails as anti_bot_blocked — exactly what
// stranded codesandbox/lambda-labs once patchright started PASSING the
// challenge. When the challenge passed, the redirect is just racing/
// stuck; the caller should be patient + reload, not give up. Exported
// for unit tests.
export function classifyInterstitialText(text: string): {
  onInterstitial: boolean;
  verificationPassed: boolean;
} {
  const onInterstitial =
    /just a moment|performing security verification|verifying you are human|checking your browser|attention required/i.test(
      text,
    );
  const verificationPassed =
    /verification successful|you are (now )?verified|success!|challenge[- ]?(passed|complete)/i.test(
      text,
    );
  return { onInterstitial, verificationPassed };
}

// After a Cloudflare managed challenge PASSES, the cf_clearance cookie is
// set but the URL still carries Cloudflare's single-use challenge token
// (`__cf_chl_rt_tk`, `__cf_chl_tk`, `__cf_chl_f_tk`, …). Cloudflare's own
// client-side redirect to the cleared page can stall — especially over a
// high-latency residential tunnel, where the meta-refresh/JS hop never
// fires inside our wait budget. Re-navigating to the SAME url with those
// one-shot tokens stripped serves the real page directly (the clearance
// cookie now satisfies the edge), instead of waiting on the stuck redirect.
// Returns the cleaned URL, or null when there's no challenge token to strip
// (nothing this can do better than a plain reload). Exported for unit tests.
export function stripCloudflareChallengeParams(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("__cf_chl")) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? u.toString() : null;
}

export class BrowserController {
  // The persistent browser context. Persistent (launchPersistentContext)
  // rather than an ephemeral context so the profile carries the user's
  // Google session across runs — see profile.ts / google-login.ts.
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  // Self-launch path (Turnstile-safe; see selfLaunchEnabled). When we spawn
  // Chrome ourselves and attach over CDP, these hold the child process and
  // the connected Browser so close() can tear both down.
  private childChrome: ChildProcess | null = null;
  private cdpBrowser: Browser | null = null;
  // True once launchPersistentContext succeeded this session. close() only
  // reaps a leaked Chrome when WE launched one — so a ProfileBusyError thrown
  // BEFORE launch (while waiting on a genuine concurrent holder) never kills
  // that other run's browser.
  private launchedContext = false;
  private readonly humanize: boolean;
  // Tracks the simulated mouse position so successive clicks can move
  // along a continuous path (humans don't teleport between clicks).
  private mouseX = 100;
  private mouseY = 100;
  // Records the browser channel that .start() actually launched. Set
  // post-launch so telemetry can surface "this run
  // used real Chrome" vs "this run used bundled Chromium." Useful for
  // separating fingerprint regressions from network regressions when
  // a service starts failing.
  private launchedChannel: string | null = null;
  // The proxy server this run egressed through, or null for a direct
  // connection. Set by .start(); surfaced via the `proxied` getter —
  // a captcha failure behind a residential proxy is materially
  // different signal from the same failure on a raw datacenter IP.
  private proxyServer: string | null = null;

  private readonly profileDir: string;

  // T6/T7 — OAuth handshake bookkeeping. When startOAuth() adopts a
  // popup window as the active page, the original product page is
  // parked here so settleAfterOAuth() can switch back to it once the
  // Google handshake completes.
  private oauthProductPage: Page | null = null;
  // Deep-investigation instrumentation (UNIVERSAL_BOT_OAUTH_DEBUG): a ring
  // buffer of OAuth/SSO-relevant network responses, so we can see WHY a Clerk/
  // Stytch SSO callback fails to persist a session (cookie not set, FAPI
  // rejection, etc.) without guessing. Off by default; zero cost when unset.
  private oauthNetLog: Array<{ url: string; status: number; setCookie: boolean; ct: string }> = [];
  private oauthNetListenerAttached = false;

  // F13 — on-demand Xvfb. Set when start() determined the host has no
  // display surface but Xvfb is available, so Chrome can run with
  // `headless: false` against a virtual display (Cloudflare/Stytch et
  // al. detect Chromium-headless and block their signup forms). Torn
  // down by close().
  private xvfb: XvfbRig | null = null;

  // F13 — which launch path start() took. Surfaced via .launchMode so
  // the agent can push it into the run's step trail and we can see
  // (from outside the box) whether the bot ran headed.
  private launchedMode: "display" | "xvfb" | "headless" | "remote" | "unknown" =
    "unknown";

  get launchMode(): "display" | "xvfb" | "headless" | "remote" | "unknown" {
    return this.launchedMode;
  }

  constructor(opts: BrowserControllerOptions = {}) {
    this.humanize = opts.humanize ?? true;
    this.profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
    this.proxyOverride =
      opts.proxyUrl !== undefined && opts.proxyUrl.trim().length > 0
        ? opts.proxyUrl.trim()
        : null;
  }

  // Per-launch egress override (verify-fleet identities each get their own IP).
  // null → use the env-global proxy. See resolveProxy().
  private readonly proxyOverride: string | null;

  // Which browser channel the most recent .start() actually used.
  // `null` means bundled Chromium; a string like "chrome" means a
  // real installed browser of that channel. Throws if .start() hasn't
  // been called yet — there's no sensible default to return.
  get channel(): string | null {
    if (this.context === null) {
      throw new Error("BrowserController.channel read before .start()");
    }
    return this.launchedChannel;
  }

  // The proxy server the most recent .start() routed egress through,
  // or null for a direct connection. Useful telemetry alongside
  // `channel`. Throws if .start() hasn't run — same reason as channel.
  get proxied(): string | null {
    if (this.context === null) {
      throw new Error("BrowserController.proxied read before .start()");
    }
    return this.proxyServer;
  }

  // The stealth profile the most recent .start() launched under:
  // "cdp_hardened" when the patchright launcher actually loaded
  // (BOT_CDP_HARDENED set + patchright present), else "baseline". Surfaced
  // for the CaptchaEvent A/B tag. Throws before .start() — same reason
  // as channel/proxied.
  get stealthProfile(): StealthProfile {
    if (this.context === null) {
      throw new Error("BrowserController.stealthProfile read before .start()");
    }
    return activeStealthProfileValue();
  }

  // Launch Chrome ourselves and attach over CDP — the Turnstile-safe launch
  // (see selfLaunchEnabled for the proof). The profile dir is the SAME shared
  // profile launchPersistentContext would use, so the OAuth session carries
  // over. Options that launchPersistentContext takes at creation but a default
  // (connectOverCDP) context can't are applied differently:
  //   • timezone  → TZ env on the child (more authentic than a CDP override)
  //   • proxy     → --proxy-server flag (auth-less only; the caller routes
  //                 credentialed proxies to the old path)
  //   • viewport  → --window-size (with viewport:null-equivalent: we never set
  //                 an emulated viewport on the connected context)
  //   • locale/geo/permissions → applied post-connect by start()
  private async launchSelfManagedContext(params: {
    binary: string;
    headless: boolean;
    args: readonly string[];
    proxy: ProxySettings | null;
    env: NodeJS.ProcessEnv;
    window: { width: number; height: number };
  }): Promise<BrowserContext> {
    // Remote-CDP attach: BOT_CDP_ENDPOINT points at a Chrome already running on
    // another host (e.g. a real-GPU Mac), reachable over Tailscale. We do NOT
    // spawn or own the binary — the remote host launched it with its own
    // profile, real GPU, and (residential) egress. Just attach over CDP. This
    // is the real-GPU path: software-WebGL output (llvmpipe) is what
    // hCaptcha-Enterprise-class anti-bot scores, and only real hardware fixes
    // the rendered-pixel fingerprint that JS spoofing can't.
    const remoteEndpoint = (process.env.BOT_CDP_ENDPOINT ?? "").trim();
    if (remoteEndpoint.length > 0) {
      const launcher = getChromium();
      const browser = await launcher.connectOverCDP(remoteEndpoint);
      this.cdpBrowser = browser;
      this.launchedMode = "remote";
      const ctx = browser.contexts()[0];
      if (ctx === undefined) {
        throw new Error(
          `remote Chrome (BOT_CDP_ENDPOINT=${remoteEndpoint}) exposed no default browser context`,
        );
      }
      return ctx;
    }
    const endpoint = await withChromeStartupLock(async () => {
      const port = await findFreePort();
      clearStaleSingletonLock(this.profileDir);
      const argv = [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--window-position=0,0",
        `--window-size=${params.window.width},${params.window.height}`,
        "--lang=en-US",
        ...params.args,
        ...(params.proxy !== null ? [`--proxy-server=${params.proxy.server}`] : []),
        ...(params.headless ? ["--headless=new"] : []),
        "about:blank",
      ];
      const child = spawn(params.binary, argv, { env: params.env, stdio: ["ignore", "ignore", "pipe"] });
      this.childChrome = child;
      registerSelfManagedChrome(child);
      let chromeStderr = "";
      let chromeExit = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-4_000);
      });
      child.on("exit", (code, signal) => {
        chromeExit = ` exit=${code ?? "null"} signal=${signal ?? "none"}`;
      });
      try {
        return await waitForDevtools(port, 30_000);
      } catch (err) {
        const alive =
          child.pid !== undefined
            ? (() => {
                try {
                  process.kill(child.pid!, 0);
                  return true;
                } catch {
                  return false;
                }
              })()
            : false;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        reapLeakedProfileHolder(this.profileDir);
        this.childChrome = null;
        const detail = chromeStderr.trim();
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}; Chrome pid=${child.pid ?? "unknown"} alive=${alive ? 1 : 0}` +
            `${chromeExit}${
          detail.length > 0 ? `; Chrome stderr: ${detail}` : ""
        }`,
      );
      }
    });
    // Use the patchright launcher's connectOverCDP — it's the exact path the
    // falsification experiment validated (its connect avoids Runtime.enable,
    // which a plain attach would emit). The anti-detection that matters here
    // is the LAUNCH (which we now own), not the connect.
    const launcher = getChromium();
    const browser = await launcher.connectOverCDP(endpoint);
    this.cdpBrowser = browser;
    const ctx = browser.contexts()[0];
    if (ctx === undefined) {
      throw new Error("self-launched Chrome exposed no default browser context");
    }
    return ctx;
  }

  // Resource blocking for speed (BOT_BLOCK_RESOURCES, default OFF). Aborts
  // image/media/font requests + known analytics/tracker hosts to cut page-load
  // wall-clock (3-5x on byte-heavy pages; also stops trackers from holding the
  // network "busy"). HARD ALLOW-GUARD first for captcha/challenge + payment
  // scripts (blocking those breaks the Turnstile/hCaptcha token poll and the
  // signup form). CSS + first-party JS are never blocked (not in BLOCK_TYPES) —
  // the SPA form renders from them and the vision planner reads the styled
  // render. DUAL RISK, hence default-OFF + an OF#2 A/B before flipping on:
  //   (1) a browser that loads ZERO images is itself an anti-bot fingerprint;
  //   (2) the screenshot the vision planner reads loses detail — mitigated
  //       because the DOM inventory is the authoritative action space, but
  //       still a regression risk on image-only affordances.
  // Registered on the CONTEXT so it covers OAuth popups + iframes.
  private async installResourceBlocking(): Promise<void> {
    const ctx = this.context;
    if (ctx === null) return;
    if (!/^(1|true|on)$/i.test(process.env.BOT_BLOCK_RESOURCES ?? "")) return;
    const BLOCK_TYPES = new Set(["image", "media", "font"]);
    const BLOCK_HOSTS = [
      "google-analytics.com", "googletagmanager.com", "analytics.google.com",
      "doubleclick.net", "static.hotjar.com", "script.hotjar.com",
      "segment.com", "segment.io", "cdn.segment.com", "fullstory.com",
      "mixpanel.com", "bugsnag.com", "intercom.io", "intercomcdn.com",
      "widget.intercom.io", "connect.facebook.net", "analytics.tiktok.com",
      "clarity.ms", "cdn.heapanalytics.com", "wistia.com",
    ];
    // NEVER block — these break signup (captcha/challenge widgets + payment SDK).
    const ALWAYS_ALLOW = [
      "challenges.cloudflare.com", "turnstile", "hcaptcha.com",
      "newassets.hcaptcha.com", "recaptcha", "gstatic.com/recaptcha",
      "js.stripe.com",
    ];
    await ctx.route("**/*", async (route) => {
      try {
        const url = route.request().url();
        if (ALWAYS_ALLOW.some((h) => url.includes(h))) {
          await route.continue();
          return;
        }
        const type = route.request().resourceType();
        if (BLOCK_TYPES.has(type) || BLOCK_HOSTS.some((h) => url.includes(h))) {
          await route.abort();
          return;
        }
        await route.continue();
      } catch {
        // Routing race / already-handled — never let a decision crash nav.
      }
    });
    console.error(
      "[operator] resource blocking ON (image/media/font + analytics aborted; captcha/CSS/JS allowed)",
    );
  }

  async start(): Promise<void> {
    reapOrphanedVerifyBrowsersOnce();
    const channel = await detectChromiumChannel();
    this.launchedChannel = channel;
    const proxy = await this.resolveProxy();
    this.proxyServer = proxy?.server ?? null;
    // Stderr so the MCP stdio transport's framing stays clean (the
    // module's existing logging convention).
    console.error(
      `[operator] launching browser channel=${channel ?? "bundled-chromium"} ` +
        `proxy=${proxy?.server ?? "direct"}`,
    );
    // Remote-CDP mode (BOT_CDP_ENDPOINT): the browser runs on a REMOTE host
    // (e.g. a Mac with a real GPU + residential egress) and we attach over CDP
    // across Tailscale. The remote machine IS a real device, so we spoof
    // NOTHING — no WebGL/device fingerprint patch (a fake-Intel string over a
    // real Apple-GPU output would be its own mismatch tell), no local Xvfb, no
    // egress-geo override (the remote host's real timezone + residential IP are
    // authentic). software-WebGL output is exactly what the toughest anti-bot
    // (hCaptcha Enterprise) scores; only real hardware fixes the pixel
    // fingerprint, which is the whole point of this path.
    const remoteMode = (process.env.BOT_CDP_ENDPOINT ?? "").trim().length > 0;
    if (remoteMode) {
      console.error(
        `[operator] REMOTE-CDP mode — attaching to ${(process.env.BOT_CDP_ENDPOINT ?? "").trim()} ` +
          `(real-host GPU + egress; local fingerprint spoof + Xvfb DISABLED)`,
      );
    }
    // T3.1: probe where this run's traffic actually exits so the
    // browser's declared timezone matches its egress IP (a US-timezone
    // browser on a foreign proxy IP is itself an anti-bot signal).
    // Done before the real launch: launchPersistentContext bakes the
    // timezone in at creation, with no way to set it afterward. Skipped in
    // remote mode — the remote host's own clock/IP are the authentic truth.
    const geo = remoteMode ? null : await this.probeEgressGeo(channel, proxy);
    if (geo !== null) {
      console.error(
        `[operator] egress geo: timezone=${geo.timezoneId}` +
          (geo.geolocation !== undefined
            ? ` loc=${geo.geolocation.latitude},${geo.geolocation.longitude}`
            : ""),
      );
    }
    // F13 — decide whether to spin up Xvfb and run Chrome headed.
    // Modern SaaS signups (Cloudflare/Stytch, Clerk, Auth0) detect
    // Chromium-headless via JS fingerprints and gate their forms
    // behind the check. Running headed against Xvfb defeats the gate
    // — the user never sees the display.
    //
    // The decision matrix:
    //   - UNIVERSAL_BOT_HEADLESS=true (explicit opt-in): keep true
    //     headless. CI / Codespaces that lack Xvfb.
    //   - UNIVERSAL_BOT_HEADLESS=false (explicit opt-out): the
    //     current pre-F13 behavior — DISPLAY must exist already.
    //   - default + DISPLAY set: run headed against the existing
    //     display (laptop/desktop install).
    //   - default + no DISPLAY + Xvfb on PATH: spawn Xvfb, run
    //     headed against it (the headless-server install — what
    //     Cloudflare needed).
    //   - default + no DISPLAY + no Xvfb: fall back to true
    //     headless with a clear stderr warning.
    let chromeEnv: NodeJS.ProcessEnv | undefined;
    let chromeHeadless: boolean;
    const explicitHeadless = process.env.UNIVERSAL_BOT_HEADLESS;
    const hostHasDisplay =
      process.platform === "darwin" ||
      process.platform === "win32" ||
      (typeof process.env.DISPLAY === "string" && process.env.DISPLAY.length > 0);
    if (explicitHeadless === "true") {
      chromeHeadless = true;
      this.launchedMode = "headless";
    } else if (explicitHeadless === "false") {
      chromeHeadless = false;
      this.launchedMode = "display";
    } else if (hostHasDisplay) {
      chromeHeadless = false;
      this.launchedMode = "display";
    } else if (xvfbAvailable()) {
      try {
        // 1920×1080 — the most common real desktop resolution. The old
        // 1280×720 here was exactly Playwright's emulated-device viewport
        // default (the code's own comments flag that as an anti-bot tell),
        // and with viewport:null the page read it straight back. A 720p
        // screen whose availHeight==height (no taskbar) is a headless
        // signature strict Turnstiles (exa/cartesia) score against.
        this.xvfb = await startXvfb({ width: 1920, height: 1080 });
        chromeEnv = { ...process.env, DISPLAY: this.xvfb.display };
        chromeHeadless = false;
        this.launchedMode = "xvfb";
        console.error(
          `[operator] no DISPLAY — spawned Xvfb at ${this.xvfb.display} for headed Chrome`,
        );
      } catch (err) {
        console.error(
          `[operator] Xvfb failed (${err instanceof Error ? err.message : String(err)}) — ` +
            `falling back to true headless; Cloudflare/Stytch-class signups may fail`,
        );
        chromeHeadless = true;
        this.launchedMode = "headless";
      }
    } else {
      console.error(
        `[operator] no DISPLAY and Xvfb not installed — running true headless. ` +
          `For Cloudflare/Stytch-class signups install xvfb: apt-get install -y xvfb`,
      );
      chromeHeadless = true;
      this.launchedMode = "headless";
    }

    // Cross-process gate on the shared Chrome profile: reclaim a stale
    // SingletonLock from a killed run, or wait our turn behind a live
    // `mcp login` / another signup. Without this, launchPersistentContext
    // aborts with "Failed to create a ProcessSingleton" and bricks the run.
    let free = await waitForProfileFree(this.profileDir, {
      deadlineMs: 120_000,
      onWait: () =>
        console.error("[operator] bot Chrome profile is busy with another run — waiting…"),
    });
    if (!free) {
      // A live-pid holder that never released within the deadline. The
      // signup/discover loop is strictly serial (one run at a time), so a
      // local holder that outlasts 120s is NOT a legitimate concurrent run —
      // it's a leaked Chrome from a previously EXTERNALLY-killed run
      // (run_timeout SIGKILL, OOM, reboot) whose JS `finally`/close() never
      // executed, so reapLeakedProfileHolder never ran. waitForProfileFree
      // only reclaims dead-pid / null locks, so this live orphan otherwise
      // crashes every subsequent run with ProfileBusyError (MEASURED
      // 2026-06-11: cyclic, railpack). A genuine concurrent `mcp login` would
      // have released within the 120s wait — so by here, reaping the LOCAL
      // holder (SIGKILL + clear singletons; no-ops on a remote-host holder)
      // and retrying once is safe and recovers the run instead of failing it.
      //
      // That assumption is false for verifier/discovery concurrency: a live
      // holder can be another legitimate slot still closing the same robot
      // profile. In concurrent mode, never SIGKILL the holder; surface
      // ProfileBusyError so the orchestrator can retry later without corrupting
      // another run.
      const concurrency = Number.parseInt(process.env.HOUSEKEEPER_CONCURRENCY ?? "1", 10) || 1;
      const allowLiveReap = concurrency <= 1;
      const reaped = allowLiveReap ? reapLeakedProfileHolder(this.profileDir) : false;
      if (reaped) {
        console.error(
          "[operator] reaped a leaked Chrome holding the profile (orphan from an externally-killed run) — retrying",
        );
        free = await waitForProfileFree(this.profileDir, { deadlineMs: 10_000 });
      } else if (!allowLiveReap) {
        console.error(
          "[operator] profile still held after wait; not reaping because HOUSEKEEPER_CONCURRENCY>1",
        );
      }
      if (!free) {
        throw new ProfileBusyError(
          "bot Chrome profile is held by another run (a login or signup); retry shortly",
        );
      }
    }

    // T3: a PERSISTENT context. The profile dir carries the user's
    // Google session (established by `mcp login` — see google-login.ts),
    // so the OAuth-first signup path reuses it instead of starting
    // logged-out. launchPersistentContext takes launch + context
    // options in one call.
    // Resolve the launcher first so activeStealthProfile is set before we
    // decide on executablePath below.
    const launcher = getChromium();
    const hardened = activeStealthProfileValue() === "cdp_hardened";
    // Both launchers drive real Chrome via `channel`: baseline through
    // playwright+stealth, hardened through patchright. patchright closes
    // the automation tells at the protocol layer and drives real Chrome
    // directly — so it no longer needs the bundled-chromium pin the old
    // rebrowser fork required (the pin is what crashed the OAuth flow and
    // confounded the A/B). One binary for both arms.
    this.launchedChannel = channel;
    // Launch args shared by BOTH paths (launchPersistentContext and the
    // self-launch). See the per-flag rationale: swiftshader gives a real
    // (software) WebGL context on the GPU-less Xvfb box; the others are the
    // standard headless/sandbox flags. NOTE we deliberately do NOT include
    // Playwright's automation flags (--enable-automation et al.) — on the
    // self-launch path their ABSENCE is the whole fix.
    const launchArgs: readonly string[] = [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ];
    // F10 clipboard + egress-matched geolocation permission, built once for
    // either path. Typed as string[] (Playwright's grantPermissions /
    // permissions option both accept it).
    const grantedPermissions: string[] = [
      ...(geo?.geolocation !== undefined ? ["geolocation"] : []),
      "clipboard-read",
      "clipboard-write",
    ];
    // Decide the launch path. Self-launch (Turnstile-safe) requires a real
    // Chrome binary on disk AND an auth-less proxy (a credentialed proxy needs
    // Playwright's native proxy auth, which only the launchPersistentContext
    // path provides — so route those there).
    const selfLaunchBinary = selfLaunchEnabled() ? resolveChannelBinary(channel) : null;
    const proxyHasAuth =
      proxy !== null && typeof proxy.username === "string" && proxy.username.length > 0;
    const useSelfLaunch = selfLaunchBinary !== null && !proxyHasAuth;

    let context: BrowserContext;
    if (useSelfLaunch && selfLaunchBinary !== null) {
      console.error(
        `[operator] self-launch + connectOverCDP (Turnstile-safe launch) binary=${selfLaunchBinary}`,
      );
      // Window size matches the display surface so viewport reads as a real
      // window (no emulated-viewport tell). TZ on the child makes Chrome
      // report the egress timezone natively.
      const window =
        this.launchedMode === "xvfb"
          ? { width: 1920, height: 1080 }
          : { width: 1280, height: 1024 };
      const selfEnv: NodeJS.ProcessEnv = {
        ...(chromeEnv ?? process.env),
        TZ: geo?.timezoneId ?? "America/New_York",
      };
      context = await launchWithProfileGate(this.profileDir, () =>
        this.launchSelfManagedContext({
          binary: selfLaunchBinary,
          headless: chromeHeadless,
          args: launchArgs,
          proxy,
          env: selfEnv,
          window,
        }),
      );
      // Options the default (connectOverCDP) context can't take at creation —
      // applied post-connect. Best-effort: a failure here is non-fatal (the
      // signup proceeds; only clipboard-key-extraction / geo degrade).
      try {
        await context.grantPermissions(grantedPermissions);
        if (geo?.geolocation !== undefined) {
          await context.setGeolocation(geo.geolocation);
        }
      } catch (err) {
        console.error(
          `[operator] post-connect context setup partial: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      if (selfLaunchEnabled() && selfLaunchBinary !== null && proxyHasAuth) {
        console.error(
          "[operator] credentialed proxy → launchPersistentContext (self-launch can't carry proxy auth)",
        );
      }
      // T3: a PERSISTENT context (the legacy path). The profile dir carries the
      // user's Google session so the OAuth-first path reuses it.
      context = await launchWithProfileGate(this.profileDir, () =>
        launcher.launchPersistentContext(this.profileDir, {
          headless: chromeHeadless,
          ...(chromeEnv !== undefined ? { env: chromeEnv } : {}),
          ...(channel !== null ? { channel } : {}),
          ...(proxy !== null ? { proxy } : {}),
          args: [...launchArgs],
          viewport: null,
          locale: "en-US",
          timezoneId: geo?.timezoneId ?? "America/New_York",
          permissions: grantedPermissions,
          ...(geo?.geolocation !== undefined ? { geolocation: geo.geolocation } : {}),
        }),
      );
    }
    this.context = context;
    // We own the profile now — close() may reap a leaked Chrome.
    this.launchedContext = true;
    // Speed: optionally abort heavy/irrelevant requests before any navigation.
    await this.installResourceBlocking();
    // Dev-runtime guard: when the bot is run through `tsx`, esbuild may inject
    // calls to its `__name(fn, "name")` helper into functions passed to
    // page.evaluate/addInitScript. Those functions execute in the browser page,
    // where Node's helper does not exist, causing an immediate
    // `ReferenceError: __name is not defined` before the real signup even
    // starts. Define the same no-op helper in every document. Built `dist`
    // should not emit these calls, but the helper is harmless there too.
    const evaluateNameShimScript =
      'Object.defineProperty(globalThis, "__name", { value: (fn) => fn, configurable: true });';
    await context.addInitScript({ content: evaluateNameShimScript });
    // Patch navigator.webdriver — BASELINE ONLY. Measured against the
    // rebrowser bot-detector, this manual `defineProperty` is
    // COUNTERPRODUCTIVE under patchright: it re-adds `webdriver` as an own
    // property the detector then flags, whereas patchright removes it
    // correctly at the source. So in hardened mode we leave it to
    // patchright; only the stealth baseline gets the manual patch.
    if (!hardened) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    }

    // rc.33 / 2026-06-04 — spoof the WebGL UNMASKED vendor+renderer toward a
    // stock Intel GPU, so the software Mesa/llvmpipe string (--enable-unsafe-
    // swiftshader gives us a context, but llvmpipe is itself a VM/headless
    // tell) doesn't read through. Applied TWO ways because patchright
    // (hardened) isolates document-start scripts from the page's main world:
    //   • addInitScript — document-start; the effective path in the stealth
    //     BASELINE (non-patchright).
    //   • re-applied via page.evaluate on every navigation — the ONLY path that
    //     reaches the MAIN world under patchright. MEASURED 2026-06-04:
    //     addInitScript AND raw CDP Page.addScriptToEvaluateOnNewDocument both
    //     land in patchright's isolated world (renderer stayed llvmpipe);
    //     page.evaluate does not (renderer became Intel), and the v3 score held
    //     at 1.0. Idempotent via a marker so the per-nav re-apply is cheap, and
    //     getParameter.toString() is masked to the original native source so
    //     the patch itself isn't a tell. Only strings change, not rendering.
    const installWebglSpoofScript = String.raw`(() => {
      const VENDOR_WEBGL = 0x9245; // UNMASKED_VENDOR_WEBGL
      const RENDERER_WEBGL = 0x9246; // UNMASKED_RENDERER_WEBGL
      const spoof = (proto) => {
        // The marker lives on the prototype so re-application is a no-op; the
        // cast is the one typed-alternative-exhausted spot (adding an ad-hoc
        // brand to a DOM prototype).
        if (proto.__tsWebglPatched === true) return;
        const orig = proto.getParameter;
        const native = orig.toString();
        proto.getParameter = function (p) {
          if (p === VENDOR_WEBGL) return "Google Inc. (Intel)";
          if (p === RENDERER_WEBGL) {
            return "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)";
          }
          return orig.call(this, p);
        };
        Object.defineProperty(proto.getParameter, "toString", {
          value: () => native,
          configurable: true,
          writable: true,
        });
        proto.__tsWebglPatched = true;
      };
      if (typeof WebGLRenderingContext !== "undefined") {
        spoof(WebGLRenderingContext.prototype);
      }
      if (typeof WebGL2RenderingContext !== "undefined") {
        spoof(WebGL2RenderingContext.prototype);
      }
      // Device-tell normalization. The headless harvester box reports 20
      // logical cores (navigator.hardwareConcurrency) — a consumer residential
      // device is 4-16. A 20-core Linux machine behind a "residential" IP is
      // an internal inconsistency Cloudflare Turnstile scores against
      // (MEASURED 2026-06-11: exa/cartesia Turnstile won't issue a token on a
      // clean-fingerprint click; hwConcurrency=20 + Linux is the standout
      // anomaly). Normalize to a common consumer profile. Same per-nav main-
      // world application as the WebGL spoof — patchright denies init-world
      // reach, and Turnstile reads these after the challenge script loads
      // (seconds in), so the framenavigated re-apply wins the race. Defined on
      // Navigator.prototype (where the native getters live) so there's no own-
      // property tell on the instance.
      const navProto = Navigator.prototype;
      if (navProto.__tsDevicePatched !== true) {
        try {
          Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
            get: () => 8,
            configurable: true,
          });
          Object.defineProperty(Navigator.prototype, "deviceMemory", {
            get: () => 8,
            configurable: true,
          });
          // Screen availHeight tell: a headless Xvfb screen reports
          // availHeight == height (no OS taskbar), whereas a real Windows
          // desktop reserves ~40px for the taskbar (availHeight = height-40,
          // availWidth = width). Reinstate that gap so the screen reads like
          // an ordinary desktop, not a bare framebuffer. Guarded so it only
          // applies when the two are currently equal (i.e. headless).
          try {
            if (screen.availHeight === screen.height) {
              Object.defineProperty(Screen.prototype, "availHeight", {
                get: () => screen.height - 40,
                configurable: true,
              });
            }
          } catch {
            // leave it
          }
          navProto.__tsDevicePatched = true;
        } catch {
          // descriptor already locked by something else — leave it.
        }
      }
    })();`;
    if (!remoteMode) await context.addInitScript({ content: installWebglSpoofScript });
    this.page = context.pages()[0] ?? (await context.newPage());
    // addInitScript covers document-start page JS, but Playwright's
    // page.evaluate utility execution can run in a separate realm. Install the
    // same no-op helper there with a STRING evaluate (tsx cannot wrap strings
    // with __name). This prevents dev-runtime source runs from crashing before
    // replay reaches the service page.
    await this.page.evaluate(evaluateNameShimScript).catch(() => undefined);
    // Re-apply on every navigation — the main-world reach patchright's isolated
    // init world denies us. framenavigated fires at navigation-commit (before
    // most page JS), so a late WebGL query (reCAPTCHA scores seconds in) sees
    // the spoofed strings; a document-start fingerprinter could still race it.
    const reapplyWebglSpoof = (): void => {
      if (remoteMode) return; // real-GPU remote host: spoof nothing
      const pg = this.page;
      if (pg === null) return;
      void (async () => {
        await pg.evaluate(evaluateNameShimScript).catch(() => undefined);
        await pg.evaluate(installWebglSpoofScript).catch(() => {
          // mid-navigation / closed page — the next navigation re-applies.
        });
      })();
    };
    // A CROSS-ORIGIN captcha iframe (hCaptcha / Turnstile / reCAPTCHA) is its own
    // realm: the main-frame page.evaluate above never reaches it, so the captcha's
    // OWN fingerprint read sees the real software-WebGL renderer (llvmpipe /
    // SwiftShader) + 20-core / high-memory / no-taskbar Linux profile — a
    // headless/VM tell. MEASURED 2026-06-23: Stripe's invisible hCaptcha
    // Enterprise flags the session before any token, identically on a datacenter
    // AND a residential exit IP (IP falsified) — the discriminator is this
    // unspoofed in-iframe fingerprint. Patch the iframe's own main world too.
    // frame.evaluate reaches a cross-origin frame's main world at the driver
    // level (same path that wins the main-frame race), re-applied at
    // navigation-commit before the captcha's scoring JS queries WebGL.
    const CAPTCHA_FRAME_RE =
      /(hcaptcha\.com|challenges\.cloudflare\.com|google\.com\/recaptcha|recaptcha\.net|arkoselabs\.com|funcaptcha\.com)/i;
    // String probe (no compiled-fn __name shim needed): the UNMASKED renderer
    // a captcha would read. Logged only under CAPTCHA_TRACE to prove the fix.
    const RENDERER_PROBE = String.raw`(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl") || c.getContext("webgl2"); if (!gl) return "no-gl"; const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (err) { return "err:" + (err && err.message); } })()`;
    const trace = process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1";
    this.page.on("framenavigated", (frame) => {
      if (remoteMode) return; // real-GPU remote host: no in-iframe spoof
      if (this.page === null) return;
      if (frame === this.page.mainFrame()) {
        reapplyWebglSpoof();
        return;
      }
      if (!CAPTCHA_FRAME_RE.test(frame.url())) return;
      const cfHost = (() => {
        try {
          return new URL(frame.url()).host;
        } catch {
          return "captcha-frame";
        }
      })();
      void (async () => {
        if (trace) {
          const before = await frame.evaluate(RENDERER_PROBE).catch(() => "eval-fail");
          // eslint-disable-next-line no-console
          console.error(`[captcha-fp] ${cfHost} renderer BEFORE spoof: ${before}`);
        }
        // Retry until the spoof STICKS. The first framenavigated commonly
        // eval-fails (frame mid-commit, or a throwaway about:blank hCaptcha
        // replaces), and hCaptcha reads the fingerprint during its widget
        // lifecycle — a single best-effort apply loses the race. Re-apply on a
        // ~3s budget until the iframe's renderer reads Intel, so the spoof is in
        // place before the scoring read.
        let landed = false;
        for (let i = 0; i < 20 && !landed; i++) {
          await frame.evaluate(installWebglSpoofScript).catch(() => undefined);
          const r = await frame.evaluate(RENDERER_PROBE).catch(() => "eval-fail");
          if (typeof r === "string" && r.includes("Intel")) landed = true;
          else await new Promise((res) => setTimeout(res, 150));
        }
        if (trace) {
          // eslint-disable-next-line no-console
          console.error(
            `[captcha-fp] ${cfHost} renderer AFTER spoof:  ${landed ? "Intel (landed)" : "FAILED to land in budget"}`,
          );
        }
      })();
    });
    this.page.on("load", reapplyWebglSpoof);

    // rc.33 — captcha tracing. When UNIVERSAL_BOT_CAPTCHA_TRACE=1 is
    // set, log every response from Cloudflare/Google's challenge
    // endpoints plus any console message that mentions captcha-y
    // keywords. Gives us visibility into *why* a Tier-2 click times
    // out ("sat idle" vs "score-too-low" vs "follow-up issued") —
    // the parent page can't read the iframe's DOM (cross-origin) but
    // it CAN observe its network. Off by default; opt in for
    // diagnostic runs only since the bodies can be large.
    if (process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1") {
      this.page.on("response", async (resp) => {
        const url = resp.url();
        if (
          !/challenges\.cloudflare\.com|google\.com\/recaptcha|hcaptcha\.com|newassets\.hcaptcha\.com/.test(
            url,
          )
        ) {
          return;
        }
        const status = resp.status();
        const ct = resp.headers()["content-type"] ?? "";
        let bodyPreview = "";
        if (
          /json|javascript|html|plain/.test(ct) ||
          /api\.hcaptcha\.com\/(?:checksiteconfig|getcaptcha|checkcaptcha)/.test(url)
        ) {
          try {
            const body = await resp.text();
            bodyPreview =
              body.length > 400 ? body.slice(0, 400) + "…" : body;
          } catch {
            // body may be evicted; ignore
          }
        }
        console.error(
          `[captcha-trace] ${status} ${url}${
            bodyPreview ? "\n  body: " + bodyPreview.replace(/\n/g, "\\n") : ""
          }`,
        );
      });
      this.page.on("console", (msg) => {
        const text = msg.text();
        if (!/turnstile|cloudflare|challenge|recaptcha/i.test(text)) return;
        console.error(`[captcha-trace] console.${msg.type()}: ${text}`);
      });
    }
  }

  // Probe the run's actual egress geo by loading ipinfo.io. Launches a
  // throwaway browser: the persistent context isn't up yet, and its
  // timezone has to be known before it is. The throwaway inherits the
  // same channel + proxy so it reports the real egress. Best-effort —
  // any failure returns null and start() keeps a default timezone.
  private async probeEgressGeo(
    channel: string | null,
    proxy: ProxySettings | null,
  ): Promise<EgressGeo | null> {
    if (proxy === null) {
      try {
        const resp = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return parseEgressGeo(await resp.text());
      } catch (err) {
        console.error(
          `[operator] egress geo probe failed — using default ` +
            `timezone: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    let probe: Browser | undefined;
    try {
      probe = await getChromium().launch({
        headless: process.env.UNIVERSAL_BOT_HEADLESS !== "false",
        ...(channel !== null ? { channel } : {}),
        ...(proxy !== null ? { proxy } : {}),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await probe.newPage();
      await page.goto("https://ipinfo.io/json", {
        timeout: 10000,
        waitUntil: "domcontentloaded",
      });
      const body = await page.evaluate(() => document.body.innerText);
      return parseEgressGeo(body);
    } catch (err) {
      console.error(
        `[operator] egress geo probe failed — using default ` +
          `timezone: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      if (probe !== undefined) await probe.close();
    }
  }

  // Decide whether this run egresses through a residential proxy, and
  // return Playwright's proxy settings or null for a direct connection.
  //
  // The fast path: when UNIVERSAL_BOT_PROXY_URL is unset (the default),
  // this returns null before doing anything — no ASN lookup, no added
  // latency for the ~80% of users who never configure a proxy.
  //
  // When a proxy IS configured, it's used only for datacenter-class
  // egress: reCAPTCHA/Cloudflare score datacenter IPs as bot-likely no
  // matter how clean the fingerprint is, while residential users
  // already pass — so routing them through the proxy would just burn
  // money. UNIVERSAL_BOT_PROXY_ALWAYS=true forces it on for networks
  // that misclassify as "unknown". A malformed URL never aborts the
  // run — we log and fall back to a direct connection.
  private async resolveProxy(): Promise<ProxySettings | null> {
    // Per-launch override (verify fleet) wins over the env-global proxy.
    const raw = this.proxyOverride ?? process.env.UNIVERSAL_BOT_PROXY_URL;
    if (raw === undefined || raw.trim().length === 0) return null;

    let proxy: ProxySettings;
    try {
      proxy = parseProxyUrl(raw);
    } catch (err) {
      console.error(
        `[operator] UNIVERSAL_BOT_PROXY_URL is malformed — running ` +
          `direct: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const forceAlways = process.env.UNIVERSAL_BOT_PROXY_ALWAYS === "true";
    // detectAsn is best-effort (5s timeout, null on failure) → "unknown".
    const asn = await detectAsn();
    const asnClass: AsnClass = asn?.class ?? "unknown";
    if (shouldRouteThroughProxy(asnClass, forceAlways)) {
      // Proxy liveness probe. A dead proxy (gost crashed, Tailscale down) makes
      // EVERY navigation time out for 60s and silently breaks the whole heal
      // pass — MEASURED 2026-06-12: the Mac gost SOCKS5 went down and every
      // discover died on page.goto Timeout. A cheap TCP connect to the SOCKS
      // host tells us it's reachable; if not, fall back to DIRECT (the box's own
      // datacenter egress) so the run still serves the services that don't block
      // datacenter IPs, instead of dying entirely. Self-healing > silent stall.
      const reachable = await isProxyReachable(proxy.server);
      if (!reachable) {
        console.error(
          `[operator] proxy ${proxy.server} is UNREACHABLE — falling back to ` +
            `DIRECT egress (datacenter IP; anti-bot services may block it, but far ` +
            `better than every navigation timing out)`,
        );
        return null;
      }
      console.error(
        `[operator] routing through residential proxy ` +
          `(asn=${asnClass}${forceAlways ? ", forced" : ""})`,
      );
      return proxy;
    }
    console.error(
      `[operator] direct connection (asn=${asnClass}) — proxy ` +
        `configured but not needed for this network`,
    );
    return null;
  }

  // Reload the current page. Used by the post-verify flow to make a SPA
  // re-read a server-side state change (email verified) that the client
  // hasn't picked up yet. Best-effort: a reload failure is non-fatal — the
  // caller re-reads the page state regardless.
  async reload(): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      // reload failed (slow SPA / transient) — caller re-inspects anyway
    }
  }

  // Open the first conversation in a Gmail search-results list so the email
  // BODY renders. The results LIST only carries snippets + Gmail chrome links —
  // a magic/verification LINK lives in the body and is absent until the mail is
  // opened, so await_verification could never read it from the list. Best-effort:
  // returns true if a conversation opened (URL hash gained a message id).
  // MEASURED 2026-07-01 (Loops "Login link": list view had no /api/auth/callback
  // href; opening the mail revealed it).
  async openFirstMailResult(): Promise<boolean> {
    if (!this.page) return false;
    const before = this.page.url();
    // Find the conversation ROW the same way the observation layer does — a
    // role=link element with a substantial subject label (Gmail chrome
    // affordances like "Gmail"/"Compose"/"Inbox" are short or not role=link) —
    // and open it with this.click(), the SAME positional click that works
    // interactively. The prior CSS-selector + synthetic .click() missed: Gmail
    // rows are div[role=link] whose delegated jsaction handler a plain click may
    // not fire. MEASURED 2026-07-01 (Loops "Login link": the results list has no
    // /api/auth/callback href; opening the row reveals it).
    const els = await this.extractInteractiveElements();
    const row = els.find(
      (e) =>
        e.role === "link" &&
        (e.visibleText ?? e.ariaLabel ?? e.labelText ?? "").trim().length > 25,
    );
    if (row === undefined) return false;
    await this.click(row.selector).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const now = this.page.url();
      // An opened conversation appends a message id to the #search/#inbox hash.
      if (now !== before && /\/[A-Za-z0-9_-]{12,}$/.test(now)) return true;
      await this.page.waitForTimeout(300).catch(() => {});
    }
    return false;
  }

  async goto(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Retry transient network/proxy drops. A residential SOCKS tunnel
    // intermittently resets a connection mid-navigation (Chrome surfaces
    // net::ERR_SOCKS_CONNECTION_FAILED / ERR_CONNECTION_RESET / ERR_NETWORK_
    // CHANGED / ERR_TIMED_OUT), especially on heavy onboarding pages that
    // open many subresource connections at once (algolia's dashboard_setup).
    // The host is reachable on the next attempt — a single goto failure
    // shouldn't fail the whole signup. Only retry these connection-level
    // errors; HTTP statuses and selector/logic errors fall straight through.
    // net::ERR_ABORTED — a navigation superseded by a redirect/JS-nav during
    // the domcontentloaded wait. Usually transient (a redirect race on the
    // first hit of an auth-gated portal — MEASURED 2026-06-11: defang's
    // portal.defang.io aborted on the initial goto); a retry lands the
    // settled page. Distinct from ERR_CONNECTION_ABORTED (a dropped socket).
    const TRANSIENT_NET =
      /ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_(?:RESET|CLOSED|FAILED|ABORTED)|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|net::ERR_EMPTY_RESPONSE|net::ERR_ABORTED/i;
    const MAX_GOTO_ATTEMPTS = 3;
    const sameOriginPathAndSearch = (a: string, b: string): boolean => {
      try {
        const left = new URL(a);
        const right = new URL(b);
        return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
      } catch {
        return false;
      }
    };
    const landedAuthGateForTarget = (landedRaw: string, targetRaw: string): boolean => {
      try {
        const landed = new URL(landedRaw);
        const target = new URL(targetRaw);
        if (landed.origin !== target.origin) return false;
        return /\/(?:sign[_-]?in|login|log[_-]?in|auth)(?:\/|$)/i.test(landed.pathname);
      } catch {
        return false;
      }
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        // A SOCKS/connection drop does NOT always throw: Chrome resolves
        // domcontentloaded on its own `chrome-error://chromewebdata/`
        // interstitial and goto returns cleanly. The bot then ran the whole
        // planner on a dead error page and gave up after one round (MEASURED
        // 2026-06-11: galileo/lancedb landed on chrome-error with the app
        // host as the title, never retried). Treat a chrome-error landing as
        // the same transient class and retry it like a thrown net error.
        const landed = this.page.url();
        if (landed.startsWith("chrome-error://")) {
          if (attempt >= MAX_GOTO_ATTEMPTS) {
            throw new Error(
              `net::navigation landed on a Chrome error page for ${url} ` +
                `after ${attempt} attempts (transient proxy/host failure)`,
            );
          }
          await this.sleep(1500 * attempt);
          continue;
        }
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Some client-routed apps commit the address bar to the requested SPA
        // route but never fire the lifecycle event Playwright is waiting for.
        // Treat that as a successful navigation: callers immediately inspect
        // the DOM and have their own element-level waits.
        if (/Timeout \d+ms exceeded/i.test(msg)) {
          await this.sleep(500);
          if (sameOriginPathAndSearch(this.page.url(), url)) break;
          if (landedAuthGateForTarget(this.page.url(), url)) break;
          await this.page
            .waitForURL((landed) => sameOriginPathAndSearch(landed.toString(), url), { timeout: 5000 })
            .then(() => undefined)
            .catch(() => undefined);
          if (sameOriginPathAndSearch(this.page.url(), url)) break;
          if (landedAuthGateForTarget(this.page.url(), url)) break;
        }
        if (attempt >= MAX_GOTO_ATTEMPTS || !TRANSIENT_NET.test(msg)) throw err;
        // Linear backoff — give the tunnel a moment to recover a slot.
        await this.sleep(1500 * attempt);
      }
    }
    // Post-load dwell. Cloudflare/reCAPTCHA scoring runs JS that
    // collects behavior signals over a window (typically 500-2000ms);
    // landing on a page and immediately interacting reads as bot-like.
    // The "dwell" gives the scoring window enough wall-clock to settle
    // and also gives any deferred JS time to register event listeners
    // we'll later fire.
    if (this.humanize) {
      await this.sleep(rand(800, 2000));
    }
  }

  // Pre-warm a domain by visiting its root. Useful before navigating
  // to a deep signup URL on a strict-Cloudflare service: the root sets
  // first-party cookies and lets the bot-scoring JS calibrate on a
  // benign page before we hit anything sensitive.
  //
  // `mode`:
  //   - "fast" (default): visit the root, dwell ~2s, jitter the mouse,
  //     done. Cheap and adequate when the domain has been warmed
  //     recently (cookies already in jar, prior session in the
  //     scoring JS's memory).
  //   - "referrer-chain": simulate a research session — Google search
  //     → click the brand result → scroll the marketing site →
  //     navigate. ~20-40s of wall clock, but builds a realistic
  //     browsing-history signal that v3 weighs heavily. Use this on
  //     first-attempt against strict services and after a captcha
  //     failure.
  async prewarm(
    url: string,
    mode: "fast" | "referrer-chain" = "fast",
  ): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    if (mode === "referrer-chain") {
      await this.prewarmViaReferrerChain(url);
      return;
    }
    const root = new URL(url).origin;
    await this.page.goto(root, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (this.humanize) {
      await this.sleep(rand(1200, 2500));
      // Tiny mouse jitter so cf_clearance JS sees pointer activity.
      await this.jitterMouse();
    }
  }

  // Simulates a research session that ends at the signup target.
  //
  // Why this is more than theater: reCAPTCHA v3 reads a "browsing
  // history" signal that aggregates referrer + dwell + interaction
  // across the prior 1-2 page loads in this context. A cold landing on
  // `/sign_up` has none of that — score gets clamped near 0.3, which
  // is the kill-floor for most v3-protected forms. A simulated
  // Google → result-click → marketing-site → /sign_up chain lifts the
  // score to 0.5-0.7 range, which is where real users sit.
  //
  // Best-effort throughout: if any step fails (Google rate-limits us,
  // the brand's marketing site is down, etc.) we degrade to the fast
  // prewarm rather than aborting the whole signup. Network surprises
  // are common; the bot still works without this lift, just worse.
  private async prewarmViaReferrerChain(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const targetOrigin = new URL(url).origin;
    // Strip "www." for the search query so "postmarkapp.com" becomes
    // "postmarkapp" not "www postmarkapp"; reads more like what a
    // human types into a search box.
    const brand = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(brand + " sign up")}`;

    try {
      await this.page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (this.humanize) await this.sleep(rand(2000, 4000));
      // Look for a result link pointing at the target origin. Google
      // wraps result hrefs but exposes the real destination as a child
      // attribute or via the `href` itself for organic results — we
      // grab whichever link's href starts with the target origin.
      // Google SERPs often expose several anchors to the same origin
      // (the organic result, "People also ask" related links, sitelinks
      // like /pricing). Scope to the first match so Playwright's strict
      // mode doesn't throw before we get to click.
      const resultLocator = this.page.locator(`a[href^="${targetOrigin}"]`).first();
      const hasResult = (await resultLocator.count()) > 0;
      if (hasResult) {
        // Use humanClick if available — moves the mouse along a bezier
        // path to the link, which feeds the scoring JS pointer entropy
        // as a side effect.
        if (this.humanize) {
          await this.humanClickLocator(resultLocator);
        } else {
          await resultLocator.click();
        }
        await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      } else {
        // Couldn't find an organic result (Google sometimes interposes
        // an ad or "people also ask" block first). Navigate directly
        // and accept that the referrer chain is shorter but still
        // includes the search.
        await this.page.goto(targetOrigin, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

      // Marketing-site dwell: scroll a bit, pause, scroll back. The
      // scroll events plus the wall clock build up the "this user is
      // reading" signal. Magnitude is intentionally small — overshooting
      // (scrolling to the bottom in 200ms, etc.) is itself bot-like.
      if (this.humanize) {
        await this.sleep(rand(1500, 3500));
        await this.page.mouse.wheel(0, rand(200, 500));
        await this.sleep(rand(800, 2000));
        await this.page.mouse.wheel(0, rand(-200, 0));
        await this.sleep(rand(1000, 2500));
        await this.jitterMouse();
      }
    } catch (err) {
      // Any step in the chain failing leaves us at *some* page (the
      // search results, the marketing site, an error page) — that's
      // still better than a cold landing on /sign_up. Log and proceed.
      console.error(
        `[operator] referrer-chain prewarm partial failure (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Wait for element to be visible and enabled before typing.
    await this.page.waitForSelector(selector, { state: "visible", timeout: 10000 });

    if (!this.humanize) {
      // Fast path for tests / non-humanized runs.
      await this.page.fill(selector, text);
      return;
    }

    // Humanized typing:
    //   - Click into the field first (moves mouse, generates focus event)
    //   - pressSequentially focuses ONCE and types each char with a
    //     per-key delay. Page-driven focus changes between characters
    //     (multi-input OTP forms, auto-advance fields) are honoured —
    //     the next char goes to whatever has focus when it fires.
    //
    // page.fill() bypasses keydown/keypress/input events entirely — it
    // sets value via JS. That's a giant red flag to behavior scoring.
    // pressSequentially emits real key events so the page sees a normal
    // typing pattern.
    //
    // rc.29 — the prior implementation looped `locator.pressSequentially(
    // ch)` per character, which RE-FOCUSED the locator on every call.
    // For multi-input OTP forms (Porter, Koyeb / WorkOS: 8 inputs each
    // maxlength=1), every character landed in the FIRST input and got
    // discarded after char 1. Switching to a single pressSequentially
    // call lets the browser's auto-advance handler move focus naturally.
    await this.humanClick(selector);
    const locator = this.page.locator(selector);
    // Clear any prefilled value before typing. Only meaningful for
    // single-input fields; multi-input OTP forms ignore this since
    // each box is its own input.
    await locator.fill("").catch(() => {});
    // Per-key delay matches the prior bursty distribution. The
    // periodic "thinking pause" the prior loop applied is folded into
    // the delay variability — pressSequentially has no built-in pause
    // hook, and over-engineering it added zero observable behavior-
    // score improvement.
    await locator.pressSequentially(text, { delay: rand(40, 110) });
  }

  // Best-effort scan for the SPECIFIC unfilled required field(s) blocking a
  // disabled submit. Returns a " Unfilled required field(s) — …" suffix for the
  // disabled-click error so the planner fills the right field instead of
  // re-clicking the dead button. Pure observation — never throws, never mutates.
  private async unfilledRequiredHint(): Promise<string> {
    if (!this.page) return "";
    try {
      const fields = await this.page.evaluate(() => {
        const out: string[] = [];
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const label = (el: Element): string => {
          const al = el.getAttribute("aria-label");
          if (al && al.trim()) return al.trim().slice(0, 40);
          const id = (el as HTMLElement).id;
          if (id) {
            const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
            const lab = document.querySelector(`label[for="${esc}"]`);
            if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim().slice(0, 40);
          }
          const ph = el.getAttribute("placeholder");
          if (ph && ph.trim()) return ph.trim().slice(0, 40);
          return (el.getAttribute("name") ?? el.tagName.toLowerCase()).slice(0, 40);
        };
        for (const el of Array.from(
          document.querySelectorAll(
            "input[required],textarea[required],input[aria-required='true'],textarea[aria-required='true']",
          ),
        )) {
          if (!vis(el)) continue;
          const inp = el as HTMLInputElement;
          if (inp.type === "checkbox" || inp.type === "radio") {
            if (!inp.checked) out.push(`unchecked: ${label(el)}`);
          } else if (!inp.value || !inp.value.trim()) {
            out.push(`empty: ${label(el)}`);
          }
        }
        for (const el of Array.from(document.querySelectorAll("select"))) {
          if (vis(el) && !(el as HTMLSelectElement).value) out.push(`unselected: ${label(el)}`);
        }
        for (const el of Array.from(document.querySelectorAll("[role='combobox'],[role='listbox']"))) {
          if (!vis(el)) continue;
          const txt = (el.textContent ?? "").trim();
          if (txt.length === 0 || /^(select|choose|please|pick)\b/i.test(txt)) out.push(`unselected: ${label(el)}`);
        }
        for (const grp of Array.from(document.querySelectorAll("[role='radiogroup']"))) {
          if (!vis(grp)) continue;
          const chosen = grp.querySelector(
            "[role='radio'][aria-checked='true'],input[type='radio']:checked",
          );
          if (!chosen) out.push(`nothing chosen: ${label(grp)}`);
        }
        return Array.from(new Set(out)).slice(0, 5);
      });
      return fields.length > 0
        ? ` Unfilled required field(s) — fill/select these first: ${fields.join("; ")}.`
        : "";
    } catch {
      return "";
    }
  }

  // Read any visible transient toast / alert / notification text. Validation
  // errors, rate-limits, and "operation failed" messages frequently appear as a
  // toast that auto-dismisses BEFORE the next round's capture — so a failed
  // submit looks like a SILENT no-op to the planner. Surfacing it turns the
  // no-op into a diagnosable reason. MEASURED 2026-06-11 (deepseek Sign-up
  // no-ops; the error is a ds-toast the round-start capture never sees).
  // `settleMs` lets the caller reuse a wait it was already going to do.
  async captureTransientAlert(settleMs = 600): Promise<string> {
    if (!this.page) return "";
    if (settleMs > 0) await this.sleep(settleMs);
    try {
      return await this.page.evaluate(() => {
        const sels = [
          "[role='alert']",
          "[aria-live='assertive']",
          ".ds-toast-container",
          ".ds-notification-container",
          ".Toastify__toast",
          ".ant-message-notice",
          ".ant-notification-notice",
          ".sonner-toast",
          "[data-sonner-toast]",
          ".toast",
          ".Toaster",
        ];
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!vis(el)) continue;
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t.length >= 2 && t.length <= 240) return t;
          }
        }
        // Second pass: INLINE field-validation errors (not a transient
        // toast). Many SPAs render "Please enter the verification code" /
        // "Invalid code" as a small element with an error-ish class or an
        // aria-invalid node rather than a toast — so the first pass misses
        // them and a failed submit reads as a silent no-op.
        // MEASURED 2026-06-11 (deepseek post-OTP submit).
        const errSels = [
          "[class*='error' i]",
          "[class*='invalid' i]",
          "[class*='danger' i]",
          "[class*='explain' i]", // antd/ds-form-item-explain
          "[aria-invalid='true']",
        ];
        for (const sel of errSels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!vis(el)) continue;
            // Leaf-ish only — skip containers that wrap the whole form.
            if (el.querySelector("input, button, form")) continue;
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t.length >= 3 && t.length <= 160) return t;
          }
        }
        return "";
      });
    } catch {
      return "";
    }
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Radio/checkbox inputs — especially the visually-hidden kind behind a
    // styled label (kinde's `kui-util-hide-visually` SDK-picker radios) — don't
    // respond to a positional click: Playwright can't click an invisible
    // element, and even a label click may not fire the `change` handler a gated
    // control depends on (kinde's radio `kui-on-change` enables the otherwise-
    // disabled Next button). Playwright's check() toggles the control AND
    // dispatches input/change; `force` bypasses the visibility actionability
    // gate for the sr-only pattern. MEASURED 2026-06-09 (kinde tech-stack step).
    try {
      const probe = await this.page
        .$eval(selector, (el) => {
          const t = el as HTMLInputElement;
          const inputKind =
            t.tagName === "INPUT" && (t.type === "radio" || t.type === "checkbox") ? t.type : "";
          // The planner's selector often resolves to a CHILD of the real option
          // (the inner <span> with the visible text, or a positional wrapper), not
          // the role=option element itself. Walk up to the nearest combobox-option
          // ancestor so the role-based re-resolution below fires. cmdk items carry
          // role=option but the `[cmdk-item]` attribute is the most stable tell.
          // MEASURED 2026-06-16 (meilisearch /welcome-informations cmdk multi-
          // select): a plain getByRole("option",{name}).click() COMMITS the value
          // — the trigger updates + Next un-gates — but only when we target the
          // option element, not its child span (which a raw coordinate click drops).
          const optEl = el.closest(
            '[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item]',
          );
          const optRole = optEl !== null ? optEl.getAttribute("role") ?? "option" : "";
          const optText = optEl !== null ? (optEl.textContent ?? "").trim().slice(0, 80) : "";
          return {
            inputKind,
            role: el.getAttribute("role") ?? "",
            text: (el.textContent ?? "").trim().slice(0, 80),
            optRole,
            optText,
          };
        })
        .catch(() => ({ inputKind: "", role: "", text: "", optRole: "", optText: "" }));
      const inputKind = probe.inputKind;
      // Custom-combobox / listbox options (role=option|menuitem) — react-select,
      // Radix, downshift, cmdk, MUI. Two failure modes the humanized RAW-COORDINATE
      // click hits: (1) the menu is a PORTAL that re-renders/repositions, so the
      // captured POSITIONAL selector (e.g. `div…>> nth=42`) resolves to the wrong
      // element at click time — nothing selects, planner loops (MEASURED
      // 2026-06-11, meilisearch Radix combobox); (2) options bind pointer/select
      // handlers a raw coordinate click misses. Fix: re-resolve by role+accessible
      // name (robust to portal/positional drift + the planner targeting a child),
      // and use the actionability-checked locator click. Options are post-load,
      // NOT the anti-bot-scored gate.
      const optRole =
        probe.role === "option" || probe.role === "menuitem" || probe.role === "menuitemradio"
          ? probe.role
          : probe.optRole === "option" || probe.optRole === "menuitem" || probe.optRole === "menuitemradio"
            ? probe.optRole
            : "";
      const optName = probe.role !== "" ? probe.text : probe.optText;
      if (optRole !== "") {
        const role = optRole as "option" | "menuitem" | "menuitemradio";
        if (optName.length > 0) {
          const byName = this.page.getByRole(role, { name: optName, exact: false }).first();
          if ((await byName.count().catch(() => 0)) > 0) {
            await byName.click({ timeout: 8000 });
            return;
          }
        }
        await this.page.locator(selector).first().click({ timeout: 8000 });
        return;
      }
      if (inputKind === "radio" || inputKind === "checkbox") {
        // check() handles standard inputs; but a custom framework (kinde's kui)
        // binds its change handler via event delegation, and a force-check on an
        // sr-only radio may not fire a bubbling change. Belt-and-suspenders:
        // check(), then JS-ensure checked + dispatch bubbling input/change so the
        // delegated handler (e.g. enable-the-gated-Next-button) fires AND the
        // value is included on submit. MEASURED 2026-06-09 (kinde SDK picker).
        await this.page.check(selector, { force: true }).catch(() => undefined);
        await this.page
          .$eval(selector, (el) => {
            const r = el as HTMLInputElement;
            if (!r.checked) r.checked = true;
            r.dispatchEvent(new Event("input", { bubbles: true }));
            r.dispatchEvent(new Event("change", { bubbles: true }));
            r.dispatchEvent(new Event("click", { bubbles: true }));
          })
          .catch(() => undefined);
        return;
      }
      // ARIA toggle: a <button role="switch"> / role="checkbox" (Firebase's
      // Google-provider "Enable" switch, MUI/Material toggles). A synthetic
      // positional click frequently does NOT flip these — the handler binds to a
      // keydown/pointer sequence the raw click misses, so click() returns but
      // aria-checked never changes. The ARIA-correct activation is the keyboard:
      // focus + Space. Click first (cheap); if aria-checked didn't move, focus
      // and press Space. MEASURED 2026-06-27 (Firebase auth Enable switch).
      if (probe.role === "switch" || probe.role === "checkbox") {
        const node = this.page.locator(selector).first();
        const readChecked = (): Promise<string | null> =>
          node.getAttribute("aria-checked").catch(() => null);
        const before = await readChecked();
        await node.click({ timeout: 8000 }).catch(() => undefined);
        if ((await readChecked()) === before) {
          await node.focus().catch(() => undefined);
          await this.page.keyboard.press("Space").catch(() => undefined);
          if ((await readChecked()) === before) {
            await this.page.keyboard.press("Enter").catch(() => undefined);
          }
        }
        return;
      }
    } catch {
      // element vanished / selector didn't resolve — fall through to a click
    }
    if (!this.humanize) {
      await this.page.click(selector);
      return;
    }
    await this.humanClick(selector);
  }

  // Force-click bypasses Playwright's actionability + interception checks — for a
  // button that is visible / enabled / stable but whose pointer events are eaten
  // by a modal-dialog backdrop layered over it (MUI `<div class="MuiDialog-
  // container">`, e.g. deepinfra's new-API-key dialog). A normal click() there
  // times out with "intercepts pointer events"; force dispatches at the element.
  async clickForce(selector: string, index = 0): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const safeIndex = Math.max(0, Math.floor(index));
    await this.page.locator(selector).nth(safeIndex).click({ force: true, timeout: 8000 });
  }

  // Dispatch a DOM .click() in the page context. Some React copy buttons fire
  // their onClick (and thus navigator.clipboard.writeText) on the synthetic
  // event a real Playwright mouse click doesn't reliably reproduce (deepinfra's
  // "copy key": a JS click populated the clipboard in a probe where the
  // positional click did not). Used as a copy-extraction fallback; the preceding
  // real click supplies the transient user-activation writeText needs.
  async clickViaJs(selector: string, index = 0): Promise<void> {
    if (!this.page) return;
    const safeIndex = Math.max(0, Math.floor(index));
    await this.page
      .evaluate(
        ({ sel, i }) => {
          const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
          const el = els[i] ?? els[0];
          if (el !== undefined) el.click();
        },
        { sel: selector, i: safeIndex },
      )
      .catch(() => undefined);
  }

  async clickNth(selector: string, index: number): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const safeIndex = Math.max(0, Math.floor(index));
    const locator = this.page.locator(selector).nth(safeIndex);
    await locator.click({ timeout: 8000 });
  }

  // Click a link/button by its visible text. Used for one-off
  // dismissibles where the bot knows the literal label text and
  // doesn't need full inventory ranking (e.g. GitHub's "skip 2FA
  // verification at this moment" link on the post-handshake 2FA
  // sanity page). Case-insensitive substring match — GitHub
  // occasionally tweaks capitalization on the same link.
  //
  // Returns true on successful click, false when the text isn't on
  // the page within the timeout. Doesn't throw on miss — caller
  // decides whether to fall back to abort.
  async clickLinkByText(text: string, timeoutMs = 3000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      // Escape regex metacharacters in the user-supplied label text so
      // a literal "(2FA)" or "." doesn't get interpreted as a pattern.
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const locator = this.page
        .getByText(new RegExp(escaped, "i"))
        .first();
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      if (this.humanize) {
        await this.humanClickLocator(locator);
      } else {
        await locator.click();
      }
      return true;
    } catch {
      return false;
    }
  }

  // Click the form's submit button, disambiguating when the planned
  // selector matches several elements. Signup pages routinely render
  // OAuth buttons ("Continue with Google" / "GitHub") as
  // button[type=submit] alongside the real submit — and a Playwright
  // locator is strict-mode, so a plain click on a multi-match selector
  // throws "strict mode violation". We score the candidates by visible
  // text and click the best, or throw a clear error when none reads as
  // a signup button (e.g. an OAuth-only page).
  async clickSubmit(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.3-rc.1 — wait for the submit selector to appear before
    // querying count. Mixpanel-class SPAs (Next.js + heavy auth JS)
    // race past the 10s `waitForSelector` in click() and bail with
    // `locator.waitFor: Timeout 10000ms exceeded` even when the form
    // is otherwise correct. Polling here gives the SPA time to
    // mount the submit button BEFORE we check whether it's disabled.
    // Best-effort: a genuine miss still surfaces as the click()'s
    // own timeout downstream.
    try {
      await this.page.waitForSelector(selector, {
        state: "attached",
        timeout: 20000,
      });
    } catch {
      // fall through — click() below will produce the canonical error
    }
    const locator = this.page.locator(selector);
    // The count can throw "Execution context was destroyed" when an
    // earlier fill already triggered a navigation/auto-submit (zilliz:
    // typing email+password redirects before we reach the submit click).
    // That race must NOT crash the whole signup — the page is already
    // moving on, so treat the submit as effectively done and let the
    // caller inspect the new page. MEASURED 2026-06-11 (zilliz /signup).
    const count = await locator.count().catch(() => -1);
    if (count < 0) {
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      return;
    }
    // A disabled submit means a required field or agreement checkbox
    // wasn't satisfied — throw a distinct `submit_disabled` so the
    // caller can re-plan to fix it, rather than wait out a generic
    // visibility timeout (SendPulse: #btn-reg stays disabled +
    // hidden until the TOS box is ticked).
    if (count >= 1) {
      const disabled = await locator
        .first()
        .isDisabled()
        .catch(() => false);
      if (disabled) {
        throw new Error(
          `submit_disabled: the submit button (${selector}) is disabled — a ` +
            `required field or agreement checkbox was not satisfied`,
        );
      }
    }
    // 0 or 1 match: the normal click path handles it (and surfaces a
    // clean "waiting for selector" timeout when the count is 0).
    if (count <= 1) {
      await this.click(selector);
      return;
    }
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      texts.push(((await locator.nth(i).textContent()) ?? "").trim());
    }
    const best = pickSubmitButtonIndex(texts);
    if (best === null) {
      throw new Error(
        `submit selector "${selector}" matched ${count} buttons, none scoring ` +
          `as a signup button (texts: ${texts.map((t) => JSON.stringify(t)).join(", ")})`,
      );
    }
    const chosen = locator.nth(best);
    if (this.humanize) {
      await this.humanClickLocator(chosen);
    } else {
      await chosen.click();
    }
  }

  async check(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Use force:true because TOS checkboxes are sometimes visually covered by
    // a custom label/styled wrapper but the underlying input is checkable.
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    // Bring it into the viewport first — MongoDB/Sentry signup
    // checkboxes sit below the fold and a bezier mouse-click misses
    // an off-screen element (F3 T6).
    await this.page
      .locator(selector)
      .scrollIntoViewIfNeeded({ timeout: 5000 })
      .catch(() => {});
    if (!this.humanize) {
      await this.page.check(selector, { force: true }).catch(() => undefined);
      if (await this.ensureChecked(selector)) return;
      throw new Error(`Unable to check selector "${selector}" after label and DOM fallbacks`);
    }
    // For visible checkboxes, move the mouse to it first (a real user
    // would). For force-checked invisible ones, fall back to the
    // Playwright API so we don't try to mouse-click an offscreen element.
    await this.humanClick(selector).catch(() => undefined);
    await this.page.check(selector, { force: true }).catch(() => undefined);
    if (await this.ensureChecked(selector)) return;
    throw new Error(`Unable to check selector "${selector}" after click, label, and DOM fallbacks`);
  }

  private async ensureChecked(selector: string): Promise<boolean> {
    if (!this.page) return false;
    if (await this.page.locator(selector).isChecked().catch(() => false)) return true;

    await this.clickAssociatedLabel(selector).catch(() => false);
    if (await this.page.locator(selector).isChecked().catch(() => false)) return true;

    const domChecked = await this.page
      .locator(selector)
      .first()
      .evaluate((el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        if (el.type !== "checkbox" && el.type !== "radio") return false;
        if (!el.checked) {
          el.click();
        }
        if (!el.checked) {
          el.checked = true;
          el.setAttribute("checked", "");
          el.setAttribute("aria-checked", "true");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return el.checked;
      })
      .catch(() => false);
    if (!domChecked) return false;
    return await this.page.locator(selector).isChecked().catch(() => false);
  }

  // Click the <label> associated with a checkbox/radio input — either a
  // `<label for="<id>">` or the wrapping `<label>` ancestor. Mantine/Radix
  // render the real input visually-hidden inside a styled label; clicking the
  // label is what fires the library's onChange (a direct input check can
  // leave React's controlled state stale). Returns true if a label was
  // found + clicked. Best-effort — never throws.
  private async clickAssociatedLabel(selector: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      const id = await this.page
        .locator(selector)
        .first()
        .evaluate((el) => (el instanceof HTMLElement ? el.id : ""))
        .catch(() => "");
      if (id) {
        const forLabel = this.page.locator(`label[for="${id}"]`).first();
        if ((await forLabel.count()) > 0) {
          await forLabel.click({ timeout: 4000 });
          return true;
        }
      }
      // No `for=` label — try the wrapping <label> ancestor.
      const wrapping = this.page.locator(selector).locator("xpath=ancestor::label[1]").first();
      if ((await wrapping.count()) > 0) {
        await wrapping.click({ timeout: 4000 });
        return true;
      }
      // Some Radix/shadcn-style controls render the hidden input as a sibling
      // of the visible agreement label, with no `for=` and no wrapping label
      // (Mistral's terms checkbox). At this point direct check has already
      // failed/not toggled, so clicking the nearest agreement-shaped label in
      // the same form is the safest remaining human-equivalent action.
      const clickedAgreement = await this.page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const agreementRe =
            /terms|tos\b|privacy|policy|i accept|i agree|agree to/i;
          const form = el.closest("form");
          const labels = [
            ...(form ? Array.from(form.querySelectorAll("label")) : []),
            ...Array.from(document.querySelectorAll("label")),
          ];
          const label = labels.find((candidate) =>
            agreementRe.test(candidate.textContent ?? ""),
          );
          if (!(label instanceof HTMLElement)) return false;
          label.click();
          return true;
        })
        .catch(() => false);
      if (clickedAgreement) {
        return true;
      }
    } catch {
      // best-effort
    }
    return false;
  }

  // Deterministic pre-submit guard: tick every visible, unchecked,
  // non-disabled REQUIRED-AGREEMENT checkbox (terms/privacy/consent),
  // while never touching marketing/newsletter opt-ins.
  //
  // Why this exists separate from the LLM planner: amplitude's signup
  // has a required TOS checkbox the planner skipped (it read the
  // adjacent data-storage card-radios as the whole cluster being
  // "ambiguous radios"), and amplitude does NOT disable submit when the
  // box is unticked — so the click silently no-ops and the bot then
  // waits forever for a verification mail that never sends. This runs on
  // EVERY submit, not only the `submit_disabled` path in clickSubmit().
  //
  // Returns the labels/testids it checked (for step logging); empty when
  // it ticked nothing.
  async checkRequiredAgreementBoxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    // Best-effort: a page-eval failure (navigation mid-call, detached
    // frame) must never fail the parent submit — return nothing.
    try {
      return await this.page.evaluate(() => {
        // These two regexes MUST stay byte-identical with
        // AGREEMENT_TEXT_RE / MARKETING_TEXT_RE in this module — the
        // page realm can't import, so they're inlined here.
        const agreementRe =
          /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr|age|18\+|18 years|certif/i;
        const marketingRe =
          /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;

        const checked: string[] = [];
        const boxes = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="checkbox"]',
          ),
        );
        for (const box of boxes) {
          if (box.checked || box.disabled) continue;
          const rect = box.getBoundingClientRect();
          const ancestorLabel = box.closest("label");
          const labelRect = ancestorLabel?.getBoundingClientRect();
          const visible =
            (rect.width > 0 && rect.height > 0) ||
            (labelRect !== undefined && labelRect.width > 0 && labelRect.height > 0);
          if (!visible) continue;

          // Associated text = attributes + a label[for=id] + nearest
          // ancestor <label> + the immediately following sibling text.
          const parts: string[] = [
            box.getAttribute("data-testid") ?? "",
            box.getAttribute("name") ?? "",
            box.id,
            box.getAttribute("aria-label") ?? "",
          ];
          if (box.id) {
            const forLabel = document.querySelector(
              `label[for="${CSS.escape(box.id)}"]`,
            );
            if (forLabel) parts.push(forLabel.textContent ?? "");
          }
          if (ancestorLabel) parts.push(ancestorLabel.textContent ?? "");
          const sibling = box.nextSibling;
          if (sibling && sibling.textContent) parts.push(sibling.textContent);
          if (box.nextElementSibling) {
            parts.push(box.nextElementSibling.textContent ?? "");
          }

          const text = parts.join(" ");
          if (!agreementRe.test(text) || marketingRe.test(text)) continue;

          // React/Vue controlled inputs ignore a bare `.checked = true`:
          // their state lives in the framework, updated only by the real
          // event flow. Click first (while unchecked) so the framework sees the
          // same transition a user would make, then force-ensure checked and
          // dispatch input/change for styled/hidden inputs whose click target
          // does not toggle the underlying control.
          box.click();
          if (!box.checked) box.checked = true;
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));

          const label =
            box.getAttribute("data-testid") ||
            box.getAttribute("name") ||
            box.id ||
            box.getAttribute("aria-label") ||
            "agreement-checkbox";
          checked.push(label);
        }
        return checked;
      });
    } catch {
      return [];
    }
  }

  // Deterministic pre-submit guard for required signup category choices.
  //
  // Paddle-class forms ask a required "What do you sell?" question where one
  // product category must be selected before account creation, but the submit
  // button remains enabled. The planner can satisfy the agreement checkbox and
  // still skip the category, producing a rejected submit + no verification mail.
  //
  // Keep this conservative: only fire when the page text explicitly says a
  // product/category choice is required, never touch agreement/marketing boxes,
  // and prefer low-risk SaaS/software labels over restricted categories.
  async checkRequiredSignupChoiceBoxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        const choiceGateRe =
          /what do you sell|categories we support|select which types? of products|choose (?:a|your) (?:category|product|business type)|product category|business category/i;
        const safeChoiceRe =
          /digital products?|saas|software|developer tools?|apis?|mobile apps?|data|analytics/i;
        const riskyChoiceRe =
          /gambling|financial services?|physical products?|marketplace|human services?|adult|weapons?|medical|restricted|crypto|payments?|banking/i;
        const agreementRe =
          /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr/i;
        const marketingRe =
          /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;

        const bodyText = document.body?.innerText ?? "";
        if (!choiceGateRe.test(bodyText)) return [];

        const associatedText = (box: HTMLInputElement): string => {
          const parts: string[] = [
            box.getAttribute("data-testid") ?? "",
            box.getAttribute("name") ?? "",
            box.id,
            box.getAttribute("aria-label") ?? "",
          ];
          if (box.id) {
            const forLabel = document.querySelector(
              `label[for="${CSS.escape(box.id)}"]`,
            );
            if (forLabel) parts.push(forLabel.textContent ?? "");
          }
          const ancestorLabel = box.closest("label");
          if (ancestorLabel) parts.push(ancestorLabel.textContent ?? "");
          if (box.nextElementSibling) {
            parts.push(box.nextElementSibling.textContent ?? "");
          }
          return parts.join(" ").replace(/\s+/g, " ").trim();
        };

        const boxes = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="checkbox"], input[type="radio"]',
          ),
        );
        const visibleBoxes = boxes.filter((box) => {
          if (box.disabled) return false;
          const rect = box.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        const alreadyChoseCategory = visibleBoxes.some((box) => {
          if (!box.checked) return false;
          const text = associatedText(box);
          return (
            !agreementRe.test(text) &&
            !marketingRe.test(text) &&
            !riskyChoiceRe.test(text)
          );
        });
        if (alreadyChoseCategory) return [];

        const candidates = visibleBoxes
          .filter((box) => !box.checked)
          .map((box) => ({ box, text: associatedText(box) }))
          .filter(({ text }) => {
            if (!text) return false;
            if (agreementRe.test(text) || marketingRe.test(text)) return false;
            if (riskyChoiceRe.test(text)) return false;
            return safeChoiceRe.test(text);
          })
          .sort((a, b) => {
            const score = (text: string): number => {
              if (/digital products?|saas|software/i.test(text)) return 3;
              if (/developer tools?|apis?|data|analytics/i.test(text)) return 2;
              if (/mobile apps?/i.test(text)) return 1;
              return 0;
            };
            return score(b.text) - score(a.text);
          });
        const choice = candidates[0];
        if (!choice) return [];

        choice.box.checked = true;
        choice.box.dispatchEvent(new Event("input", { bubbles: true }));
        choice.box.dispatchEvent(new Event("change", { bubbles: true }));
        choice.box.click();
        return [
          choice.box.getAttribute("data-testid") ||
            choice.box.getAttribute("name") ||
            choice.box.id ||
            choice.box.getAttribute("aria-label") ||
            choice.text ||
            "signup-choice",
        ];
      });
    } catch {
      return [];
    }
  }

  // Scroll a Terms-of-Service style modal to the bottom so the gated
  // "Accept" button enables. Railway's signup is the canonical case:
  // a modal with a virtualized ToS list watches real `scroll` /
  // `wheel` events on its container and only flips the button to
  // enabled once `scrollTop + clientHeight ~= scrollHeight`.
  //
  // The post-verify planner has no way to name a non-interactive div
  // (the inventory only carries interactive elements), so when
  // `selector` is omitted this method auto-detects the most plausible
  // scrollable container: the largest visible element with
  // `overflow:auto|scroll` and real scroll headroom. Returns a
  // structured result so the executor can log what it found and the
  // calling planner round can re-plan if nothing was scrollable.
  //
  // Strategy:
  //   1. Resolve a target element (selector or auto-detected).
  //   2. Position the mouse over it and emit a series of `mouse.wheel`
  //      events. Real wheel events fire `scroll` + `wheel` handlers
  //      and walk virtualized lists row by row; a single JS
  //      `scrollTop = scrollHeight` skips them.
  //   3. Fallback: once wheel loop exits, set `scrollTop = scrollHeight`
  //      and dispatch a synthetic `scroll` event. Covers static lists
  //      whose handlers only debounce on the final scroll position.
  // Operator surface — reveal below-the-fold controls so the planner can act on
  // them (heavy SPAs like the GCP console render long forms whose lower fields
  // sit outside the viewport and so never enter the element inventory). Scrolls
  // the page by ~80% of a viewport (or to an extreme); the next observe picks
  // up the newly-visible elements.
  async scrollViewport(direction: "down" | "up" | "bottom" | "top" = "down"): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.evaluate((dir: string) => {
      const step = Math.round(window.innerHeight * 0.8);
      if (dir === "bottom") window.scrollTo(0, document.body.scrollHeight);
      else if (dir === "top") window.scrollTo(0, 0);
      else if (dir === "up") window.scrollBy(0, -step);
      else window.scrollBy(0, step);
    }, direction);
    await this.page.waitForTimeout(350);
  }

  async scrollToEndOfTOS(
    selector?: string,
  ): Promise<{
    scrolled: boolean;
    container: string | null;
    reason: "ok" | "no_container" | "already_at_bottom";
  }> {
    if (!this.page) throw new Error("Browser not started");

    // 1. Find the container.
    const target = await this.page.evaluate((sel: string | null) => {
      const scrollableOf = (el: Element): boolean => {
        const s = window.getComputedStyle(el);
        const overflowY = s.overflowY;
        if (overflowY !== "auto" && overflowY !== "scroll") return false;
        return el.scrollHeight > el.clientHeight + 20;
      };
      const visibleArea = (el: Element): number => {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        return w * h;
      };
      const describe = (el: Element): { rect: DOMRect; scrollTop: number; scrollHeight: number; clientHeight: number } => ({
        rect: el.getBoundingClientRect(),
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      if (sel !== null) {
        const explicit = document.querySelector(sel);
        if (explicit === null) return null;
        return describe(explicit);
      }
      // Auto-detect: largest visible scrollable element.
      const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
      const candidates = all.filter(scrollableOf).map((el) => ({
        el,
        area: visibleArea(el),
      }));
      candidates.sort((a, b) => b.area - a.area);
      const winner = candidates[0];
      if (winner === undefined || winner.area < 100) return null;
      return describe(winner.el);
    }, selector ?? null);

    if (target === null) {
      return { scrolled: false, container: null, reason: "no_container" };
    }

    // Already at the bottom on entry — a no-op scroll. Surface this
    // so the executor can hint the planner that whatever is gating
    // the disabled button is NOT scroll position (Railway iter ≥2 on
    // the second ToS modal: planner kept asking for scroll when the
    // form was actually waiting on something else).
    if (
      target.scrollTop + target.clientHeight >=
      target.scrollHeight - 4
    ) {
      return {
        scrolled: false,
        container: selector ?? "auto-detected",
        reason: "already_at_bottom",
      };
    }

    const { rect } = target;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;

    // 2. Move the mouse over the container, then wheel down repeatedly.
    if (this.humanize) {
      await this.bezierMouseTo(cx, cy);
      await this.sleep(rand(80, 200));
    } else {
      await this.page.mouse.move(cx, cy);
    }

    const deltaPerStep = Math.max(200, Math.floor(rect.height * 0.7));
    const maxSteps = 30;
    for (let i = 0; i < maxSteps; i++) {
      await this.page.mouse.wheel(0, deltaPerStep);
      await this.sleep(this.humanize ? rand(60, 180) : 30);
      const atBottom = await this.page.evaluate(
        ({ sel, autoDetected }: { sel: string | null; autoDetected: boolean }) => {
          let el: Element | null;
          if (sel !== null) {
            el = document.querySelector(sel);
          } else {
            // Re-resolve the same way we picked it the first time —
            // the modal we wheeled may have re-rendered (virtualized
            // list mounting new rows), so cache-by-reference would go
            // stale.
            const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
            const overflowing = all.filter((node) => {
              const s = window.getComputedStyle(node);
              if (s.overflowY !== "auto" && s.overflowY !== "scroll") return false;
              return node.scrollHeight > node.clientHeight + 20;
            });
            const visibleArea = (n: Element): number => {
              const r = n.getBoundingClientRect();
              const vw = window.innerWidth;
              const vh = window.innerHeight;
              const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
              const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
              return w * h;
            };
            overflowing.sort((a, b) => visibleArea(b) - visibleArea(a));
            el = overflowing[0] ?? null;
          }
          if (el === null) return true;
          void autoDetected;
          return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        },
        { sel: selector ?? null, autoDetected: selector === undefined },
      );
      if (atBottom) break;
    }

    // 3. JS fallback: pin scrollTop to the end and fire a synthetic
    //    scroll event for handlers that only react on the final
    //    position. No-op if the wheel loop already reached the bottom.
    await this.page.evaluate((sel: string | null) => {
      let el: Element | null;
      if (sel !== null) {
        el = document.querySelector(sel);
      } else {
        const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
        const overflowing = all.filter((node) => {
          const s = window.getComputedStyle(node);
          if (s.overflowY !== "auto" && s.overflowY !== "scroll") return false;
          return node.scrollHeight > node.clientHeight + 20;
        });
        const visibleArea = (n: Element): number => {
          const r = n.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          return w * h;
        };
        overflowing.sort((a, b) => visibleArea(b) - visibleArea(a));
        el = overflowing[0] ?? null;
      }
      if (el === null) return;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, selector ?? null);

    return {
      scrolled: true,
      container: selector ?? "auto-detected",
      reason: "ok",
    };
  }

  // Pick a valid option for either a native <select> OR a custom
  // ARIA combobox (Radix, Headless UI, React Aria, cmdk — F11). The
  // bot must not call type() on a select-shaped element (Sentry,
  // legacy form path: "Element is not an <input>"); modern dashboards
  // increasingly render permission / role / region pickers as
  // <button role="combobox"> that open a <ul role="listbox"> with
  // <li role="option"> children, so Playwright's selectOption fails
  // with "no selectable option" on them.
  //
  // Dispatch: read the element's tag. <select> → native path
  // (existing behavior, picks the first non-placeholder option).
  // Anything else → combobox path (click to open, find role=option,
  // click the chosen one).
  //
  // `optionMatcher` is the planner-supplied text of the option to
  // pick (e.g. "Project: Read"). Case-insensitive substring match
  // against the option's visible text. When undefined, picks the
  // first option — preserves the existing behavior for native
  // selects whose contents are interchangeable (country pickers).
  async selectOption(selector: string, optionMatcher?: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    let activeSelector = selector;
    let tagName = await this.page
      .locator(activeSelector)
      .first()
      .evaluate((node) => node.tagName.toLowerCase());

    // 0.8.2-rc.21 — Railway-class fix. The captured selector frequently
    // points at a `<label>` (the inventory ranker prefers visible-text
    // elements). If that label's `for=` association resolves to a
    // native `<select>`, take the native path instead of routing into
    // selectFromCombobox — native selects don't reveal their options
    // via any DOM pattern in headless Chromium (they're OS-rendered),
    // so the combobox path is guaranteed to fail for them. Without
    // this redirect, every captured Railway/legacy-form `<select>`
    // step replays as "no options found after click."
    if (tagName === "label") {
      const resolved = await this.resolveLabelToInput(activeSelector);
      if (resolved !== activeSelector) {
        const resolvedTag = await this.page
          .locator(resolved)
          .first()
          .evaluate((node) => node.tagName.toLowerCase())
          .catch(() => "");
        if (resolvedTag === "select") {
          activeSelector = resolved;
          tagName = "select";
        }
      } else {
        const rowControl = await this.page
          .locator(activeSelector)
          .first()
          .evaluate((label) => {
            const root =
              label.closest(".n-form-group__row") ??
              label.closest("label")?.parentElement ??
              label.parentElement;
            const control = root?.querySelector<HTMLElement>(
              'select,button[role="combobox"],input[role="combobox"],[role="combobox"]',
            );
            if (control === null || control === undefined) return null;
            const id = control.getAttribute("id");
            if (id !== null && id.length > 0) return `#${CSS.escape(id)}`;
            const testId =
              control.getAttribute("data-qa") ??
              control.getAttribute("data-testid") ??
              control.getAttribute("data-test") ??
              control.getAttribute("data-cy");
            if (testId !== null && testId.length > 0) {
              return `[data-qa="${CSS.escape(testId)}"],[data-testid="${CSS.escape(testId)}"],[data-test="${CSS.escape(testId)}"],[data-cy="${CSS.escape(testId)}"]`;
            }
            return null;
          })
          .catch(() => null);
        if (rowControl !== null) {
          activeSelector = rowControl;
          tagName = await this.page
            .locator(activeSelector)
            .first()
            .evaluate((node) => node.tagName.toLowerCase())
            .catch(() => tagName);
        }
      }
    }

    if (tagName === "select") {
      // Native path. rc.15 — keep value="" options selectable. The
      // Railway workspace dropdown's "No workspace" option is value=""
      // and it IS the right pick for an account-scoped token. The
      // prior implementation filtered empty strings out of the fallback
      // list AND rejected matched value="" picks, so the planner could
      // never reach that option. Now: fallback list keeps every option
      // (with the first option's value, even if empty), and a matched
      // text-based pick is honored verbatim — including empty values.
      const allValues = await this.page
        .locator(`${activeSelector} option`)
        .evaluateAll((opts) =>
          opts.map((o) => (o instanceof HTMLOptionElement ? o.value : "")),
        );
      if (allValues.length === 0) {
        throw new Error(`<select> ${activeSelector} has no selectable option`);
      }
      // Default to the first NON-empty value when the planner gave no
      // hint — historic behavior, kept because "Select…" placeholder
      // options are almost always the wrong default pick.
      const firstReal = allValues.find((v) => v.length > 0);
      let chosenValue: string | undefined =
        firstReal !== undefined ? firstReal : allValues[0];
      if (optionMatcher !== undefined) {
        const matcherLower = optionMatcher.toLowerCase();
        // Returns either a matched value (may be "") or null when no
        // option's text matches. Wrap in an object so we can
        // distinguish "matched to empty value" from "no match".
        const matched = await this.page
          .locator(`${activeSelector} option`)
          .evaluateAll(
            (opts, needle) => {
              const hit = opts
                .filter((o): o is HTMLOptionElement => o instanceof HTMLOptionElement)
                .find((o) => o.textContent?.toLowerCase().includes(needle));
              return hit !== undefined ? { value: hit.value } : null;
            },
            matcherLower,
          );
        if (matched !== null) {
          chosenValue = matched.value;
        }
      }
      if (chosenValue === undefined) {
        throw new Error(`<select> ${activeSelector} has no selectable option`);
      }
      await this.page.selectOption(activeSelector, chosenValue);
      // rc.17 — mark the element as touched so subsequent inventory
      // reads can suppress the DEFAULTED-dropdown warning for it.
      // Without this, a select whose committed value is "" (Railway's
      // "No workspace") keeps tripping the warning every round, and
      // the planner gets stuck in a select→select→… loop trying to
      // satisfy a warning the form has already satisfied.
      await this.page
        .locator(activeSelector)
        .first()
        .evaluate((el) => {
          if (el instanceof HTMLElement) el.setAttribute("data-ts-touched", "1");
        })
        .catch(() => {});
      return;
    }

    // Custom combobox path. Sentry, Radix, Headless UI, React Aria
    // — every modern React picker emits role=option on its items.
    await this.selectFromCombobox(activeSelector, optionMatcher);
  }

  // F11 (+rc.7 hardening): click a combobox trigger, wait for the
  // listbox to open, click an option.
  //
  // Tries option-selector patterns in priority order — each tier
  // targets one combobox-library convention. The text-based final
  // tier catches libraries that ship NO ARIA roles at all.
  //
  //   1. [role=option]            — Radix, Headless UI, React Aria, cmdk
  //   2. [role=menuitem]          — ARIA menu pattern (libs that model
  //                                 a dropdown as a menu)
  //   3. [role=menuitemradio]     — react-select's per-row permission
  //                                 picker shape (rc.15 — Sentry's
  //                                 token-create grid). Identical shape
  //                                 to menuitem for selection purposes,
  //                                 distinct role string. Without this
  //                                 tier Sentry's "Team permission =
  //                                 Admin" never resolves and the loop
  //                                 burns the post-verify budget.
  //   4. [id^="react-select-"]    — defense-in-depth for any react-
  //                                 select instance that drops the
  //                                 role attribute. The id prefix is
  //                                 baked into the library and is the
  //                                 most stable signal short of the
  //                                 role.
  //   5. [role=listbox] li        — listbox container without role
  //                                 attribute on its children
  //   6. text-based (matcher only) — after the trigger click, any newly-
  //                                 visible element whose text matches
  //                                 the planner-supplied label is
  //                                 almost certainly the option. Only
  //                                 enabled when a matcher exists,
  //                                 since "first text on the page"
  //                                 with no matcher would catch
  //                                 unrelated UI text.
  private async selectFromCombobox(
    triggerSelector: string,
    optionMatcher?: string,
  ): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.2-rc.11 — selector normalization. The planner sometimes
    // emits a selector pointing at a `<label for="X">` instead of the
    // associated `<input id="X">` — the label has the visible text
    // ("Project") so the inventory ranking surfaces it as the target.
    // Clicking a label is NOT equivalent to clicking the input for
    // react-select: the synthetic focus DOES move to the input via
    // the `for` association, but no mouse-down lands on the
    // react-select control, so the menu never opens. Resolve the
    // label to its associated input here so downstream tiers (the
    // keyboard fallback in particular) actually see an input target.
    const normalizedSelector = await this.resolveLabelToInput(
      triggerSelector,
    );
    await this.humanClick(normalizedSelector);

    const patternSelectors: readonly string[] = [
      '[role="option"]:visible',
      '[role="menuitem"]:visible',
      '[role="menuitemradio"]:visible',
      'mat-option:visible',
      '.mat-mdc-option:visible',
      '[id^="react-select-"][role*="menu"]:visible',
      '[role="listbox"]:visible li:visible',
    ];
    const triedDescriptors: string[] = [];
    for (const sel of patternSelectors) {
      triedDescriptors.push(sel);
      const locator = this.page.locator(sel);
      try {
        await locator.first().waitFor({ state: "visible", timeout: 1500 });
      } catch {
        continue;
      }
      const count = await locator.count();
      if (count === 0) continue;
      await this.pickComboboxOption(locator, optionMatcher);
      return;
    }

    // 0.8.2-rc.11 — keyboard-driven react-select fallback. Sentry's
    // permission-grid combobox (Project--permission, Team--permission,
    // …) is a react-select 5 instance: clicking the inner <input> only
    // focuses it; the menu opens on keyboard activity. The standard
    // pattern is: Alt+Down (or just type a character) to open + filter,
    // then Enter to commit. Try Alt+Down first so an instance with
    // visible options but no role="option" still works; then if a
    // matcher was given, type-to-filter + Enter so a hidden listbox
    // narrows directly to the right option.
    if (await this.tryReactSelectKeyboardPick(normalizedSelector, optionMatcher)) {
      return;
    }
    triedDescriptors.push("react-select keyboard (Alt+Down, type-to-filter, Enter)");

    // ARIA tiers all empty. Text-based fallback, only if the planner
    // told us WHICH option to pick — without a matcher, "first text
    // on the page" would click unrelated UI.
    if (optionMatcher !== undefined) {
      const byText = this.page.getByText(optionMatcher, { exact: false }).first();
      triedDescriptors.push(`text="${optionMatcher}"`);
      try {
        await byText.waitFor({ state: "visible", timeout: 2000 });
        await this.humanClickLocator(byText);
        await this.wait(0.5);
        return;
      } catch {
        // not found — fall through to error
      }
    }

    throw new Error(
      `combobox ${triggerSelector}` +
        (normalizedSelector !== triggerSelector ? ` (normalized to ${normalizedSelector})` : "") +
        `: no options found after click. ` +
        `Tried: ${triedDescriptors.join(", ")}. ` +
        `The trigger may not have opened a popover, or the popover uses ` +
        `an option pattern this executor doesn't recognize.`,
    );
  }

  // 0.8.2-rc.11 — resolve a `<label for="X">` selector to `#X` so the
  // executor lands on the actual input rather than the label decoration.
  // The planner-emitted inventory line for Sentry's permission grid
  // sometimes targets the label (the visible text is "Project", which
  // lives on the <label>, not the <input>); a click on a label only
  // synthetically focuses its `for` target, which is insufficient to
  // open a react-select menu. Returns the original selector unchanged
  // when the resolution doesn't apply (target isn't a label, has no
  // `for`, or the `for`-id doesn't resolve to an input).
  private async resolveLabelToInput(selector: string): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const resolvedId = await this.page
        .locator(selector)
        .first()
        .evaluate((node) => {
          if (!(node instanceof HTMLLabelElement)) return null;
          const forAttr = node.htmlFor;
          if (forAttr.length === 0) return null;
          const target = node.ownerDocument.getElementById(forAttr);
          if (target === null) return null;
          // Only redirect when the target is input/textarea/select. A
          // label pointing at a non-form element (rare; React Aria
          // does it for a labelled-by relationship) shouldn't trigger
          // the redirect.
          const tag = target.tagName.toLowerCase();
          if (tag !== "input" && tag !== "textarea" && tag !== "select") {
            return null;
          }
          return forAttr;
        });
      if (resolvedId === null) return selector;
      // CSS-escape the id so unusual characters (Sentry's `--` separator
      // is fine, but the helper is defensive against future ids that
      // include `.`, spaces, …) don't break the locator.
      const escaped = (
        typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape ===
        "function"
          ? (globalThis as { CSS: { escape: (s: string) => string } }).CSS.escape(resolvedId)
          : resolvedId.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1")
      );
      return `#${escaped}`;
    } catch {
      return selector;
    }
  }

  // 0.8.2-rc.11 — keyboard-driven react-select interaction. The
  // trigger is the inner <input>; opening the menu via mouse click
  // alone isn't reliable on every react-select instance (Sentry's
  // permission grid). Sequence:
  //   1. focus the trigger (the click already happened in
  //      selectFromCombobox, but a defensive .focus() handles the
  //      case where the click went to a sibling overlay).
  //   2. press Alt+ArrowDown — react-select binds this to open the
  //      menu and select the first option.
  //   3. if a matcher was given, type its first 1-3 letters to filter
  //      the menu down to the right option, then press Enter to
  //      commit.
  //   4. if no matcher, ArrowDown was already issued — press Enter to
  //      commit the first option.
  // Verify via the input's aria-activedescendant or value attribute
  // changing (react-select updates one or the other on selection).
  // Returns true on success, false when the page didn't react.
  private async tryReactSelectKeyboardPick(
    triggerSelector: string,
    optionMatcher?: string,
  ): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const triggerLocator = this.page.locator(triggerSelector);
    try {
      const tagName = await triggerLocator
        .first()
        .evaluate((node) => node.tagName.toLowerCase());
      // Limit this path to input-typed triggers; native <select> and
      // <button role="combobox"> are handled by other tiers. The
      // selectFromCombobox caller has already returned for matching
      // [role="option"] tiers, so we only reach here on patterns where
      // the trigger is an input.
      if (tagName !== "input") return false;
    } catch {
      return false;
    }
    try {
      await triggerLocator.first().focus({ timeout: 1500 });
    } catch {
      return false;
    }
    // Snapshot the input's relevant attributes BEFORE opening so we
    // can verify that the pick actually committed.
    const before = await triggerLocator
      .first()
      .evaluate((node) => ({
        activedescendant: node.getAttribute("aria-activedescendant") ?? "",
        value: node instanceof HTMLInputElement ? node.value : "",
        // react-select 5 mirrors the selected value into the closest
        // .css-{hash}-singleValue node; grab the trigger's surrounding
        // text so a successful pick produces an observable change.
        surroundingText:
          node.parentElement?.parentElement?.parentElement?.textContent ?? "",
      }))
      .catch(() => ({ activedescendant: "", value: "", surroundingText: "" }));

    // Press Alt+ArrowDown to open + highlight the first option, then
    // if a matcher exists, type to filter, then Enter.
    try {
      await this.page.keyboard.press("Alt+ArrowDown");
    } catch {
      return false;
    }
    // Wait briefly for the menu to render.
    await this.wait(0.4);
    if (optionMatcher !== undefined && optionMatcher.length > 0) {
      // Type a few characters to filter; react-select narrows on each
      // keystroke. Capping at 6 keeps the input from overshooting on
      // a long matcher when the first few characters already narrow
      // to a single option ("Admin" → typing "Adm" is enough).
      const typed = optionMatcher.slice(0, 6);
      try {
        await triggerLocator.first().pressSequentially(typed, { delay: 25 });
      } catch {
        return false;
      }
      await this.wait(0.35);
    }
    try {
      await this.page.keyboard.press("Enter");
    } catch {
      return false;
    }
    await this.wait(0.5);

    const after = await triggerLocator
      .first()
      .evaluate((node) => ({
        activedescendant: node.getAttribute("aria-activedescendant") ?? "",
        value: node instanceof HTMLInputElement ? node.value : "",
        surroundingText:
          node.parentElement?.parentElement?.parentElement?.textContent ?? "",
      }))
      .catch(() => ({ activedescendant: "", value: "", surroundingText: "" }));
    // A successful pick produces at least one observable change.
    // react-select clears the input's value once a selection commits
    // (the chosen label moves into a sibling singleValue node), so the
    // surrounding-text diff is the strongest signal.
    if (before.surroundingText !== after.surroundingText) return true;
    if (before.activedescendant !== after.activedescendant) return true;
    if (before.value !== after.value) return true;
    return false;
  }

  // F11: pick an option from a Playwright Locator already-narrowed to
  // candidates. Matcher → filter by hasText (case-insensitive by
  // default in Playwright). No matcher → first.
  private async pickComboboxOption(
    options: Locator,
    matcher?: string,
  ): Promise<void> {
    let target = options.first();
    if (matcher !== undefined) {
      const filtered = options.filter({ hasText: matcher });
      if ((await filtered.count()) > 0) target = filtered.first();
    }
    // cmdk (the command-menu library) does NOT commit a selection from the
    // bot's humanized page.mouse.click(x, y): cmdk re-renders + re-orders its
    // list as the search filters, so the cached click coordinates land on the
    // wrong row (or empty space), and cmdk's onSelect — bound to a real
    // pointer/click event ON the item, or Enter on the highlighted item —
    // never fires. The trigger keeps its placeholder and the gated submit
    // stays disabled (MEASURED 2026-06-11: meilisearch's /welcome-informations
    // "reasons" + "SDK" comboboxes looped the whole run). Detect cmdk/Radix
    // option items and commit via a real, re-resolved actionable click (plus a
    // pointer-event sequence as backup) instead of raw mouse coordinates.
    const isCmdkItem = await target
      .evaluate(
        (el) =>
          el.hasAttribute("cmdk-item") ||
          el.closest("[cmdk-root],[cmdk-list],[cmdk-group]") !== null,
      )
      .catch(() => false);
    if (isCmdkItem) {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      // Playwright's locator.click() re-resolves geometry and dispatches the
      // full trusted pointer/mouse sequence at the element's center — what
      // cmdk's onSelect actually listens for.
      await target.click({ timeout: 5000 }).catch(async () => {
        // Backup: dispatch the pointer pair directly, then Enter (the cmdk
        // input is focused after type-to-filter and highlights this item).
        await target.dispatchEvent("pointerdown").catch(() => {});
        await target.dispatchEvent("pointerup").catch(() => {});
        await this.page?.keyboard.press("Enter").catch(() => {});
      });
      await this.wait(0.5);
      return;
    }
    await this.humanClickLocator(target);
    await this.wait(0.5);
  }

  // ───────────── humanization internals ─────────────

  // Click that mimics a real user: locate element, bezier-path the
  // mouse to it, hover briefly, then click. The mouse position is
  // remembered so successive clicks form a continuous path.
  private async humanClick(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // A bare selector through a strict-mode locator throws "strict mode
    // violation" before humanClickLocator can even waitFor — and several
    // OAuth widgets (Descope's <descope-button>, seen on Weaviate + Redis
    // Cloud) stamp the SAME generated id on both the wrapping web component
    // and its inner text node, so a single id selector resolves to 2
    // elements. For a click that's harmless: every match is the same visual
    // affordance. Narrow to the first match (Playwright's documented
    // disambiguation for clicks) when the selector isn't already unique,
    // matching what clickSubmit/clickLinkByText already do.
    const locator = this.page.locator(selector);
    const count = await locator.count().catch(() => 1);
    await this.humanClickLocator(pickClickLocator(locator, count));
  }

  // Locator-based core of humanClick. Taking a Locator (not a selector
  // string) lets clickSubmit() hand us a `.nth(i)`-narrowed locator
  // when a selector matched several elements — a bare selector through
  // a strict-mode locator would throw before we could disambiguate.
  private async humanClickLocator(locator: Locator): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.3-rc.1 — widened from 10s to 20s for SPA-load races. The
    // mixpanel-class signup page (Next.js + heavy auth JS, ~12-15s
    // to first-paint the form) was timing out here even when the
    // submit button DOES eventually mount. Bound stays low enough
    // that a genuinely-missing target still surfaces a clear error
    // within the bot's per-action budget.
    await locator.waitFor({ state: "visible", timeout: 20000 });
    // rc.20 — wait for the target to be ENABLED before issuing the
    // click. humanClick uses page.mouse.click(x, y) which bypasses
    // Playwright's actionability check, so a disabled button receives
    // the mousedown/mouseup events but the browser no-ops them, and
    // the caller sees no error. Symptom: OpenRouter's /sign-up renders
    // Clerk's OAuth buttons with `disabled` + `cl-loading` while Clerk
    // JS is initialising; humanClick fires against the disabled
    // Google button, nothing happens, then auth-state detection
    // misreads "URL unchanged, not on provider" as "OAuth completed"
    // and the run falls apart.
    //
    // Poll for up to 15s for the disabled state to clear. Both the
    // HTML `disabled` attribute AND `aria-disabled="true"` are
    // honored — the latter covers ARIA-styled buttons (Radix, Headless
    // UI) that visually appear interactive but reject input.
    //
    // rc.16 — when the poll times out we now THROW instead of silently
    // proceeding to a no-op click. PostHog's "Create key" submit stays
    // aria-disabled until both an org/project access option AND a
    // scopes preset are set; humanClick previously fired a mouse
    // click at the disabled button (which does nothing), the page
    // didn't change, and the post-verify no-progress detector
    // re-planned generically. The planner kept retrying click on the
    // same button because nothing in its hint named the specific
    // root cause ("button is disabled — find what precondition is
    // missing"). Throwing surfaces the disabled state explicitly to
    // the planner via the executor's existing catch handler, so the
    // next round's reason includes "click failed: target is
    // aria-disabled" and the planner pivots to checking other fields.
    {
      const deadline = Date.now() + 15_000;
      let isDisabled = false;
      while (Date.now() < deadline) {
        isDisabled = await locator
          .first()
          .evaluate((el) => {
            if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
              if (el.disabled) return true;
            }
            const aria = el.getAttribute("aria-disabled");
            return aria === "true" || aria === "";
          })
          .catch(() => false);
        if (!isDisabled) break;
        await this.sleep(150);
      }
      if (isDisabled) {
        // Name the SPECIFIC unfilled required field(s) so the planner fills the
        // right one instead of re-clicking the dead submit. MEASURED 2026-06-11
        // (meilisearch/zilliz: planner clicked a disabled Next 4+ times because
        // the generic hint didn't say WHICH field blocked it). Feedback only.
        const hint = await this.unfilledRequiredHint();
        throw new Error(
          "target is disabled (HTML disabled or aria-disabled=true) after 15s — " +
            "the click would no-op. A required precondition is unmet: an empty " +
            "input, an unselected dropdown, an unchecked agreement checkbox, or " +
            "a missing preset/permission choice. Do NOT retry this click — pick a " +
            "different action that fills the missing field first." +
            hint,
        );
      }
    }
    // Scroll the element into the viewport BEFORE measuring it. A
    // humanized click is a raw page.mouse.click(x, y) at viewport
    // coordinates — boundingBox() of a below-the-fold element returns
    // an off-screen y, and the click then lands on nothing (it was
    // why a Sentry OAuth button below the fold never navigated). The
    // regular .click() path auto-scrolls; the humanized path must too
    // — same fix check() already carries.
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox();
    if (box === null) {
      // Element exists but isn't in the layout (e.g., display:none).
      // Fall back to the regular click which will fail loudly with a
      // useful error.
      await locator.click();
      return;
    }
    // Aim for a random point inside the bounding box (not always the
    // exact center — that's a fingerprintable bot tell).
    const targetX = box.x + rand(box.width * 0.25, box.width * 0.75);
    const targetY = box.y + rand(box.height * 0.25, box.height * 0.75);

    await this.bezierMouseTo(targetX, targetY);
    // Hover hesitation. Real users land on a button and pause briefly
    // before clicking. 80-300ms is short enough not to slow runs much
    // and long enough to register as "non-instant" in scoring JS.
    await this.sleep(rand(80, 300));
    await this.page.mouse.click(targetX, targetY);
    this.mouseX = targetX;
    this.mouseY = targetY;
  }

  // Moves the mouse along a bezier curve from the current position to
  // (x, y). Uses 12-25 intermediate steps with small per-step delays.
  // The curve avoids the dead-straight teleport that Playwright's
  // default move() does.
  private async bezierMouseTo(x: number, y: number): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const steps = rand(12, 25);
    // Bezier control points: bow the curve slightly perpendicular to
    // the travel direction so it's a recognizable arc, not a straight
    // line. Magnitude scales with distance.
    const dx = x - this.mouseX;
    const dy = y - this.mouseY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const bowMagnitude = Math.min(distance * 0.2, 80);
    // Perpendicular direction (rotate the (dx, dy) vector 90°), then
    // randomize which side of the line we bow toward.
    const perpX = -dy / (distance || 1);
    const perpY = dx / (distance || 1);
    const sign = Math.random() < 0.5 ? -1 : 1;
    const cx = this.mouseX + dx / 2 + perpX * bowMagnitude * sign;
    const cy = this.mouseY + dy / 2 + perpY * bowMagnitude * sign;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Quadratic bezier: (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
      const oneMinusT = 1 - t;
      const px = oneMinusT * oneMinusT * this.mouseX + 2 * oneMinusT * t * cx + t * t * x;
      const py = oneMinusT * oneMinusT * this.mouseY + 2 * oneMinusT * t * cy + t * t * y;
      await this.page.mouse.move(px, py);
      // 6-18ms per step → ~150-400ms total travel for a typical click.
      await this.sleep(rand(6, 18));
    }
  }

  // ───────────── Tier 2 captcha handling ─────────────

  // Detects and handles visible-mode captcha widgets (Cloudflare
  // Turnstile, reCAPTCHA v2 checkbox). Returns:
  //   { found: false }                   - no widget present
  //   { found: true, solved: true }      - we clicked it and the page
  //                                        accepted the resulting token
  //   { found: true, solved: false }     - we clicked it but the
  //                                        challenge didn't pass
  //                                        within the timeout
  //
  // Strategy: locate the third-party iframe, click at the checkbox's
  // typical position (inside the widget's bounding box, near the
  // left), then poll for the success signal:
  //   - Turnstile:   `input[name="cf-turnstile-response"][value]` populated
  //   - reCAPTCHA:   `textarea[name="g-recaptcha-response"]` populated
  //
  // The click + wait is the entire "solve." The challenge JS runs
  // inside the iframe under Cloudflare/Google's origin — we can't
  // touch it directly. What we CAN do is trigger the click that
  // starts the challenge, then wait for the widget's host page to
  // receive the token via postMessage and inject it into the form.
  //
  // Honest limits:
  //   - "Invisible" Turnstile/reCAPTCHA-v3 doesn't need this method
  //     because there's no widget to click; the existing Tier 1
  //     humanization is what gets you past those.
  //   - When CF decides this user is suspicious enough to issue a
  //     full challenge image grid, this method won't help — the
  //     iframe will render the grid, our click won't solve it, and
  //     we'll time out with `solved: false`.
  async solveVisibleCaptcha(timeoutMs = 30000): Promise<CaptchaSolveResult> {
    if (!this.page) throw new Error("Browser not started");

    // Locate the widget. Turnstile and reCAPTCHA both use distinctive
    // iframe URLs that are easy to discriminate.
    const widget = await this.findCaptchaWidget();
    if (widget === null) return { found: false };

    // rc.33 — fingerprint probe. When tracing, dump the values
    // Cloudflare Turnstile (and other anti-bot solutions) actually
    // read: WebGL renderer/vendor strings, canvas hash, hw concurrency,
    // device memory, screen, languages, webdriver flag. Turnstile
    // error 600010 ("internal client execution error") usually points
    // at one of these returning something the challenge JS can't
    // handle (e.g. SwiftShader/llvmpipe renderer under Xvfb).
    if (process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1") {
      try {
        const fp = await this.page.evaluate(() => {
          const out: Record<string, unknown> = {};
          try {
            const c = document.createElement("canvas");
            const gl =
              (c.getContext("webgl2") as WebGL2RenderingContext | null) ??
              (c.getContext("webgl") as WebGLRenderingContext | null);
            if (gl !== null) {
              out.webglVendor = gl.getParameter(gl.VENDOR);
              out.webglRenderer = gl.getParameter(gl.RENDERER);
              out.webglVersion = gl.getParameter(gl.VERSION);
              out.webglShadingLanguageVersion = gl.getParameter(
                gl.SHADING_LANGUAGE_VERSION,
              );
              const dbg = gl.getExtension("WEBGL_debug_renderer_info");
              if (dbg !== null) {
                out.webglUnmaskedVendor = gl.getParameter(
                  dbg.UNMASKED_VENDOR_WEBGL,
                );
                out.webglUnmaskedRenderer = gl.getParameter(
                  dbg.UNMASKED_RENDERER_WEBGL,
                );
              }
              out.webglExtensions = (gl.getSupportedExtensions() ?? [])
                .slice(0, 6)
                .join(",");
            } else {
              out.webglVendor = null;
            }
          } catch (e) {
            out.webglError = String(e);
          }
          try {
            const c2 = document.createElement("canvas");
            c2.width = 200;
            c2.height = 50;
            const ctx = c2.getContext("2d");
            if (ctx !== null) {
              ctx.textBaseline = "top";
              ctx.font = "14px Arial";
              ctx.fillStyle = "#f60";
              ctx.fillRect(125, 1, 62, 20);
              ctx.fillStyle = "#069";
              ctx.fillText("Cwm fjordbank glyphs vext quiz", 2, 15);
              out.canvas2dHash = c2.toDataURL().slice(-48);
            }
          } catch (e) {
            out.canvas2dError = String(e);
          }
          out.hardwareConcurrency = navigator.hardwareConcurrency;
          out.deviceMemory = (
            navigator as Navigator & { deviceMemory?: number }
          ).deviceMemory;
          out.platform = navigator.platform;
          out.languages = navigator.languages.join(",");
          out.userAgent = navigator.userAgent;
          out.webdriver = navigator.webdriver;
          out.screen = {
            w: screen.width,
            h: screen.height,
            d: screen.colorDepth,
            availW: screen.availWidth,
            availH: screen.availHeight,
          };
          out.devicePixelRatio = window.devicePixelRatio;
          out.touchPoints = navigator.maxTouchPoints;
          return out;
        });
        console.error("[fingerprint] " + JSON.stringify(fp));
      } catch (err) {
        console.error(
          "[fingerprint] probe failed: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // Click at the checkbox position. Turnstile's checkbox sits at
    // roughly (28, 32) inside its iframe (the iframe is typically
    // 300x65 with the box on the left). reCAPTCHA v2 checkbox is at
    // (30, 30) inside a 304x78 iframe. Both tolerate clicks anywhere
    // in the left 60px of the widget.
    const clickX = widget.box.x + 28;
    const clickY = widget.box.y + widget.box.height / 2;

    // Use the humanized path so the click looks like a real user
    // tapping the box (Cloudflare's post-click challenge correlates
    // mouse-entry velocity with bot-likelihood).
    //
    // rc.33 — pre-click reconnaissance. Without this, the trajectory
    // goes "last form field → straight to checkbox," which is too
    // direct: a human eyes the captcha, glances around the form, and
    // *then* approaches. Wander to a point above the widget first,
    // dwell as if reading, then bezier in. The dwell also widens the
    // scoring window so Cloudflare has more session-level entropy to
    // grade before the click lands.
    if (this.humanize) {
      const wanderX = widget.box.x + widget.box.width / 2 + rand(-40, 40);
      const wanderY = widget.box.y - rand(60, 110);
      await this.bezierMouseTo(wanderX, wanderY);
      await this.sleep(rand(600, 1400));
      await this.bezierMouseTo(clickX, clickY);
      await this.sleep(rand(180, 450));
    }
    await this.page.mouse.click(clickX, clickY);
    this.mouseX = clickX;
    this.mouseY = clickY;

    // Poll for the success token. We check both Turnstile and reCAPTCHA
    // selectors because some sites embed multiple widgets and we want
    // either to count.
    const start = Date.now();
    const pollIntervalMs = 500;
    while (Date.now() - start < timeoutMs) {
      await this.sleep(pollIntervalMs);
      const solved = await this.page.evaluate(() => {
        const turnstile = document.querySelector(
          'input[name="cf-turnstile-response"]',
        ) as HTMLInputElement | null;
        if (turnstile !== null && turnstile.value.length > 0) return true;
        const recaptcha = document.querySelector(
          'textarea[name="g-recaptcha-response"]',
        ) as HTMLTextAreaElement | null;
        if (recaptcha !== null && recaptcha.value.length > 0) return true;
        // hCaptcha populates its own response textarea on a passed
        // checkbox (plausible). Same shape as reCAPTCHA's.
        const hcaptcha = document.querySelector(
          'textarea[name="h-captcha-response"]',
        ) as HTMLTextAreaElement | null;
        if (hcaptcha !== null && hcaptcha.value.length > 0) return true;
        // Some Turnstile installs use a managed mode that emits its
        // own attribute on the host div when solved.
        const cfManaged = document.querySelector(".cf-turnstile[data-state='success']");
        if (cfManaged !== null) return true;
        return false;
      });
      if (solved) {
        if (widget.kind === "hcaptcha") {
          const settled = await this.waitForCaptchaChallengeToSettle(15_000, 10_000);
          if (!settled) return { found: true, solved: false, kind: widget.kind };
        }
        return { found: true, solved: true, kind: widget.kind };
      }
    }

    // Timed out — the challenge didn't pass. We don't loop or retry
    // because Cloudflare scoring is sticky for a given session; a
    // failed solve usually means the entire session is flagged and
    // further clicks won't help.
    return { found: true, solved: false, kind: widget.kind };
  }

  // Locates the captcha widget on the current page. Returns the
  // iframe's bounding box and which provider it is, or null if no
  // visible widget is present.
  //
  // rc.23 — two-phase detection:
  //   (1) Iframe-shape — fast path. Polls for up to 5s in case the
  //       widget's iframe is being injected by the host page's JS
  //       (Clerk installs Turnstile this way; the iframe is absent
  //       from the static HTML snapshot but materializes within a
  //       few seconds of the form rendering).
  //   (2) Host-element fallback — when no iframe ever appears
  //       (rare, but Cloudflare sometimes embeds the widget in a
  //       way the selector misses), find the hidden response input
  //       (cf-turnstile-response / g-recaptcha-response) and use
  //       its closest visible ancestor as the click target. The
  //       widget's click handler is registered on the host div, so
  //       a click inside the host box still triggers the challenge.
  private async findCaptchaWidget(): Promise<{
    kind: CaptchaKind;
    box: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!this.page) throw new Error("Browser not started");

    // An INVISIBLE reCAPTCHA (api2/anchor with size=invisible — the
    // bottom-right badge) is score-mode: there is no checkbox to click, and
    // its token is emitted only when the form's submit handler calls
    // grecaptcha.execute(). It must NOT be treated as a solvable visible
    // widget. MEASURED on amplitude (2026-06-04): the badge iframe is
    // ~256×60, so it cleared the size filter below and got "found" + clicked;
    // the pre-submit token-poll then timed out and the bot escalated to
    // 2Captcha, which can't solve a score-mode widget (ERROR_CAPTCHA_
    // UNSOLVABLE) → captcha_blocked — even though our v3 score is ~1.0 and a
    // plain form-submit would have passed silently. Detect "invisible-only"
    // (badge present, no visible checkbox anchor, no rendered bframe grid) and
    // skip reCAPTCHA entirely so the signup proceeds to submit.
    const recaptchaInvisibleOnly = await this.page
      .evaluate(() => {
        const q = (s: string): boolean => document.querySelector(s) !== null;
        const visibleAnchor = Array.from(
          document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"]'),
        ).some((f) => !/size=invisible/.test((f as HTMLIFrameElement).src));
        const bframe = (() => {
          const f = document.querySelector('iframe[src*="recaptcha/api2/bframe"]');
          if (f === null) return false;
          const r = f.getBoundingClientRect();
          return r.width > 30 && r.height > 30;
        })();
        const invisiblePresent =
          q('iframe[src*="recaptcha/api2/anchor"][src*="size=invisible"]') ||
          q(".grecaptcha-badge");
        return invisiblePresent && !visibleAnchor && !bframe;
      })
      .catch(() => false);

    // Phase 1: widget shape with polling. page.locator (unlike the
    // querySelector in detectCaptchaVariant) pierces OPEN shadow roots,
    // so the Cloudflare iframe is reachable even on modern shadow-DOM
    // Turnstile embeds. The `.cf-turnstile` host div is added as a
    // fallback for CLOSED-shadow embeds where the iframe isn't reachable
    // but the (light-DOM) host is — clicking the host box still triggers
    // the widget. This mirrors detectCaptchaVariant's iframe-OR-host
    // check so detection and solving agree (A4).
    //   Cloudflare Turnstile: src contains "challenges.cloudflare.com"
    //   reCAPTCHA v2:         src contains "recaptcha/api2"
    const iframeCandidates: Array<{
      kind: CaptchaKind;
      selector: string;
    }> = [
      { kind: "turnstile", selector: 'iframe[src*="challenges.cloudflare.com"]' },
      // Visible reCAPTCHA only — the size=invisible anchor (score-mode badge)
      // is handled by the recaptchaInvisibleOnly skip above.
      { kind: "recaptcha", selector: 'iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])' },
      // hCaptcha's checkbox iframe (the anchor frame). Plausible and other
      // hCaptcha sites render this; clicking it ticks the box the same way
      // Turnstile/reCAPTCHA do.
      { kind: "hcaptcha", selector: 'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]' },
      { kind: "hcaptcha", selector: 'iframe[src*="newassets.hcaptcha.com"]' },
      // Host-div fallbacks (light DOM) — preferred order keeps the iframe
      // first when present (more precise click target).
      { kind: "turnstile", selector: ".cf-turnstile" },
      { kind: "turnstile", selector: "#clerk-captcha" },
      { kind: "hcaptcha", selector: ".h-captcha" },
    ];
    const iframeDeadline = Date.now() + 5000;
    while (Date.now() < iframeDeadline) {
      for (const { kind, selector } of iframeCandidates) {
        const locator = this.page.locator(selector);
        const count = await locator.count();
        if (count === 0) continue;
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          // Bounded + best-effort. boundingBox() carries Playwright's default
          // 30s actionability wait; an invisible-mode Turnstile (the kind
          // patchright + a residential IP pass silently) never stabilises into
          // a visible box, so the unguarded call burned the full 30s and THREW
          // — and because the form-fill runCaptchaGate path didn't catch it,
          // it aborted the whole signup (measured: cartesia, cron-job.org).
          // A short timeout + catch turns "no clickable widget here" into a
          // skip, matching the Phase-2 host walk-up's `.catch(() => null)`.
          const box = await el.boundingBox({ timeout: 1500 }).catch(() => null);
          if (box === null) continue;
          if (box.width < 50 || box.height < 30) continue;
          return { kind, box };
        }
      }
      await this.sleep(250);
    }

    // Phase 2: host-element fallback. The hidden response input is
    // injected by the captcha JS even before the iframe; locate it,
    // walk up to a visible ancestor, return that bounding box.
    const hostCandidates: Array<{
      kind: CaptchaKind;
      selector: string;
    }> = [
      { kind: "turnstile", selector: 'input[name="cf-turnstile-response"]' },
      { kind: "recaptcha", selector: 'textarea[name="g-recaptcha-response"]' },
      { kind: "hcaptcha", selector: 'textarea[name="h-captcha-response"]' },
    ];
    for (const { kind, selector } of hostCandidates) {
      // The invisible reCAPTCHA's hidden g-recaptcha-response textarea lives
      // INSIDE the .grecaptcha-badge (~256×60), so the walk-up below would
      // return the badge box and we'd click it — the exact bug. Skip it.
      if (kind === "recaptcha" && recaptchaInvisibleOnly) continue;
      const locator = this.page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;
      const box = await locator
        .first()
        .evaluate((input) => {
          // Walk up looking for an ancestor with a non-trivial layout
          // box. The hidden input itself has 0×0 dimensions; the
          // visible widget container (Cloudflare's `.cf-turnstile`,
          // Clerk's `#clerk-captcha`, or any styled wrapper) sits
          // 1–3 levels up.
          let el = input as HTMLElement;
          for (let depth = 0; depth < 6 && el !== null; depth++) {
            const rect = el.getBoundingClientRect();
            if (rect.width >= 50 && rect.height >= 30) {
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            }
            const parent = el.parentElement;
            if (parent === null) break;
            el = parent;
          }
          return null;
        })
        .catch(() => null);
      if (box !== null) {
        return { kind, box };
      }
    }

    return null;
  }

  // Pure-read captcha classification for spike telemetry (T3.2).
  // Reports which captcha family is on the page and whether a solvable
  // image-grid challenge has actually rendered. Clicks nothing and
  // solves nothing — it cannot regress the Tier 2 solve path.
  // Best-effort: a page-eval failure (e.g. mid-navigation) reports
  // unknown / not-rendered rather than throwing.
  async detectCaptchaVariant(): Promise<{
    variant: CaptchaVariant;
    challengeRendered: boolean;
  }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const raw = await this.page.evaluate(() => {
        const present = (sel: string): boolean =>
          document.querySelector(sel) !== null;
        const visible = (sel: string): boolean => {
          const el = document.querySelector(sel);
          if (el === null) return false;
          const r = el.getBoundingClientRect();
          return r.width > 30 && r.height > 30;
        };
        // The image-grid challenge frame: reCAPTCHA's `bframe`, or
        // hCaptcha's challenge frame. Turnstile and score-mode
        // reCAPTCHA never render a grid.
        const challengeRendered =
          visible('iframe[src*="recaptcha/api2/bframe"]') ||
          visible('iframe[src*="hcaptcha.com"][src*="challenge"]');
        let variant = "unknown";
        // Turnstile: modern Cloudflare renders its iframe inside a SHADOW
        // DOM, so `querySelector('iframe[src*=challenges.cloudflare.com]')`
        // misses it entirely (verified on demo.turnstile.workers.dev:
        // iframe selector false, cf-turnstile-response input true). Detect
        // via the response input + host div, which live in the light DOM —
        // the iframe is a fallback for older/non-shadow embeds.
        if (
          present('input[name="cf-turnstile-response"]') ||
          present(".cf-turnstile") ||
          present('iframe[src*="challenges.cloudflare.com"]')
        ) {
          variant = "turnstile";
        } else if (present('iframe[src*="hcaptcha.com"]')) {
          variant = "hcaptcha";
        } else if (
          present(
            'iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])',
          )
        ) {
          // VISIBLE checkbox anchor (size=normal) → clickable v2.
          variant = "recaptcha_v2";
        } else if (
          present(".grecaptcha-badge") ||
          present('iframe[src*="recaptcha/api2/anchor"][src*="size=invisible"]')
        ) {
          // Badge / size=invisible anchor and no clickable checkbox →
          // score-mode reCAPTCHA (passes on submit, nothing to click).
          variant = "recaptcha_v3";
        }
        return { variant, challengeRendered };
      });
      return {
        variant: isCaptchaVariant(raw.variant) ? raw.variant : "unknown",
        challengeRendered: raw.challengeRendered,
      };
    } catch {
      return { variant: "unknown", challengeRendered: false };
    }
  }

  // Tier 3 captcha-solver support — extract the reCAPTCHA sitekey
  // from the page so a third-party solver can submit it. Returns
  // null when no v2 widget is present (Tier 3 only handles v2;
  // Turnstile + reCAPTCHA v3 are scoring-based and solvers don't
  // help). Reads from the standard places sites declare it:
  //   1. <div class="g-recaptcha" data-sitekey="...">
  //   2. <iframe src="...?k=SITEKEY&...">  (api2/anchor frame)
  //
  // CRITICAL: only ever returns a GENUINE reCAPTCHA key. hCaptcha
  // (`.h-captcha`) and Turnstile (`.cf-turnstile`) ALSO publish a
  // `data-sitekey` attribute, so a bare `[data-sitekey]` selector
  // grabs the wrong provider's key and the caller ships it to
  // 2Captcha's `userrecaptcha` endpoint → ERROR_WRONG_GOOGLEKEY (the
  // plausible/hCaptcha case). The authoritative discriminator is the
  // key FORMAT: reCAPTCHA public keys always start with `6L`; hCaptcha
  // keys are UUIDs (`bc609205-…`); Turnstile keys start with `0x`. We
  // both scope the selector away from the other widgets AND gate on
  // the `6L` prefix, so no non-reCAPTCHA key can ever leak through.
  async extractRecaptchaSitekey(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const sitekey = await this.page.evaluate(() => {
        const isRecaptchaKey = (k: string | null): k is string =>
          k !== null && /^6L/.test(k) && k.length > 30;
        // 1. data-sitekey, but NOT on an hCaptcha/Turnstile widget (or
        //    nested inside one). Those publish data-sitekey too.
        const anchors = Array.from(
          document.querySelectorAll<HTMLElement>("[data-sitekey]"),
        ).filter(
          (el) => el.closest(".h-captcha, .cf-turnstile") === null,
        );
        for (const el of anchors) {
          const k = el.getAttribute("data-sitekey");
          if (isRecaptchaKey(k)) return k;
        }
        // 2. The api2/enterprise iframe src carries ?k=SITEKEY.
        const iframes = Array.from(
          document.querySelectorAll<HTMLIFrameElement>(
            'iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]',
          ),
        );
        for (const ifr of iframes) {
          const url = new URL(ifr.src);
          const k = url.searchParams.get("k");
          if (isRecaptchaKey(k)) return k;
        }
        return null;
      });
      return sitekey;
    } catch {
      return null;
    }
  }

  // Inject a 2Captcha-resolved token into the page's hidden
  // g-recaptcha-response textarea AND fire any onSuccess callback
  // the widget registered with grecaptcha.render(). Without firing
  // the callback the page often doesn't "see" the token even though
  // the DOM input is populated.
  //
  // Returns true on success, false if no recaptcha widget present.
  async injectRecaptchaToken(token: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const injected = await this.page.evaluate((tok: string) => {
        // 1. Populate every g-recaptcha-response textarea on the page
        //    (some pages render multiple widgets).
        const inputs = Array.from(
          document.querySelectorAll<HTMLTextAreaElement>(
            'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]',
          ),
        );
        if (inputs.length === 0) return false;
        for (const input of inputs) {
          input.value = tok;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>("[data-hcaptcha-widget-id], .h-captcha"),
        )) {
          el.setAttribute("data-hcaptcha-response", tok);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const form = inputs[0]?.closest("form");
        form?.dispatchEvent(new Event("input", { bubbles: true }));
        form?.dispatchEvent(new Event("change", { bubbles: true }));
        // 2. Fire the widget's onSuccess callback if registered. The
        //    callbacks are stored on `___grecaptcha_cfg.clients`; the
        //    exact tree is undocumented and shifts across versions
        //    so a defensive walk is the only reliable way.
        try {
          const cfg = (window as unknown as {
            ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
          }).___grecaptcha_cfg;
          if (cfg !== undefined && cfg.clients !== undefined) {
            const fire = (obj: unknown): void => {
              if (obj === null || typeof obj !== "object") return;
              for (const [, v] of Object.entries(obj as Record<string, unknown>)) {
                if (v === null || typeof v !== "object") continue;
                if ("callback" in v && typeof (v as { callback: unknown }).callback === "function") {
                  try {
                    (v as { callback: (t: string) => void }).callback(tok);
                  } catch {
                    // best-effort — at worst we miss the callback,
                    // but the DOM input is populated which most
                    // sites' server-side validation reads.
                  }
                }
                fire(v);
              }
            };
            fire(cfg.clients);
          }
        } catch {
          // grecaptcha not on window — page may use a wrapper
          // (Stytch, Clerk). DOM injection is still in place.
        }
        return true;
      }, token);
      return injected;
    } catch {
      return false;
    }
  }

  // Cloudflare Turnstile sitekey. On the `.cf-turnstile` widget's
  // data-sitekey, or as the `0x…` path segment in the challenge iframe src
  // (challenges.cloudflare.com/.../0x4AAAAA…/…). Returns null when absent.
  async extractTurnstileSitekey(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        // Turnstile sitekeys are `0x` + ~22 base64url chars (e.g.
        // 0x4AAAAAADSpJWQOnICEKAwx). A site-embedded WIDGET exposes it; a
        // Cloudflare-MANAGED interstitial does not (it's injected, not in the
        // DOM) — those return null and the caller can't Tier-3 solve them.
        const isKey = (k: string | null | undefined): k is string =>
          k != null && /^0x[A-Za-z0-9_-]{18,}$/.test(k);
        // 1. data-sitekey on any element.
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-sitekey]"))) {
          const k = el.getAttribute("data-sitekey");
          if (isKey(k)) return k;
        }
        // 2. ANY iframe src carrying a 0x… sitekey (the challenge iframe path,
        //    or a query param). Not just challenges.cloudflare.com — some
        //    embeds proxy it.
        for (const ifr of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))) {
          const src = ifr.src || "";
          const path = src.match(/\/(0x[A-Za-z0-9_-]{18,})(?:\/|$)/);
          if (path !== null && isKey(path[1])) return path[1] ?? null;
          try {
            const q = new URL(src).searchParams.get("sitekey");
            if (isKey(q)) return q;
          } catch {
            /* relative/blank src */
          }
        }
        // 3. Inline HTML: `sitekey: '0x…'`, `data-sitekey="0x…"`,
        //    `turnstile.render(el, { sitekey: '0x…' })`. Covers JS-config
        //    widgets that never set a DOM attribute.
        const html = document.documentElement.outerHTML;
        const m =
          html.match(/data-sitekey=["'](0x[A-Za-z0-9_-]{18,})/i) ??
          html.match(/sitekey["'\s:=]{1,4}["'](0x[A-Za-z0-9_-]{18,})/i);
        if (m !== null && isKey(m[1])) return m[1] ?? null;
        return null;
      });
    } catch {
      return null;
    }
  }

  // Inject a 2Captcha-resolved Turnstile token into the page's
  // cf-turnstile-response input(s) + dispatch input/change so the form's
  // submit handler sees it. Turnstile exposes no public callback-read API
  // (unlike grecaptcha), so DOM injection + events is the reliable path; the
  // server-side validation reads the input value. Returns true if an input
  // was populated.
  async injectTurnstileToken(token: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate((tok: string) => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            '[name="cf-turnstile-response"], [name^="cf-turnstile-response"], input[id^="cf-chl-widget"]',
          ),
        );
        if (inputs.length === 0) return false;
        for (const input of inputs) {
          (input as HTMLInputElement).value = tok;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      }, token);
    } catch {
      return false;
    }
  }

  // Mint the score token for an INVISIBLE reCAPTCHA by calling
  // grecaptcha.execute() ourselves, then wait for g-recaptcha-response to
  // populate. MEASURED on amplitude (2026-06-04): an invisible reCAPTCHA's
  // token only exists once execute() runs, and amplitude's form REQUIRES it —
  // merely skipping the badge (not clicking it) left the textarea empty and
  // the submit silently no-op'd. With our ~1.0 v3 score, execute() returns a
  // passing token in ~1-3s, so the subsequent submit carries a valid token.
  // Handles both standard (grecaptcha) and enterprise (grecaptcha.enterprise)
  // namespaces. Returns true once a token is present. Best-effort: a missing
  // grecaptcha or an execute() throw resolves false (the form may still mint
  // it on its own submit handler).
  async triggerInvisibleRecaptcha(timeoutMs = 9000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const tokenPresent = (): Promise<boolean> => this.hasCaptchaResponseToken();

    if (await tokenPresent()) return true;

    const fired = await this.page
      .evaluate(() => {
        const w = window as unknown as {
          grecaptcha?: {
            execute?: (widgetId?: number) => void;
            enterprise?: { execute?: (widgetId?: number) => void };
          };
          // grecaptcha stashes every rendered widget here, keyed by its
          // numeric widget id. amplitude (and many SPAs) render the invisible
          // widget with an EXPLICIT id, and a bare grecaptcha.execute() with
          // no id throws "No reCAPTCHA clients exist" — MEASURED as "token not
          // minted" on amplitude. Enumerate the clients and execute each by id.
          ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
        };
        const g = w.grecaptcha;
        if (g === undefined) return false;
        let any = false;
        const ids = (() => {
          try {
            return Object.keys(w.___grecaptcha_cfg?.clients ?? {});
          } catch {
            return [];
          }
        })();
        for (const id of ids) {
          const n = Number(id);
          if (!Number.isFinite(n)) continue;
          try {
            g.enterprise?.execute?.(n);
            any = true;
          } catch {
            /* not this namespace */
          }
          try {
            g.execute?.(n);
            any = true;
          } catch {
            /* widget already executed / wrong namespace */
          }
        }
        // Fallback: no enumerable clients — try the bare (first-widget) call,
        // enterprise first (a v2-invisible page exposes plain execute()).
        if (!any) {
          try {
            if (typeof g.enterprise?.execute === "function") {
              g.enterprise.execute();
              any = true;
            } else if (typeof g.execute === "function") {
              g.execute();
              any = true;
            }
          } catch {
            return false;
          }
        }
        return any;
      })
      .catch(() => false);
    if (!fired) return false;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.sleep(500);
      if (await tokenPresent()) return true;
    }
    return false;
  }

  async hasCaptchaResponseToken(): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    return this.page
      .evaluate(() => {
        const hasValue = (selector: string): boolean => {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
          return el !== null && el.value.trim().length > 0;
        };
        return (
          hasValue('textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]') ||
          hasValue('textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"]') ||
          hasValue('input[name="cf-turnstile-response"], input[id^="cf-chl-widget"]') ||
          document.querySelector(".cf-turnstile[data-state='success']") !== null
        );
      })
      .catch(() => false);
  }

  async waitForCaptchaResponseToken(timeoutMs = 5000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const start = Date.now();
    do {
      if (await this.hasCaptchaResponseToken()) return true;
      await this.sleep(250);
    } while (Date.now() - start < timeoutMs);
    return false;
  }

  // Tier 3 hCaptcha support — extract the hCaptcha sitekey so 2Captcha
  // can solve it. hCaptcha publishes its key on `.h-captcha[data-sitekey]`
  // or in the checkbox iframe's `?sitekey=` query. Keys are UUIDs (the
  // reCAPTCHA `6L` guard in extractRecaptchaSitekey deliberately rejects
  // them, which is why hCaptcha needs its own extractor). Returns null
  // when no hCaptcha widget is present.
  async extractHcaptchaSitekey(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const fromDom = await this.page.evaluate(() => {
        const div = document.querySelector<HTMLElement>(".h-captcha[data-sitekey], [data-hcaptcha-sitekey]");
        if (div !== null) {
          const k =
            div.getAttribute("data-sitekey") ??
            div.getAttribute("data-hcaptcha-sitekey");
          if (k !== null && k.length > 10) return k;
        }
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe[src*="hcaptcha.com"]',
        );
        if (iframe !== null) {
          const url = new URL(iframe.src);
          const k =
            url.searchParams.get("sitekey") ??
            new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash).get(
              "sitekey",
            );
          if (k !== null && k.length > 10) return k;
        }
        return null;
      });
      if (fromDom !== null) return fromDom;
      // INVISIBLE hCaptcha (Hugging Face, Stripe): no .h-captcha div, no
      // iframe `?sitekey=` param — the sitekey lives in the page's JS/JSON
      // config (`captchaApiKey`, `express_hcaptcha_site_key`,
      // `hcaptcha_login_main_site_key`, etc.). Scan the HTML for a UUID-shaped
      // key next to a sitekey/captcha hint, but only when an hCaptcha marker is
      // present so an unrelated config UUID cannot match.
      const html = await this.page.evaluate(() => document.documentElement.outerHTML);
      return extractHcaptchaSitekeyFromHtml(html);
    } catch {
      return null;
    }
  }

  async getBrowserUserAgent(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => navigator.userAgent);
    } catch {
      return null;
    }
  }

  async getHcaptchaSolveContext(): Promise<{
    invisible: boolean;
    userAgent: string | null;
    rqdata: string | null;
  }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        let invisible = false;
        let rqdata: string | null = null;
        const useRqdata = (value: string | null): void => {
          if (rqdata === null && value !== null && value.trim().length > 0) rqdata = value;
        };
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(".h-captcha, [data-hcaptcha-widget-id]"),
        )) {
          const size = el.getAttribute("data-size") ?? el.getAttribute("size");
          if (size?.toLowerCase() === "invisible") invisible = true;
          useRqdata(el.getAttribute("data-rqdata"));
        }
        for (const iframe of Array.from(
          document.querySelectorAll<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]'),
        )) {
          try {
            const url = new URL(iframe.src);
            const hashParams = new URLSearchParams(
              url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
            );
            const size = url.searchParams.get("size") ?? hashParams.get("size");
            const frame = url.searchParams.get("frame") ?? hashParams.get("frame");
            useRqdata(url.searchParams.get("rqdata") ?? hashParams.get("rqdata"));
            const clientOptions = url.searchParams.get("clientOptions") ?? hashParams.get("clientOptions");
            if (clientOptions !== null) {
              try {
                const parsed = JSON.parse(clientOptions) as { rqdata?: unknown };
                if (typeof parsed.rqdata === "string") useRqdata(parsed.rqdata);
              } catch {
                // ignore non-JSON client options
              }
            }
            if (
              size?.toLowerCase() === "invisible" ||
              frame?.toLowerCase() === "checkbox-invisible"
            ) {
              invisible = true;
            }
          } catch {
            // ignore malformed extension/proxy iframe URLs
          }
        }
        return { invisible, userAgent: navigator.userAgent, rqdata };
      });
    } catch {
      return {
        invisible: false,
        userAgent: await this.getBrowserUserAgent().catch(() => null),
        rqdata: null,
      };
    }
  }

  // Inject a 2Captcha-resolved hCaptcha token into the page's
  // h-captcha-response textarea(s), update hCaptcha runtime response
  // accessors, and fire registered callbacks. Mirrors injectRecaptchaToken;
  // hCaptcha also mirrors the response token into a g-recaptcha-response
  // textarea on some compat installs, so populate both names if present.
  async injectHcaptchaToken(token: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const responseKey = extractHcaptchaResponseKeyFromToken(token);
      const diag = await this.page.evaluate(({ tok, key }: { tok: string; key: string | null }) => {
        const widgetIds = new Set<string>();
        const inputs = Array.from(
          document.querySelectorAll<HTMLTextAreaElement>(
            'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"], textarea[name="g-recaptcha-response"]',
          ),
        );
        for (const input of inputs) {
          input.value = tok;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        for (const host of Array.from(
          document.querySelectorAll<HTMLElement>(
            ".h-captcha, [data-hcaptcha-widget-id], [data-hcaptcha-response]",
          ),
        )) {
          host.setAttribute("data-hcaptcha-response", tok);
          const id =
            host.getAttribute("data-hcaptcha-widget-id") ??
            host.getAttribute("data-hcaptcha-widget-id".toLowerCase());
          if (id !== null && id.length > 0) widgetIds.add(id);
          host.dispatchEvent(new Event("input", { bubbles: true }));
          host.dispatchEvent(new Event("change", { bubbles: true }));
        }
        for (const iframe of Array.from(
          document.querySelectorAll<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]'),
        )) {
          try {
            const url = new URL(iframe.src);
            const params = new URLSearchParams(
              url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
            );
            const id = params.get("id");
            if (id !== null && id.length > 0) widgetIds.add(id);
          } catch {
            // ignore malformed extension/proxy iframe URLs
          }
        }

        const win = window as unknown as Record<string, unknown>;
        const hcaptcha = win.hcaptcha as
          | {
              getResponse?: (id?: string) => string;
              getRespKey?: (id?: string) => string;
            }
          | undefined;
        if (hcaptcha !== undefined) {
          const originalGetResponse = hcaptcha.getResponse?.bind(hcaptcha);
          const originalGetRespKey = hcaptcha.getRespKey?.bind(hcaptcha);
          hcaptcha.getResponse = (id?: string) => {
            if (id === undefined || widgetIds.size === 0 || widgetIds.has(String(id))) return tok;
            return originalGetResponse?.(id) ?? tok;
          };
          hcaptcha.getRespKey = (id?: string) => {
            if (id === undefined || widgetIds.size === 0 || widgetIds.has(String(id))) return key ?? "";
            return originalGetRespKey?.(id) ?? key ?? "";
          };
        }

        let callbackFired = false;
        const fire = (fn: unknown): void => {
          if (typeof fn !== "function") return;
          callbackFired = true;
          try {
            (fn as (t: string, k?: string) => void)(tok, key ?? undefined);
          } catch {
            // A page callback can be stale after React remounts a widget.
          }
        };

        // Fire callbacks registered by markup, e.g. data-callback="onSubmit".
        try {
          for (const host of Array.from(
            document.querySelectorAll<HTMLElement>(".h-captcha[data-callback]"),
          )) {
            const name = host.getAttribute("data-callback");
            if (name !== null && name !== undefined) fire(win[name]);
          }
        } catch {
          // no named callback, continue to runtime config scan.
        }

        // Programmatic hCaptcha integrations pass function callbacks to
        // hcaptcha.render(). The SDK keeps them in ___hcaptcha_cfg; crawl it
        // generically so React/Vue wrappers are handled like plain forms.
        const seen = new Set<unknown>();
        const scan = (value: unknown, depth: number): void => {
          if (value === null || value === undefined || depth > 7 || seen.has(value)) return;
          seen.add(value);
          if (typeof value === "function") return;
          if (typeof value !== "object") return;
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            const normalized = key.toLowerCase();
            if (
              typeof child === "function" &&
              (normalized === "callback" ||
                normalized === "success-callback" ||
                normalized === "verify-callback" ||
                normalized === "onverify" ||
                normalized === "onsuccess")
            ) {
              fire(child);
              continue;
            }
            if (typeof child === "object" && child !== null) scan(child, depth + 1);
          }
        };
        scan(win.___hcaptcha_cfg, 0);
        scan(win.hcaptcha, 0);

        return {
          ok: inputs.length > 0 || widgetIds.size > 0 || callbackFired,
          textareas: inputs.length,
          widgets: widgetIds.size,
          callbackFired,
          hasHcaptchaGlobal: win.hcaptcha !== undefined,
        };
      }, { tok: token, key: responseKey });
      if (process.env.UNIVERSAL_BOT_OAUTH_DEBUG) {
        console.error(
          `[captcha] hCaptcha inject diag: ok=${diag.ok} textareas=${diag.textareas} ` +
            `widgets=${diag.widgets} callbackFired=${diag.callbackFired} hcaptchaGlobal=${diag.hasHcaptchaGlobal}`,
        );
      }
      return diag.ok;
    } catch {
      return false;
    }
  }

  async solveVisibleHcaptchaChallengeWithCoordinates(
    solve: (input: {
      imageBase64: string;
      comment?: string;
      minClicks?: number;
      maxClicks?: number;
    }) => Promise<TwoCaptchaCoordinatesResult>,
  ): Promise<HcaptchaCoordinateSolveResult> {
    if (!this.page) throw new Error("Browser not started");

    const challenge = await this.findVisibleHcaptchaChallengeFrame();
    if (challenge === null) {
      return { found: false, solved: false, reason: "no_visible_challenge" };
    }

    let shot: Buffer;
    try {
      shot = await challenge.locator.screenshot({ type: "png", timeout: 8_000 });
    } catch (err) {
      return {
        found: true,
        solved: false,
        reason: `screenshot_failed:${err instanceof Error ? err.message : String(err)}`,
        clicks: 0,
      };
    }

    const dims = pngDimensions(shot);
    if (dims === null || dims.width <= 0 || dims.height <= 0) {
      return {
        found: true,
        solved: false,
        reason: "invalid_challenge_screenshot",
        clicks: 0,
      };
    }

    const solveRes = await solve({
      imageBase64: shot.toString("base64"),
      comment:
        "hCaptcha challenge screenshot. Click all matching image targets requested by the prompt. If a Verify or Submit button is visible, click it after selecting targets.",
      minClicks: 1,
      maxClicks: 12,
    });
    if (solveRes.kind !== "ok") {
      return {
        found: true,
        solved: false,
        reason:
          `2captcha_${solveRes.kind}` +
          ("reason" in solveRes ? `:${solveRes.reason}` : ""),
        clicks: 0,
        ...("durationMs" in solveRes ? { durationMs: solveRes.durationMs } : {}),
      };
    }

    let clicks = 0;
    for (const point of solveRes.coordinates) {
      const box = await challenge.locator.boundingBox({ timeout: 1_500 }).catch(() => null);
      if (box === null || box.width <= 0 || box.height <= 0) break;
      const x = box.x + (point.x / dims.width) * box.width;
      const y = box.y + (point.y / dims.height) * box.height;
      await this.bezierMouseTo(x, y);
      await this.sleep(rand(100, 260));
      await this.page.mouse.click(x, y);
      this.mouseX = x;
      this.mouseY = y;
      clicks += 1;
    }

    await this.sleep(650);
    let settled = await this.waitForCaptchaChallengeToSettle(2_500).catch(() => false);
    if (!settled && clicks > 0) {
      const box = await challenge.locator.boundingBox({ timeout: 1_500 }).catch(() => null);
      if (box !== null && box.width > 0 && box.height > 0) {
        const verifyX = box.x + Math.min(box.width - 32, Math.max(32, box.width * 0.84));
        const verifyY = box.y + Math.min(box.height - 24, Math.max(24, box.height * 0.92));
        await this.bezierMouseTo(verifyX, verifyY);
        await this.sleep(rand(120, 320));
        await this.page.mouse.click(verifyX, verifyY);
        this.mouseX = verifyX;
        this.mouseY = verifyY;
      }
      settled = await this.waitForCaptchaChallengeToSettle(10_000).catch(() => false);
    }

    const responsePresent = await this.page
      .evaluate(() => {
        const ta = document.querySelector(
          'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"]',
        ) as HTMLTextAreaElement | null;
        return ta !== null && ta.value.length > 0;
      })
      .catch(() => false);

    const out: HcaptchaCoordinateSolveResult = {
      found: true,
      solved: settled || responsePresent,
      clicks,
      durationMs: solveRes.durationMs,
    };
    if (!out.solved) out.reason = "challenge_still_visible";
    return out;
  }

  private async findVisibleHcaptchaChallengeFrame(): Promise<{
    locator: Locator;
    box: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!this.page) throw new Error("Browser not started");
    const selectors = [
      'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
      'iframe[src*="newassets.hcaptcha.com"][src*="frame=challenge"]',
      'iframe[src*="hcaptcha.com"][src*="/challenge"]',
      'iframe[src*="newassets.hcaptcha.com"][src*="/challenge"]',
    ];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = this.page.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          const box = await el.boundingBox({ timeout: 1_000 }).catch(() => null);
          if (box === null) continue;
          if (box.width < 180 || box.height < 160) continue;
          return { locator: el, box };
        }
      }
      await this.sleep(250);
    }
    return null;
  }

  async waitForCaptchaChallengeToSettle(timeoutMs = 4000, stableClearMs = 2_500): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const hasVisibleChallenge = async (): Promise<boolean> =>
      await this.page!.evaluate(() => {
        const visible = (el: Element): boolean => {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false;
          }
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        };
        const selectors = [
          'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
          'iframe[src*="newassets.hcaptcha.com"][src*="frame=challenge"]',
          'iframe[src*="recaptcha/api2/bframe"]',
          'iframe[src*="challenges.cloudflare.com"]',
        ];
        return selectors.some((sel) =>
          Array.from(document.querySelectorAll(sel)).some((el) => visible(el)),
        );
      });
    const deadline = Date.now() + timeoutMs;
    let clearSince: number | null = null;
    while (Date.now() < deadline) {
      const visible = await hasVisibleChallenge().catch(() => false);
      if (!visible) {
        clearSince ??= Date.now();
        if (Date.now() - clearSince >= stableClearMs) return true;
      } else {
        clearSince = null;
      }
      await this.sleep(250);
    }
    return false;
  }

  // Small mouse wiggle near the current position. Used during prewarm
  // so the page sees pointer events before we navigate away.
  private async jitterMouse(): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const wiggles = rand(2, 5);
    for (let i = 0; i < wiggles; i++) {
      const nx = this.mouseX + rand(-50, 50);
      const ny = this.mouseY + rand(-50, 50);
      await this.page.mouse.move(nx, ny);
      this.mouseX = nx;
      this.mouseY = ny;
      await this.sleep(rand(40, 120));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async wait(seconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  async screenshot(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    // PERF: JPEG quality=70 yields ~250-400KB vs PNG's 1-3MB, with
    // no loss of legibility for the planner (Claude reads button
    // labels, not pixel detail). Smaller upload + faster Claude
    // tokenization saves ~300-500ms per planner round, and there
    // are 8-15 rounds per signup.
    const buffer = await this.page.screenshot({
      fullPage: false,
      type: "jpeg",
      quality: 70,
      timeout: 8_000,
    });
    return buffer.toString("base64");
  }

  async getState(): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not started");
    // page.content() / page.title() / screenshot() all throw
    // "Execution context was destroyed" when the page is mid-
    // navigation — common after an OAuth-button click that kicks off
    // a 3-5 hop redirect chain (sentry.io → accounts.google.com →
    // consent → callback → onboarding). Retry once after a short
    // settle: most navigations finish in <500ms even on slow links.
    try {
      return await this.snapshotState();
    } catch {
      await this.wait(0.8);
      return await this.snapshotState();
    }
  }

  private async snapshotState(): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not started");
    return {
      url: this.page.url(),
      title: await this.page.title(),
      html: await this.page.content(),
      screenshot: await this.screenshot().catch(() => ""),
    };
  }

  async extractText(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.textContent("body") || "";
  }

  // RENDERED, visibility-respecting body text. extractText() reads
  // textContent("body"), which includes display:none / visibility:hidden /
  // off-screen nodes — so a fully-rendered dashboard whose DOM merely
  // CONTAINS a hidden skeleton / "Loading…" / "Please wait 30 seconds…"
  // string (Next.js RSC inline payloads, lazy placeholders, aria-hidden
  // spinners) reads as still-loading and false-trips the loading-shell gate.
  // innerText is layout-aware: it omits hidden text and reflects what a user
  // would actually see. Use this for the SHELL decision ONLY — credential/key
  // extraction and wall-text checks deliberately read RAW text via
  // extractText() and must stay byte-identical, so this is purely additive.
  async extractVisibleText(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => document.body?.innerText ?? "");
  }

  // Deterministic Firebase/GCP credential extraction. Every Firebase project
  // auto-creates a "Browser key (auto created by Firebase)" in its underlying
  // Google Cloud project — the SAME AIzaSy value as firebaseConfig.apiKey AND a
  // usable GCP API key — even with NO web app registered. PROVEN surface
  // (2026-06-23): console.cloud.google.com/apis/credentials?project=<projectId>
  // → API Keys row "Browser key (auto created by Firebase)" → "Show key" reveals
  // the AIzaSy value inline in that row. Row-scoped so it never grabs one of the
  // console's own internal AIzaSy keys (which live in script/attribute data, not
  // the visible row text). Returns the key, or null when the page didn't render
  // a Browser key (project not provisioned yet / different surface).
  async extractGoogleApiKeyFromCredentials(projectId: string): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    const KEY_RE = /AIzaSy[0-9A-Za-z_-]{33}/;
    const url = `https://console.cloud.google.com/apis/credentials?project=${encodeURIComponent(projectId)}`;
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    // The credentials table renders async (heavy Angular console). Poll for it.
    for (let i = 0; i < 12; i++) {
      await this.wait(2.5);
      const ready = await this.page
        .evaluate(() => /Browser key|API Keys|Create credentials/i.test(document.body?.innerText ?? ""))
        .catch(() => false);
      if (ready) break;
    }
    // Locate the Firebase Browser-key row; return its AIzaSy if already shown,
    // else click the row's "Show key" button to reveal it.
    const readRowKey = (): Promise<string | null> =>
      this.page!
        .evaluate(() => {
          const rows = Array.from(document.querySelectorAll("tr"));
          const row =
            rows.find((r) => /browser key \(auto created by firebase\)/i.test(r.textContent ?? "")) ??
            rows.find((r) => /browser key/i.test(r.textContent ?? ""));
          if (row === undefined) return null;
          const m = (row.textContent ?? "").match(/AIzaSy[0-9A-Za-z_-]{33}/);
          if (m !== null) return m[0];
          const btn = Array.from(row.querySelectorAll("button,a")).find((b) =>
            /show key/i.test(b.textContent ?? ""),
          );
          if (btn !== undefined) (btn as HTMLElement).click();
          return null;
        })
        .catch(() => null);
    const first = await readRowKey();
    if (first !== null && KEY_RE.test(first)) return first;
    // After the Show-key click, poll the row (reveal is async) and any dialog
    // / readonly input the console may surface the value in.
    for (let i = 0; i < 8; i++) {
      await this.wait(1.5);
      const revealed = await this.page
        .evaluate(() => {
          const rows = Array.from(document.querySelectorAll("tr"));
          const row = rows.find((r) => /browser key/i.test(r.textContent ?? ""));
          const inRow = (row?.textContent ?? "").match(/AIzaSy[0-9A-Za-z_-]{33}/);
          if (inRow !== null) return inRow[0];
          for (const inp of Array.from(document.querySelectorAll("input"))) {
            const v = (inp as HTMLInputElement).value ?? "";
            const m = v.match(/AIzaSy[0-9A-Za-z_-]{33}/);
            if (m !== null) return m[0];
          }
          return null;
        })
        .catch(() => null);
      if (revealed !== null && KEY_RE.test(revealed)) return revealed;
    }
    return null;
  }

  // Deterministically satisfy required, currently-EMPTY combobox/listbox
  // selectors (cmdk / Radix / Headless UI multi-selects) that gate a disabled
  // submit. The dominant `oauth_onboarding_failed` blocker is a post-OAuth
  // "tell us about yourself" survey whose required multi-selects the greedy
  // planner opens but never commits — it concludes "all filled", clicks the
  // disabled Next, and stalls (MEASURED 2026-06-23, meilisearch
  // /welcome-informations: `[data-cy=...-trigger]` role=combobox → cmdk-list of
  // `[role=option][cmdk-item]`). For each unfilled trigger: open it, click the
  // first non-disabled option (Playwright locator click COMMITS where a raw
  // coordinate click drops — same as the post-verify combobox path), and Escape
  // to close the multi-select popover. Returns the labels it satisfied. Tightly
  // scoped: only acts on placeholder-showing (empty) comboboxes, never a
  // combobox that already holds a value.
  async fillRequiredComboboxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    let triggerSelectors: string[] = [];
    try {
      triggerSelectors = await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const out: string[] = [];
        const seen = new Set<string>();
        // Candidate trigger elements: an ARIA combobox/listbox-popup, OR a
        // shadcn/Radix `*-trigger` data-cy button. MEASURED 2026-06-23
        // (meilisearch): the clickable trigger carries `data-cy="…-trigger"`
        // but role=combobox lives on a separate inner node with NO data-cy, so
        // a role-only query found an un-addressable element. Collect both and
        // resolve each to its nearest stable data-cy selector.
        const candidates = new Set<Element>();
        for (const e of Array.from(
          document.querySelectorAll(
            "[role='combobox'],[aria-haspopup='listbox'],button[data-cy$='-trigger']",
          ),
        )) {
          candidates.add(e);
        }
        for (const el of Array.from(candidates)) {
          if (!isVisible(el)) continue;
          // Skip text/autocomplete inputs (role=combobox is also set on search
          // multiselects like MongoDB's "data types") — we click-to-pick from a
          // dropdown, never type into a filter box.
          if (el.tagName === "INPUT") continue;
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          // Unfilled signals: (1) Radix sets `data-placeholder` on a SelectTrigger
          // until a value is committed — present even when the trigger PREVIEWS
          // the first option (meilisearch's role/referral show "Founder/CTO" /
          // "Open Source" but stay uncommitted, so Next stays disabled); (2) empty
          // text; (3) a clear "Select…/Choose…/Pick…" placeholder. NOT
          // "search"/"add"/"type" — those are filter inputs we must not auto-pick.
          const hasPlaceholderAttr =
            el.hasAttribute("data-placeholder") ||
            el.querySelector("[data-placeholder]") !== null;
          const placeholderish =
            hasPlaceholderAttr ||
            txt.length === 0 ||
            /^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt);
          if (!placeholderish) continue;
          // Resolve a stable data-cy selector — own, or nearest ancestor — so
          // the locator click can't drift after the portal re-renders.
          const dcEl =
            el.getAttribute("data-cy") !== null ? el : el.closest("[data-cy]");
          const dc = dcEl !== null ? dcEl.getAttribute("data-cy") : null;
          const sel = dc !== null && dc.length > 0 ? `[data-cy="${dc}"]` : null;
          if (sel === null || seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        // LeafyGreen (MongoDB Atlas) path. Its select triggers are
        // `<button data-lgid="lg-button">Select</button>` with NO data-cy and NO
        // data-placeholder — the placeholder is the literal text "Select".
        // Address each by its index among lg-buttons (Playwright `>> nth=`),
        // since there's no stable per-trigger attribute. MEASURED 2026-06-23
        // (mongodb-atlas /atlas onboarding personalization wizard).
        const lgButtons = Array.from(
          document.querySelectorAll("button[data-lgid='lg-button']"),
        );
        for (let i = 0; i < lgButtons.length; i++) {
          const el = lgButtons[i];
          if (el === undefined || !isVisible(el)) continue;
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!/^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt)) continue;
          const sel = `button[data-lgid="lg-button"] >> nth=${i}`;
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        // Autocomplete-list combobox INPUTS that are part of the survey and
        // still EMPTY (mongodb's required "data types" multiselect). These are
        // distinct from free-text search boxes: `aria-autocomplete=list/both`
        // means a fixed option list, and an empty value means unfilled. Click +
        // pick-first via the same option locator. Addressed by index.
        const acInputs = Array.from(
          document.querySelectorAll("input[role='combobox'][aria-autocomplete]"),
        );
        for (let i = 0; i < acInputs.length; i++) {
          const el = acInputs[i] as HTMLInputElement | undefined;
          if (el === undefined || !isVisible(el)) continue;
          if ((el.value ?? "").trim().length > 0) continue;
          const sel = `input[role='combobox'][aria-autocomplete] >> nth=${i}`;
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        return out.slice(0, 8);
      });
    } catch {
      return [];
    }
    const filled: string[] = [];
    for (const sel of triggerSelectors) {
      try {
        const trigger = page.locator(sel).first();
        if ((await trigger.count().catch(() => 0)) === 0) continue;
        await trigger.click({ timeout: 5000 });
        await page.waitForTimeout(600);
        // An autocomplete input may only render its option list after a
        // keystroke — nudge it with ArrowDown so the option locator can resolve.
        if (sel.includes("input[")) {
          await page.keyboard.press("ArrowDown").catch(() => undefined);
          await page.waitForTimeout(400);
        }
        const option = page
          .locator(
            "[role='option']:not([aria-disabled='true']):not([data-disabled='true'])," +
              "[cmdk-item]:not([aria-disabled='true']):not([data-disabled='true'])," +
              "[data-lgid='lg-option']:not([aria-disabled='true'])",
          )
          .first();
        if ((await option.count().catch(() => 0)) > 0) {
          const name = ((await option.textContent().catch(() => "")) ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
          await option.click({ timeout: 5000 });
          filled.push(`${sel} → ${name}`);
          await page.waitForTimeout(300);
        }
        // Close the (multi-select) popover so the next trigger isn't occluded.
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(200);
      } catch {
        // Best-effort per combobox — a miss falls back to the planner.
      }
    }
    return filled;
  }

  // Satisfy an API-key/token creation form's required ACCESS-SCOPE controls when
  // its submit is disabled. Distinct from fillRequiredComboboxes (cmdk/Radix/
  // LeafyGreen survey selects): the "create a scoped credential" pattern gates
  // submit behind (a) a segmented "All access" / "Full access" button group that
  // starts unselected, and (b) a LemonSelect-style preset trigger
  // (`button[aria-haspopup="true"]` showing "Select…/Choose…") whose options
  // render in a body-portal Popover as `[role="menuitem"]` — NOT an
  // aria listbox, so the combobox filler's role/listbox query never sees it.
  // MEASURED 2026-06-24 (posthog /settings/user-api-keys "Create personal API
  // key": an "Organization & project access" segmented control + a "Select
  // preset" scopes dropdown both gate the aria-disabled "Create key"; picking
  // "All access" on each enables it and mints a phx_ key). Prefers the broadest
  // option so the resulting credential isn't dead-on-arrival. Idempotent and
  // tightly gated (callers only invoke it on a disabled submit).
  async satisfyScopePresets(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const done: string[] = [];
    const dialog = page.locator('[role="dialog"]').first();
    const root =
      (await dialog.count().catch(() => 0)) > 0 ? dialog : page.locator("body");

    // (1) Segmented access-scope buttons that start unselected. Exclude select
    // triggers (aria-haspopup) — those are handled in (2); a selected preset
    // trigger can also read "All access" and we must not re-open it here.
    try {
      const allAccess = root.locator(
        'button:not([aria-haspopup="true"])',
        { hasText: /^(?:all access|full access|all scopes)$/i },
      );
      const n = Math.min(await allAccess.count().catch(() => 0), 3);
      for (let i = 0; i < n; i += 1) {
        const b = allAccess.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        await b.click({ timeout: 4000 }).catch(() => undefined);
        done.push("access:all-access");
        await page.waitForTimeout(300);
      }
    } catch {
      // best-effort
    }

    // (2) LemonSelect-style preset triggers still showing a placeholder.
    try {
      const triggers = root.locator('button[aria-haspopup="true"]');
      const n = Math.min(await triggers.count().catch(() => 0), 4);
      for (let i = 0; i < n; i += 1) {
        const t = triggers.nth(i);
        if (!(await t.isVisible().catch(() => false))) continue;
        const txt = ((await t.textContent().catch(() => "")) ?? "")
          .replace(/\s+/g, " ")
          .trim();
        // Only act on an UNSELECTED select (a "Select…/Choose…/Pick…"
        // placeholder) — never re-pick one that already holds a value.
        if (!/^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt)) continue;
        await t.click({ timeout: 4000 }).catch(() => undefined);
        await page.waitForTimeout(700);
        const options = page.locator(
          '.Popover [role="menuitem"], .Popover [role="option"], ' +
            '[role="listbox"] [role="option"], .LemonDropdown [role="menuitem"]',
        );
        const broad = options.filter({ hasText: /all access|full access/i }).first();
        const pick =
          (await broad.count().catch(() => 0)) > 0 ? broad : options.first();
        if ((await pick.count().catch(() => 0)) > 0) {
          const name = ((await pick.textContent().catch(() => "")) ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 30);
          await pick.click({ timeout: 4000 }).catch(() => undefined);
          done.push(`preset:${name}`);
          await page.waitForTimeout(400);
        } else {
          await page.keyboard.press("Escape").catch(() => undefined);
        }
      }
    } catch {
      // best-effort
    }
    return done;
  }

  // True when a visible advance/submit button (Next / Continue / Create /
  // Register / Submit / Get started / Finish) is currently DISABLED. The gate
  // for the deterministic combobox filler: only auto-satisfy a survey's
  // required selects when something is actually blocking forward progress.
  async hasDisabledSubmit(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const re = /\b(?:next|continue|register|submit|get started|finish|complete|done|create account|sign up|create key|create token|create personal)\b/i;
        for (const el of Array.from(document.querySelectorAll("button,[role='button']"))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const disabled =
            (el as HTMLButtonElement).disabled === true ||
            el.getAttribute("aria-disabled") === "true" ||
            el.getAttribute("disabled") !== null;
          if (!disabled) continue;
          // A disabled advance/submit button gates the survey. Match by verb
          // text OR by type=submit (meilisearch's button-register is a
          // type=submit whose visible label is icon+text, so a text-only match
          // missed it).
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          const isSubmit = (el as HTMLButtonElement).type === "submit";
          if (re.test(txt) || isSubmit) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  }

  async extractScopedRouteCandidates(prefix: string): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(async (rawPrefix) => {
      const prefix = String(rawPrefix ?? "").replace(/^\/+|\/+$/g, "").toLowerCase();
      const candidates: string[] = [];
      const seen = new Set<string>();
      const add = (value: unknown) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(trimmed)) return;
        if (seen.has(trimmed)) return;
        seen.add(trimmed);
        candidates.push(trimmed);
      };
      const pathSegments = (href: string): string[] => {
        try {
          return new URL(href, location.origin).pathname.split("/").filter(Boolean);
        } catch {
          return [];
        }
      };

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const segs = pathSegments(anchor.getAttribute("href") ?? "");
        if ((segs[0] ?? "").toLowerCase() === prefix) add(segs[1]);
      }

      const walk = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (value === null || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const preferredKeys =
          prefix === "p" || prefix.startsWith("project")
            ? ["slug", "projectSlug", "currentProjectSlug", "lastViewedProjectSlug", "id"]
            : prefix.startsWith("org") || prefix.startsWith("organization")
              ? ["slug", "orgSlug", "organizationSlug", "id"]
              : prefix.startsWith("workspace")
                ? ["slug", "workspaceSlug", "id"]
                : ["slug", "id"];
        for (const key of preferredKeys) add(record[key]);
        for (const item of Object.values(record)) walk(item);
      };

      const inspectJsonText = (text: string) => {
        try {
          walk(JSON.parse(text));
        } catch {
          // Ignore non-JSON storage/API payloads.
        }
      };
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key !== null) inspectJsonText(localStorage.getItem(key) ?? "");
        }
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const key = sessionStorage.key(i);
          if (key !== null) inspectJsonText(sessionStorage.getItem(key) ?? "");
        }
      } catch {
        // Storage can be blocked in hardened contexts; DOM/API probes are enough.
      }

      const likelyListApi = (url: string): boolean => {
        const lower = url.toLowerCase();
        if (!lower.includes("api")) return false;
        if (prefix === "p" || prefix.startsWith("project")) return /projects?[\w.-]*list|list[\w.-]*projects?/.test(lower);
        if (prefix.startsWith("org") || prefix.startsWith("organization")) return /organi[sz]ations?[\w.-]*list|orgs?[\w.-]*list|list[\w.-]*(orgs?|organi[sz]ations?)/.test(lower);
        if (prefix.startsWith("workspace")) return /workspaces?[\w.-]*list|list[\w.-]*workspaces?/.test(lower);
        return /list/.test(lower);
      };
      const urls = Array.from(
        new Set(
          performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter(likelyListApi),
        ),
      ).slice(-8);
      for (const url of urls) {
        try {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 1_500);
          const res = await fetch(url, {
            credentials: "include",
            signal: controller.signal,
          });
          window.clearTimeout(timeout);
          if (!res.ok) continue;
          inspectJsonText(await res.text());
        } catch {
          // Best-effort only; resolver falls back to text/href matching.
        }
      }

      return candidates.slice(0, 20);
    }, prefix);
  }

  // Discrete strings an API key might occupy — for credential
  // extraction. Gathered so a key is read WHOLE and un-glued from its
  // neighbours: extractText() concatenates the whole <body>, which
  // fuses a key to an adjacent "Copy"/"Done" button with no separator.
  //
  // Two surfaces:
  //   1. input/textarea VALUES — a copy-to-clipboard key field. An
  //      input's value is not in textContent at all. Hidden and
  //      password fields are excluded (captcha tokens / the signup
  //      password), keeping this a clean credential surface.
  //   2. Each element's OWN direct text — the text nodes that are its
  //      immediate children, excluding descendants. A key in a
  //      <code>/<span>/<div> yields its clean value here even when a
  //      sibling button shares the same parent.
  // F10: read the clipboard contents (typically populated by the
  // user-modal's Copy button — every modern API-key reveal modal puts
  // the full secret here while displaying a masked stub). Requires
  // `clipboard-read` permission, granted at context creation. Returns
  // an empty string if the clipboard is empty; throws on permission
  // failure (caller catches and falls through to other paths).
  async readClipboard(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    // navigator.clipboard.readText() REJECTS ("Document is not focused") unless
    // the page has focus — which a sequence of Playwright actions + page.evaluate
    // reads between the copy-click and here can drop, silently yielding "". Bring
    // the tab to front and focus the document first. MEASURED 2026-06-24
    // (deepinfra: the copy-key clipboard held the 32-char key in a probe but the
    // replay's read came back empty — focus was the difference).
    await this.page.bringToFront().catch(() => undefined);
    await this.page.evaluate(() => window.focus()).catch(() => undefined);
    return await this.page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    });
  }

  // F10 fallback: ALL <input> / <textarea> values, ignoring
  // visibility and type filters. extractCredentialCandidates
  // deliberately skips `type=hidden` / `type=password` / invisible
  // elements (correct for general candidate scanning), but some
  // API-key modals stash the full key in a hidden input the masked
  // display reads from — and that needs to be reachable when the
  // visible extraction comes back truncated.
  async extractAllInputValues(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
        const value = el.value;
        if (value.trim().length > 0) out.push(value.trim());
      });
      return out;
    });
  }

  // Last-resort scan: walk innerText looking for credential-shaped
  // tokens (UUIDs and other long alnum+hyphen blobs) inside any DOM
  // subtree that ALSO contains a "Copy" / "Copy token" / "Copy to
  // clipboard" affordance. The Copy-button colocation is what tells
  // us "the UI is presenting this string AS a credential" — without
  // it, we'd false-positive on session IDs in URLs, cache-buster
  // query params, etc. Returns every match it finds; the caller picks
  // the first that survives extractApiKeyFromText.
  async extractCredentialsNearCopyButtons(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Find every Copy- OR reveal-class affordance. A secret table-cell value
      // (deepinfra's keys table) lives in a row next to BOTH a copy and a
      // toggle-visibility/reveal control — but those are often icon buttons
      // whose accessible NAME is the row's date, not "copy". So match the
      // element's id / class / data-testid too, which carry the semantic name
      // ("copy-key", "toggle-token-visibility"). Reveal patterns are scoped to
      // key/token/secret/visibility context so a generic "Show more" doesn't
      // anchor a harvest.
      const copyButtons = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, [role="button"], a, [aria-label]',
        ),
      ).filter((el) => {
        if (!isVisible(el)) return false;
        const name =
          `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.toLowerCase();
        // el.className is an SVGAnimatedString on SVG elements — read via attr.
        const attrs =
          `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("data-test") ?? ""}`.toLowerCase();
        const hay = `${name} ${attrs}`;
        return /\bcopy\b|clipboard|reveal|toggle[-_ ]?(?:token|visibility)|show[-_ ]?(?:key|token|secret|api)/.test(
          hay,
        );
      });
      // For each, walk up a few ancestors and dump the subtree's
      // innerText. The token is somewhere in there.
      const seen = new Set<string>();
      const harvest = (text: string): void => {
        if (text.length === 0 || text.length > 4096) return;
        // Tokenize by whitespace — each token is a separate candidate.
        text.split(/\s+/).forEach((tok) => {
          if (tok.length < 16 || tok.length > 256) return;
          if (seen.has(tok)) return;
          seen.add(tok);
          out.push(tok);
        });
      };
      for (const btn of copyButtons) {
        // The value often lives in the copy button's OWN aria-label/title
        // ("Copy to clipboard: GOCSPX-…", "Copy api key sk-…") rather than in
        // any visible text node — GCP's new client-secret reveal does exactly
        // this, so the innerText-only walk below would miss it entirely.
        harvest(`${btn.getAttribute("aria-label") ?? ""} ${btn.getAttribute("title") ?? ""}`.trim());
        // Then walk up a few ancestors and dump the subtree's innerText.
        let anc: HTMLElement | null = btn;
        for (let i = 0; i < 6 && anc !== null; i++) {
          anc = anc.parentElement;
        }
        if (anc === null) continue;
        harvest((anc.innerText ?? "").trim());
      }
      return out;
    });
  }

  // DOM-proximity labeled credential candidates. Walks every visible
  // input/code/text element looking for credential-shape strings,
  // pairs each one with its nearest credential-label text in the DOM
  // tree, and returns the labeled tuples for the multi-cred extractor
  // to fold into the credentials Record.
  //
  // Complements the Phase E planner-quoted extractor — when the
  // planner's prose doesn't explicitly label values (multi-cred page
  // where the planner missed one), this DOM-grounded pass picks them
  // up via the visible labels the page itself renders.
  //
  // Returns shape:
  //   { value: "<credential-shape string>",
  //     label: "<the closest matching label text>" | null,
  //     isMasked: true if the value looks like a redacted display
  //               (••••, ****, contains "•" or runs of "*") }
  //
  // The caller maps label
  // text to canonical credential keys using the same vocabulary the
  // Phase E parser uses.
  async extractLabeledCredentialCandidates(): Promise<
    Array<{
      value: string;
      label: string | null;
      isMasked: boolean;
      hasRevealButton: boolean;
    }>
  > {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const LABEL_PHRASES = [
        // Generic
        "api key", "api token", "api secret", "secret key", "access key",
        "access token", "auth token", "bearer token", "personal access token",
        "client id", "client secret", "client key",
        // Cloudinary
        "cloud name", "cloudname",
        // Algolia
        "application id", "app id", "admin api key", "search api key",
        "monitoring api key", "search-only api key",
        // Twilio
        "account sid", "auth token",
        // Stripe
        "publishable key", "secret key",
        // AWS
        "access key id", "secret access key",
        // OAuth1
        "consumer key", "consumer secret", "access token secret",
        // Misc
        "project api key", "personal api key", "organization id", "org id",
        "app key", "app secret",
        // Pusher (and other keys tables) label fields bare: key / secret /
        // cluster. Without these the value inherits the nearest recognized
        // label (the app_id field), mislabeling key + secret as "app id".
        "cluster", "key", "secret",
      ];

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const isCredentialShape = (s: string): boolean => {
        // Reasonable credential length range
        if (s.length < 6 || s.length > 256) return false;
        // Reject pure prose (spaces inside)
        if (/\s/.test(s)) return false;
        // Must include some entropy markers: digit + letter combo OR
        // a credential prefix like sk_/pk_/api_/ etc.
        const hasDigit = /\d/.test(s);
        const hasLetter = /[A-Za-z]/.test(s);
        if (!hasDigit && !hasLetter) return false;
        // Reject pure URL fragments
        if (/^https?:\/\//i.test(s)) return false;
        // Reject simple words / capitalized phrases
        if (/^[A-Za-z]+$/.test(s) && s.length < 12) return false;
        // Reject label-text masquerading as a value: a short token of only
        // letters + separators with NO digit (e.g. the literal "app_id" /
        // "secret" label text pusher renders next to the real value). Real
        // credentials carry a digit or are long; field labels don't.
        if (!hasDigit && /^[a-z][a-z_-]*$/i.test(s) && s.length < 16) return false;
        return true;
      };
      // Inline mirror of credential-shape.ts MASKED_DISPLAY_RE — page.evaluate
      // code can't import, so keep this regex byte-identical to the canonical.
      // Any mask glyph: bullet/circle, 3+ asterisks, ellipsis, or 3+ dots. (Was
      // `[•●⬤]{3,}|\*{4,}`, which MISSED the ellipsis masks GCP/Zilliz/S3 use.)
      const isMaskedShape = (s: string): boolean => /[•●⬤]|\*{3,}|…|\.{3,}/.test(s);

      // Compute element-center coords for proximity matching.
      const centerOf = (el: Element): { x: number; y: number } => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };

      // Collect every visible label-text bounding box on the page.
      // Each label entry = { phrase, x, y }. We pre-compute these so
      // the per-candidate inner loop is O(L) not O(L * N).
      type LabelHit = { phrase: string; x: number; y: number; el: Element };
      const labelHits: LabelHit[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        // Only consider DIRECT text content — child element text gets
        // claimed by THOSE elements' own label scans.
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim().toLowerCase();
        if (direct.length === 0 || direct.length > 100) return;
        // Normalize separators so underscore/hyphen field labels match the
        // space-form phrases: pusher renders "app_id" / "app_key" / "app_secret"
        // and "app_id".includes("app id") is false, so every value used to
        // inherit a far "App keys" heading. With this, each field label matches
        // its own phrase and wins the proximity match.
        const directNorm = direct.replace(/[_-]+/g, " ");
        for (const phrase of LABEL_PHRASES) {
          if (directNorm.includes(phrase)) {
            const c = centerOf(el);
            labelHits.push({ phrase, x: c.x, y: c.y, el });
            break; // one label per element is enough
          }
        }
      });

      // Detect reveal buttons (eye / show / unmask icons) — any visible
      // button or [role=button] / svg whose aria-label / title / text
      // matches the reveal vocabulary. We only check WHETHER one exists
      // near a candidate; the clicker (revealMaskedCredentials below)
      // does the actual click pass.
      const REVEAL_PATTERN = /\b(?:reveal|show|unmask|view|toggle|copy)\b/i;
      const revealButtons: Array<{ x: number; y: number; el: Element }> = [];
      document
        .querySelectorAll<HTMLElement>(
          'button, [role="button"], a, [aria-label], [title]',
        )
        .forEach((el) => {
          if (!isVisible(el)) return;
          const hay =
            `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
          if (!REVEAL_PATTERN.test(hay)) return;
          const c = centerOf(el);
          revealButtons.push({ x: c.x, y: c.y, el });
        });

      // For each candidate, find nearest label by Euclidean distance.
      const findNearestLabel = (x: number, y: number): string | null => {
        let best: { phrase: string; d: number } | null = null;
        for (const lh of labelHits) {
          const dx = lh.x - x;
          const dy = lh.y - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          // Conservative cap — labels more than 400px away from the
          // value aren't visually grouped with it. Roughly: a typical
          // table-row width.
          if (d > 400) continue;
          if (best === null || d < best.d) best = { phrase: lh.phrase, d };
        }
        return best?.phrase ?? null;
      };
      const hasNearbyReveal = (x: number, y: number): boolean => {
        for (const rb of revealButtons) {
          const dx = rb.x - x;
          const dy = rb.y - y;
          // Reveal/copy buttons are usually right next to the value —
          // 200px is generous.
          if (Math.sqrt(dx * dx + dy * dy) < 200) return true;
        }
        return false;
      };

      const seen = new Set<string>();
      const out: Array<{
        value: string;
        label: string | null;
        isMasked: boolean;
        hasRevealButton: boolean;
      }> = [];
      const pushCandidate = (value: string, el: Element): void => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return;
        const masked = isMaskedShape(trimmed);
        if (!masked && !isCredentialShape(trimmed)) {
          // 0.8.2-rc.17 — when the whole text-node string has
          // whitespace (Cloudinary's "Cloud name: dlq4xgrca" sits
          // in a SINGLE <div> with the label and value glued
          // together), isCredentialShape rejects the whole string.
          // Try to split on the canonical label-value separator
          // patterns ("Label: value", "Label = value", "Label\nvalue")
          // and re-evaluate each side. The token side gets the
          // candidate slot; the label side already lives on its own
          // (we don't need to push it). First-wins on duplicates.
          const split =
            /^([A-Za-z][A-Za-z _-]{1,40}?)\s*[:=]\s*([A-Za-z0-9._\-]{4,256})$/.exec(
              trimmed,
            );
          if (split === null) return;
          const valueToken = split[2];
          if (valueToken === undefined) return;
          if (!isCredentialShape(valueToken)) return;
          if (seen.has(valueToken)) return;
          seen.add(valueToken);
          const c = centerOf(el);
          const label = findNearestLabel(c.x, c.y);
          out.push({
            value: valueToken,
            label,
            isMasked: false,
            hasRevealButton: false,
          });
          return;
        }
        if (seen.has(trimmed)) return;
        seen.add(trimmed);
        const c = centerOf(el);
        const label = findNearestLabel(c.x, c.y);
        const hasReveal = masked ? hasNearbyReveal(c.x, c.y) : false;
        out.push({
          value: trimmed,
          label,
          isMasked: masked,
          hasRevealButton: hasReveal,
        });
      };

      // 0. Inline config snippets: a credential block listing multiple
      //    label = "value" pairs in one text run (pusher's App Keys page:
      //    app_id = "2164307" key = "..." secret = "..." cluster = "ap3").
      //    No separate label ELEMENTS exist, so the proximity matcher mislabels
      //    every value with whatever heading is nearest. Parse the label-value
      //    pairs straight from the page text — each pair's own label is
      //    authoritative. Runs FIRST so its correctly-labeled candidates win
      //    the `seen` dedup over the proximity passes. Noise pairs are harmless:
      //    a skill only matches the labels it asks for.
      const bodyText = document.body?.innerText ?? "";
      const INLINE_PAIR =
        /\b([A-Za-z][A-Za-z0-9_-]{1,40})\s*[:=]\s*["']?([A-Za-z0-9._-]{6,256})["']?/g;
      for (const m of bodyText.matchAll(INLINE_PAIR)) {
        const label = (m[1] ?? "").toLowerCase();
        const value = m[2] ?? "";
        if (!isCredentialShape(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ value, label, isMasked: false, hasRevealButton: false });
      }

      // 1. <input> / <textarea> values (visible only).
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (
          el instanceof HTMLInputElement &&
          (el.type === "hidden" || el.type === "password")
        ) return;
        if (!isVisible(el)) return;
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : "";
        if (value.length > 0) pushCandidate(value, el);
      });

      // 2. Direct text content in visible leaf elements.
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim();
        if (direct.length === 0 || direct.length > 256) return;
        pushCandidate(direct, el);
      });

      // 3. Structural containers (code/pre/kbd) where the credential
      //    is interpolated through nested spans.
      document
        .querySelectorAll('code, pre, kbd, samp, [role="textbox"]')
        .forEach((el) => {
          if (!isVisible(el)) return;
          const full = (el.textContent ?? "").trim();
          if (full.length === 0 || full.length > 256) return;
          pushCandidate(full, el);
        });

      return out;
    });
  }

  // Click every visible "Reveal" / "Show" / "Eye" / "Copy" button on
  // the page that sits next to a masked credential display. Used as a
  // pre-extract pass for services like Cloudinary that hide the
  // api_secret behind a click-to-reveal icon. Best-effort: failures
  // don't throw; subsequent extract pass tries whatever surfaced.
  // Returns the number of buttons successfully clicked.
  async revealMaskedCredentials(): Promise<{
    clicked: number;
    diagnostic: string[];
  }> {
    if (this.page === null) throw new Error("Browser not started");
    const page = this.page;
    const probe = await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Walk up to the nearest "row-like" ancestor — a <tr>, a <li>,
      // or any container ≤ 800px wide with limited height. Cloudinary,
      // Algolia, Twilio all use table rows; clicking the reveal in
      // ROW X must populate the value in ROW X, not some neighbor row.
      const rowAncestor = (el: Element): Element | null => {
        let cur: Element | null = el;
        for (let i = 0; i < 8 && cur !== null; i++) {
          if (cur.tagName === "TR" || cur.tagName === "LI") return cur;
          const r = cur.getBoundingClientRect();
          if (r.width > 200 && r.width < 900 && r.height < 200) return cur;
          cur = cur.parentElement;
        }
        return el.parentElement;
      };

      // 1. Find masked-display elements + their row containers.
      type Masked = { el: Element; row: Element | null };
      const masked: Masked[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        const t = direct.trim();
        if (t.length < 3 || t.length > 100) return;
        if (!/[•●⬤*]{3,}/.test(t) && !/^[•*]+$/.test(t)) return;
        masked.push({ el, row: rowAncestor(el) });
      });
      document
        .querySelectorAll<HTMLInputElement>('input[type="password"]')
        .forEach((el) => {
          if (!isVisible(el)) return;
          masked.push({ el, row: rowAncestor(el) });
        });
      const selectorFor = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const all = Array.from(document.querySelectorAll(tag));
        const idx = all.indexOf(el);
        return `${tag}:nth-of-type(${idx + 1})`;
      };

      // No masked placeholder anywhere — but some consoles hide the key
      // ENTIRELY behind a "View/Show Key" button with no ••• shown at all
      // (Zilliz's "View My Personal Key"). The row-anchored pass below has
      // nothing to anchor on, so without this the reveal pass bails and the
      // extractor reports no_legit_credential on a page that DOES have a key.
      // Anchor-free fallback: click a button whose label pairs a SAFE reveal
      // verb with a credential noun, excluding destructive verbs (reset/
      // regenerate/delete/revoke/rotate would mint or destroy a key, not
      // reveal the existing one).
      if (masked.length === 0) {
        const KEY_NOUN = /\b(?:api\s*key|secret|token|credential|personal\s+key|access\s+key|key)\b/i;
        const SAFE_REVEAL = /\b(?:view|show|reveal|display|see)\b/i;
        const DESTRUCTIVE = /\b(?:reset|regenerat\w*|delete|revoke|rotate|create|new|remove|add|download)\b/i;
        const out: string[] = [];
        const diag: string[] = [];
        document
          .querySelectorAll<HTMLElement>('button, [role="button"], a[role="button"]')
          .forEach((el) => {
            if (!isVisible(el)) return;
            const hay =
              `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`
                .replace(/\s+/g, " ")
                .trim();
            if (hay.length === 0 || hay.length > 60) return;
            if (!SAFE_REVEAL.test(hay) || !KEY_NOUN.test(hay)) return;
            if (DESTRUCTIVE.test(hay)) return;
            out.push(selectorFor(el));
            diag.push(`anchorless_key_reveal:"${hay.slice(0, 40)}"`);
          });
        return {
          selectors: out,
          diagnostic: out.length > 0 ? diag : ["no_masked_displays"],
        };
      }

      // 2. Classify candidate buttons. Prefer SHOW/REVEAL/EYE; fall
      //    back to COPY only when no show button exists in the row.
      //    (Copy generally puts value in clipboard, not in DOM —
      //    which our extractor can't read in headless.)
      const SHOW_PATTERN = /\b(?:reveal|show|unmask|view|toggle|eye)\b/i;
      const COPY_PATTERN = /\bcopy\b/i;

      const collectButtonsInRow = (
        row: Element | null,
      ): { showBtns: Element[]; copyBtns: Element[] } => {
        const showBtns: Element[] = [];
        const copyBtns: Element[] = [];
        if (row === null) return { showBtns, copyBtns };
        row
          .querySelectorAll<HTMLElement>(
            'button, [role="button"], a[role="button"], [aria-label], [title]',
          )
          .forEach((el) => {
            if (!isVisible(el)) return;
            const hay =
              `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.className ?? ""}`;
            if (SHOW_PATTERN.test(hay)) showBtns.push(el);
            else if (COPY_PATTERN.test(hay)) copyBtns.push(el);
          });
        return { showBtns, copyBtns };
      };

      const selectors: string[] = [];
      const diagnostic: string[] = [];
      const usedRows = new Set<Element>();
      for (const m of masked) {
        if (m.row === null) continue;
        if (usedRows.has(m.row)) continue;
        usedRows.add(m.row);
        const { showBtns, copyBtns } = collectButtonsInRow(m.row);
        if (showBtns.length > 0) {
          const btn = showBtns[0]!;
          const sel = selectorFor(btn);
          selectors.push(sel);
          const label = (btn.textContent ?? btn.getAttribute("aria-label") ?? btn.getAttribute("title") ?? "").trim().slice(0, 40);
          diagnostic.push(`row→show:"${label}"→${sel}`);
        } else if (copyBtns.length > 0) {
          diagnostic.push(
            `row→copy_only_no_show_button (copy='${copyBtns.length} found' — skipped, would only populate clipboard not DOM)`,
          );
        } else {
          diagnostic.push("row→no_buttons_found");
        }
      }
      return { selectors, diagnostic };
    });

    let clicked = 0;
    for (const sel of probe.selectors) {
      try {
        await page.locator(sel).first().click({ timeout: 1500 });
        clicked += 1;
        // Reveal click often triggers a fetch (Cloudinary returns the
        // secret over an XHR before populating the DOM). Wait longer
        // than the previous 150ms.
        await this.sleep(800);
      } catch {
        // Click failed — best-effort.
      }
    }
    return { clicked, diagnostic: probe.diagnostic };
  }

  async extractCredentialCandidates(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      document.querySelectorAll("input, textarea").forEach((el) => {
        // Only text-shaped inputs can RENDER a credential. A checkbox/
        // radio/button's `value` is a markup constant, not page content —
        // zilliz's CookieScript banner ships `<input type="checkbox"
        // value="personalization">` and those words sit earlier in DOM
        // order than the real key, so the validator-shaped scan tier was
        // returning them as the "credential".
        if (
          el instanceof HTMLInputElement &&
          !["text", "search", "url", "tel", "number", "email", ""].includes(el.type)
        ) {
          return;
        }
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : "";
        if (value.trim().length > 0 && isVisible(el)) out.push(value.trim());
      });
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim();
        // A real key is short; a long blob is a paragraph, not a key.
        if (direct.length > 0 && direct.length <= 256) out.push(direct);
      });
      // Structural containers (<code>, <pre>, kbd, samp, [role=textbox])
      // often render a credential by interpolating it through nested
      // <span>s — the loop above sees an empty direct-text and skips
      // them. Push the full textContent so a UUID built as
      // <code><span>7</span><span>5</span>…</code> is still scannable.
      document
        .querySelectorAll('code, pre, kbd, samp, [role="textbox"]')
        .forEach((el) => {
          if (!isVisible(el)) return;
          const full = (el.textContent ?? "").trim();
          if (full.length > 0 && full.length <= 256) out.push(full);
        });
      return out;
    });
  }

  // Wait for the signup form to actually render before the planner
  // screenshots the page (F1). SPA and two-stage signup pages render
  // the form after JS executes; planning against a pre-render
  // skeleton makes the planner emit plausible-but-wrong selectors and
  // every executed action then times out. Best-effort — both waits
  // swallow their own timeout so the planner always still runs.
  async waitForFormReady(timeoutMs = 15000): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // PERF: networkidle almost never settles on real signup pages
    // (analytics sockets / long-poll / Intercom widgets keep traffic
    // flowing indefinitely), so the previous 15s ceiling was 15s of
    // pure deadtime per call. Cap at 1500ms so the bot gets the
    // signal-when-it's-real and moves on otherwise. domcontentloaded
    // is the real "DOM is parsed" signal; networkidle here is just
    // a best-effort polish wait for the SPA to settle.
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    } catch {
      // already past domcontentloaded → fine
    }
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 1_500 });
    } catch {
      // expected on most modern pages — fall through to the element wait.
    }
    // F13 follow-up — if we landed on a full-page anti-bot interstitial
    // (Cloudflare "Just a moment..." / Turnstile pre-clear / similar),
    // wait for it to clear and the real page to render. networkidle
    // sometimes fires DURING the interstitial because Cloudflare keeps
    // the connection quiet between the verify-handshake and the
    // redirect to the real page. Without this, the bot snapshots a
    // 2-element interstitial inventory and bails.
    await this.waitForAntiBotInterstitialToClear(timeoutMs);
    // rc.33 — extended the element-wait selector to match the broader
    // inventory walk added in rc.26 (menuitem/option/combobox plus
    // anchors). Porter and Koyeb's API-tokens pages are nested SPAs
    // that initially render with NO <input>/<button> — just <a> and
    // role=button divs. The old selector timed out at 15s on those
    // pages, the planner saw an empty inventory, and the post-verify
    // loop burned rounds clicking nothing.
    try {
      await this.page.waitForSelector(
        'input, button, textarea, select, a[href], [role="button"], [role="menuitem"]',
        { state: "visible", timeout: timeoutMs },
      );
    } catch {
      // No interactive element appeared in time — let the planner run
      // anyway; it fails cleanly rather than hanging.
    }
    // The generic wait above is satisfied by ANY interactive element —
    // on a signup page with marketing chrome (links, marketplace badges)
    // that fires while the actual auth widget is still an async spinner.
    // The bot then snapshots a form-less inventory and bails
    // `oauth_required` ("no email/password form"). MEASURED 2026-06-11
    // (zilliz /signup: right-panel spinner, marketing copy on the left).
    // So: if a loading spinner is visible AND no auth-form signal exists
    // yet, give the widget a bounded extra wait to hydrate.
    await this.waitForAuthWidgetHydration();
  }

  // Bounded poll for an auth-form signal when the page is still showing a
  // loading spinner. Strictly additive: returns immediately unless a
  // spinner is visible AND no auth signal (email/password input or a
  // provider/sign-up button) is present yet. Best-effort — never throws.
  async waitForAuthWidgetHydration(timeoutMs = 8_000): Promise<void> {
    if (!this.page) return;
    const authWidgetHydrationProbe = String.raw`(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const anyVis = (sel) =>
        Array.from(document.querySelectorAll(sel)).some(vis);
      const hasAuthInput = anyVis(
        'input[type="email"],input[type="password"],input[name="email" i],input[name="password" i]',
      );
      let hasAuthButton = false;
      const re = /\b(sign\s?up|continue with|log ?in with|with google|with github|with sso|create account)\b/i;
      for (const el of Array.from(
        document.querySelectorAll('button,a[href],[role="button"]'),
      )) {
        if (!vis(el)) continue;
        if (re.test((el.textContent ?? "").trim())) {
          hasAuthButton = true;
          break;
        }
      }
      const spinnerVisible = anyVis(
        '[role="progressbar"],[aria-busy="true"],[class*="spin" i],[class*="loading" i],[class*="loader" i],.ant-spin,.MuiCircularProgress-root',
      );
      return { hasAuth: hasAuthInput || hasAuthButton, spinnerVisible };
    })()`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = (await Promise.race([
          this.page.evaluate(authWidgetHydrationProbe),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("auth widget probe timed out")), 1_500),
          ),
        ])) as {
          hasAuth: boolean;
          spinnerVisible: boolean;
        };
        // Done the moment an auth signal appears, or once nothing is
        // spinning anymore (no point waiting on a page that simply has
        // no auth widget — a true OAuth-less/blank page bails honestly).
        if (state.hasAuth) return;
        if (!state.spinnerVisible) return;
      } catch {
        return; // navigation / context teardown — let the caller proceed
      }
      await this.sleep(500);
    }
  }

  // rc.33 — wait for the DOM to grow past a minimum interactive-
  // element count, polling every 500ms up to timeoutMs. The
  // single-element wait in waitForFormReady is fast-path; this is
  // for SPAs where DOMContentLoaded fires almost immediately but the
  // React/Vue/Svelte tree takes 5-15s more to actually render. Used
  // after navigate() in the post-verify loop so the planner doesn't
  // see a 0-button page that's still rendering. Best-effort —
  // returns whenever the count is reached OR the timeout elapses.
  async waitForInteractiveDom(
    minElements = 5,
    timeoutMs = 20_000,
  ): Promise<void> {
    if (!this.page) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const count = await Promise.race([
          this.page.evaluate((min: number) => {
            const sels =
              'input,textarea,select,button,a[href],[role="button"],[role="menuitem"],[role="option"]';
            const nodes = Array.from(document.querySelectorAll(sels));
            let visible = 0;
            for (const n of nodes) {
              const el = n as HTMLElement;
              const r = el.getBoundingClientRect();
              if (r.width >= 2 && r.height >= 2) visible++;
              if (visible >= min) return visible;
            }
            return visible;
          }, minElements),
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error("interactive DOM probe timed out")), 1_500),
          ),
        ]);
        if (count >= minElements) return;
      } catch {
        // Page may be mid-navigation — try again on the next tick.
      }
      await this.sleep(500);
    }
  }

  // Find and click an "Accept"-class button to dismiss any visible
  // cookie/consent banner. Returns the clicked button's text when a
  // dismiss fired, or null when no banner / no clickable affordance
  // was found. Best-effort: never throws.
  //
  // Strategy: cookie-banner CTAs use a very narrow vocabulary across
  // the entire web ("Accept all", "Allow all", "Got it", "Reject all"
  // …). Instead of trying to enumerate every vendor's container
  // selector (osano/onetrust/cookiebot/trustarc/iubenda/quantcast/
  // truste/usercentrics/etc. — never complete), we just hunt for any
  // visible button whose TEXT matches the canonical CTA. Risk of a
  // false positive (clicking a non-consent button whose text happens
  // to match) is acceptable because the strings we accept are
  // extremely banner-specific. We don't match bare "accept" / "ok" /
  // "continue" — too generic to be safe.
  async dismissConsentBanner(): Promise<string | null> {
    if (!this.page) return null;
    // Prefer-order: most specific (and most clearly consent-only)
    // first. First visible button matching one of these wins.
    const PREFER_ORDER: RegExp[] = [
      /^\s*(?:accept all cookies|accept all|allow all cookies|allow all)\s*$/i,
      /^\s*(?:i accept|i agree|i understand|got it!?|sounds good)\s*$/i,
      /^\s*(?:accept|agree)\s*(?:cookies|all|&\s*close)?\s*$/i,
      /^\s*(?:reject all cookies|reject all|decline all|deny all)\s*$/i,
    ];
    let target: { x: number; y: number; text: string } | null = null;
    try {
      target = await this.page.evaluate(
        ({ patterns }) => {
          const candidates = Array.from(
            document.querySelectorAll('button, a, [role="button"], [role="link"]'),
          ) as HTMLElement[];
          const visible = (el: HTMLElement): boolean => {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const s = window.getComputedStyle(el);
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              parseFloat(s.opacity || "1") > 0.01
            );
          };
          for (const reStr of patterns) {
            const re = new RegExp(reStr, "i");
            const hit = candidates.find(
              (c) => visible(c) && re.test((c.textContent || "").trim()),
            );
            if (hit !== undefined) {
              const r = hit.getBoundingClientRect();
              return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                text: (hit.textContent || "").trim().slice(0, 40),
              };
            }
          }
          return null;
        },
        { patterns: PREFER_ORDER.map((p) => p.source) },
      );
    } catch {
      return null;
    }
    if (target === null) return null;
    try {
      await this.page.mouse.click(target.x, target.y);
      // Wait for the banner to fade out + any post-dismiss reflow
      // (e.g. lazy-rendering the previously-blocked OAuth chooser).
      // Try networkidle first for SPA re-renders, fall back to a
      // fixed dwell.
      await this.page
        .waitForLoadState("networkidle", { timeout: 3000 })
        .catch(() => undefined);
      await this.page.waitForTimeout(800);
      return target.text;
    } catch {
      return null;
    }
  }

  // Cloudflare and similar gateways serve a full-page interstitial
  // ("Just a moment..." / Turnstile pre-clear) before the real page.
  // The challenge usually clears within ~5-10s — the bot just needs
  // to wait. Detected from page text patterns rather than URL: the
  // URL stays the same; the body replaces.
  //
  // Returns when the interstitial is gone, or after `timeoutMs` if it
  // never cleared. Best-effort: any unexpected error returns early
  // rather than failing the whole signup.
  private async waitForAntiBotInterstitialToClear(timeoutMs: number): Promise<void> {
    if (!this.page) return;
    const first = await this.pollUntilInterstitialClears(timeoutMs);
    // Never saw an interstitial, or saw one and it cleared on its own —
    // nothing more to do.
    if (!first.detected || first.cleared) return;
    // Still on the interstitial at the deadline. If Cloudflare reported
    // the challenge PASSED ("Verification successful"), the redirect is
    // just racing/stuck — be patient through ANOTHER full window before
    // touching anything (a reload mid-redirect can re-arm the challenge).
    if (first.verificationPassed) {
      const patient = await this.pollUntilInterstitialClears(timeoutMs);
      if (patient.cleared) return;
      // "Verification successful" but the page never advances is the
      // signature of a STALE cf_clearance cookie — issued on a prior visit
      // (often a different egress IP), which CF matches ("successful") but
      // the origin then rejects, looping forever on "Waiting for the page
      // to load." MEASURED: a clean profile clears codesandbox's challenge
      // in ~12s; the stale cookie is what stalls the shared profile. Drop
      // the CF cookies to force a FRESH challenge, then reload.
      if (await this.clearCloudflareCookiesAndRetry(timeoutMs)) return;
      // Or the auto-redirect simply stalled with a still-valid clearance —
      // re-navigate past the one-shot challenge token.
      if (await this.forceNavigatePastClearedChallenge()) return;
    }
    // Force the real page: now that the cf_clearance cookie is set, a
    // reload often renders it. domcontentloaded (not networkidle) — the
    // real page is usually a heavy SPA that never reaches networkidle, so
    // waiting for it just burns the budget back into a timeout. (If it's a
    // server-side risk-score block — fingerprint/IP — reload won't help,
    // but the caller's inventory diagnostic will still surface the block.)
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch {
      // reload failed — proceed with what's there
    }
    await this.pollUntilInterstitialClears(Math.max(5000, timeoutMs / 2));
  }

  // Drop Cloudflare's anti-bot cookies (cf_clearance + __cf_bm) so the next
  // request triggers a FRESH managed challenge, then reload and wait for it
  // to clear. Scoped to cookie NAME — only CF's own cookies are removed, so
  // an OAuth provider's session on accounts.google.com / github.com is
  // untouched. A fresh challenge on a residential IP clears in ~12-15s, so
  // we give it a generous window. Returns true if the interstitial is gone.
  private async clearCloudflareCookiesAndRetry(timeoutMs: number): Promise<boolean> {
    if (!this.page || !this.context) return false;
    try {
      await this.context.clearCookies({ name: "cf_clearance" });
      await this.context.clearCookies({ name: "__cf_bm" });
    } catch {
      // clearCookies filter unsupported / failed — nothing to retry on.
      return false;
    }
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      // reload failed — still give the poll a chance below.
    }
    const after = await this.pollUntilInterstitialClears(Math.max(20_000, timeoutMs));
    return after.cleared || !after.detected;
  }

  // With a CONFIRMED Cloudflare pass, re-navigate to the current URL with
  // the one-shot `__cf_chl_*` challenge token stripped — the cf_clearance
  // cookie is already set, so the edge serves the real page instead of the
  // stuck redirect. Returns true if the interstitial is gone afterwards.
  // Returns false (caller falls back to a plain reload) when there's no
  // token to strip or the navigation didn't clear the gate.
  private async forceNavigatePastClearedChallenge(): Promise<boolean> {
    if (!this.page) return false;
    const cleaned = stripCloudflareChallengeParams(this.page.url());
    if (!cleaned) return false;
    try {
      await this.page.goto(cleaned, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      return false;
    }
    const after = await this.pollUntilInterstitialClears(Math.max(5000, 8000));
    // cleared = saw it then it went away; !detected = the real page rendered
    // immediately (no interstitial on the post-nav page at all).
    return after.cleared || !after.detected;
  }

  // One poll loop. `detected` = an interstitial was observed at least
  // once; `cleared` = it was observed AND then went away (vs. still there
  // at the deadline); `verificationPassed` = Cloudflare reported the
  // challenge succeeded at some point during the wait (see
  // classifyInterstitialText).
  private async pollUntilInterstitialClears(
    timeoutMs: number,
  ): Promise<{ detected: boolean; cleared: boolean; verificationPassed: boolean }> {
    if (!this.page) return { detected: false, cleared: false, verificationPassed: false };
    const deadline = Date.now() + timeoutMs;
    let detected = false;
    let verificationPassed = false;
    while (Date.now() < deadline) {
      let title = "";
      let bodyText = "";
      try {
        title = await this.page.title();
        bodyText = await this.page.evaluate(() =>
          (document.body?.innerText ?? "").slice(0, 500),
        );
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const c = classifyInterstitialText(title + " " + bodyText);
      if (c.verificationPassed) verificationPassed = true;
      if (!c.onInterstitial) {
        if (detected) {
          // Give the freshly-revealed page a tick to hydrate before
          // the inventory scan.
          await new Promise((r) => setTimeout(r, 800));
        }
        return { detected, cleared: detected, verificationPassed };
      }
      detected = true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { detected, cleared: false, verificationPassed };
  }

  // Walk the live DOM (piercing open shadow roots) and return every
  // visible interactive element with a bot-computed selector (F3 T1).
  // The planner picks from this inventory instead of inventing
  // selector strings. Selectors prefer #id then [name] — Playwright's
  // CSS engine pierces open shadow roots, so those resolve for
  // shadow-DOM fields too.
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    if (!this.page) throw new Error("Browser not started");
    const raw = await this.page.evaluate(() => {
      const SELECTOR =
        // rc.26 — added Radix/Headless-UI menu + option items so
        // dropdown contents (Fireworks "Create API Key" → API Key /
        // Service Account menu, Sentry's per-row permissions) end up
        // in the planner's inventory.
        // rc.35 — added [role="link"] (Google account-chooser cards
        // are <div role="link" data-identifier="…">), and <label>
        // (Koyeb's onboarding renders each radio choice as a styled
        // <label> wrapping a sr-only <input type=radio>; the visible
        // click target is the label, but the bot's inventory selector
        // didn't catch labels so the planner had no clickable target
        // matching the visible button text).
        // T38 — added [role="radio"] for onboarding wizards that mark
        // each card with a semantic radio role (some Cloudinary /
        // Stytch flows). Card-radio clusters with NO role are detected
        // post-extraction by assignCardRadioGroups using bounding-box
        // similarity, so this addition is just for the semantically-
        // tagged case.
        'input,textarea,select,button,a,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="combobox"],[contenteditable=""],[contenteditable="true"]';

      // Collect candidates across the document and every open shadow
      // root. Closed shadow roots are unreachable — accepted.
      const collected: Element[] = [];
      const walk = (root: Document | ShadowRoot): void => {
        // Defensive: a root with no querySelectorAll (a detached/closed
        // node surfaced mid-render by Descope-style web components on
        // app.redislabs.com / console.weaviate.cloud) used to crash the
        // whole inventory with "Cannot read properties of undefined
        // (reading 'querySelectorAll')", failing the run before the
        // planner ever saw the page. Skip such a node instead.
        //
        // `== null` (not `=== null`) is load-bearing: `el.shadowRoot` is
        // typed `ShadowRoot | null`, but a detached/closed custom element
        // can yield `undefined` at runtime. The recursion below calls
        // `walk(el.shadowRoot)` whenever it isn't `null`, so an `undefined`
        // shadowRoot reaches here and `typeof undefined.querySelectorAll`
        // THROWS before the typeof guard can fire — exactly the #59
        // redis-cloud crash, which recurred 2026-06-03 even with the
        // null-only guard in place. The loose check covers both.
        if (root == null || typeof root.querySelectorAll !== "function") return;
        root.querySelectorAll(SELECTOR).forEach((n) => collected.push(n));
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot !== null) walk(el.shadowRoot);
        });
      };
      walk(document);

      // 0.8.3-rc.1 — also collect OAuth-affordance iframes. Modern
      // signup pages (Mixpanel, many Next.js sites) render "Continue
      // with Google" via Google's GIS iframe at
      // `accounts.google.com/gsi/button` — cross-origin, so the
      // button INSIDE the iframe isn't in our DOM. The iframe element
      // ITSELF is clickable from the parent page though; clicking its
      // bounding box dispatches the click event into the iframe, and
      // Google's button-handler then opens the OAuth popup. We
      // surface these iframes as synthetic OAuth buttons (with a
      // visibleText that findOAuthButton matches) so the OAuth-first
      // scan can pick them up.
      document
        .querySelectorAll<HTMLIFrameElement>('iframe[src*="accounts.google.com/gsi/button"]')
        .forEach((n) => collected.push(n));

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = window.getComputedStyle(el);
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          parseFloat(s.opacity || "1") > 0.01
        );
      };

      // G12 — visually-hidden checkbox/radio surfacing. Custom-styled
      // TOS checkboxes are real `<input type=checkbox>` elements with
      // `opacity:0` / `sr-only` styling behind a styled <label>; they
      // are user-clickable (the label's click event fires the input)
      // and `page.check()` reaches them, but isVisible() drops them
      // and the inventory has nothing for the planner to target.
      // Mistral's org-creation TOS gate is the canonical case.
      //
      // Returns true when the hidden input is a checkbox/radio AND
      // its label (associated by `for=` or by ancestor wrap) is
      // itself visible. Standalone hidden checkboxes outside any
      // label stay filtered — they're typically state-tracking inputs
      // the bot must not toggle.
      const isCheckableHiddenByStyledLabel = (el: Element): boolean => {
        if (!(el instanceof HTMLInputElement)) return false;
        const t = el.type;
        if (t !== "checkbox" && t !== "radio") return false;
        // Style-hidden (sr-only / opacity:0) is the case to recover;
        // genuinely display:none is intentionally hidden state, skip.
        const s = window.getComputedStyle(el);
        if (s.display === "none") return false;
        // Find an associated label and check its visibility.
        const id = el.getAttribute("id");
        let label: Element | null = null;
        if (id !== null && id.length > 0) {
          try {
            label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          } catch {
            /* malformed id — fall through */
          }
        }
        if (label === null) label = el.closest("label");
        if (label === null) return false;
        return isVisible(label);
      };

      const clean = (s: string | null | undefined): string | null => {
        if (s === null || s === undefined) return null;
        const t = s.replace(/\s+/g, " ").trim();
        return t.length === 0 ? null : t.slice(0, 120);
      };

      const labelFor = (el: Element): string | null => {
        const id = el.getAttribute("id");
        if (id !== null && id.length > 0) {
          try {
            const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (l !== null) return clean(l.textContent);
          } catch {
            /* malformed id — fall through */
          }
        }
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy !== null && labelledBy.trim().length > 0) {
          const parts: string[] = [];
          for (const part of labelledBy.split(/\s+/)) {
            const t = clean(document.getElementById(part)?.textContent);
            if (t !== null) parts.push(t);
          }
          if (parts.length > 0) return clean(parts.join(" "));
        }
        const anc = el.closest("label");
        const ancestorLabel = anc !== null ? clean(anc.textContent) : null;
        if (ancestorLabel !== null) return ancestorLabel;

        let cur: Element | null = el;
        for (let depth = 0; depth < 3 && cur !== null; depth += 1) {
          let sib = cur.previousElementSibling;
          for (let scanned = 0; scanned < 4 && sib !== null; scanned += 1) {
            const nestedLabel = clean(sib.querySelector("label")?.textContent);
            if (nestedLabel !== null) return nestedLabel;
            const labelish =
              sib.tagName.toLowerCase() === "label" ||
              /\b(label|field|form|control)\b/i.test(sib.getAttribute("class") ?? "");
            const t = clean(sib.textContent);
            if (
              t !== null &&
              t.length <= 80 &&
              !/[{};]/.test(t) &&
              (labelish || t.split(/\s+/).length <= 8)
            ) {
              return t;
            }
            sib = sib.previousElementSibling;
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const inConsent = (el: Element): boolean =>
        el.closest(
          '[class*="osano"],[id*="onetrust"],[id*="cookie"],[class*="cookie-consent"],[class*="cookie-banner"],[class*="cookieConsent"]',
        ) !== null;

      // Accessible label of a descendant icon — an icon-only "Sign in
      // with Google" button carries no text, but its <img alt>, its
      // <svg><title>, or a descendant [aria-label] names the provider.
      const iconLabelFor = (el: Element): string | null => {
        const img = el.querySelector("img[alt]");
        if (img !== null) {
          const alt = clean(img.getAttribute("alt"));
          if (alt !== null) return alt;
        }
        const svgTitle = el.querySelector("svg title");
        if (svgTitle !== null) {
          const t = clean(svgTitle.textContent);
          if (t !== null) return t;
        }
        const labelled = el.querySelector("[aria-label]");
        if (labelled !== null) {
          const l = clean(labelled.getAttribute("aria-label"));
          if (l !== null) return l;
        }
        return null;
      };

      const selectorFor = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        let base: string;
        const testId =
          el.getAttribute("data-testid") ??
          el.getAttribute("data-test-id") ??
          el.getAttribute("data-test") ??
          el.getAttribute("data-cy") ??
          el.getAttribute("data-qa");
        const id = el.getAttribute("id");
        const name = el.getAttribute("name");
        if (testId !== null && testId.length > 0) {
          const attr =
            el.hasAttribute("data-testid") ? "data-testid" :
            el.hasAttribute("data-test-id") ? "data-test-id" :
            el.hasAttribute("data-test") ? "data-test" :
            el.hasAttribute("data-cy") ? "data-cy" :
            "data-qa";
          base = `[${attr}="${CSS.escape(testId)}"]`;
        } else if (id !== null && /^[A-Za-z][\w-]*$/.test(id)) {
          base = `#${id}`;
        } else if (name !== null && name.length > 0) {
          base = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        } else {
          // Structural fallback — a short nth-of-type path.
          const parts: string[] = [];
          let node: Element | null = el;
          for (let depth = 0; depth < 4 && node !== null; depth++) {
            const cur: Element = node;
            const t = cur.tagName.toLowerCase();
            const parent: Element | null = cur.parentElement;
            if (parent === null) {
              parts.unshift(t);
              break;
            }
            const sibs = Array.from(parent.children).filter(
              (c) => c.tagName === cur.tagName,
            );
            const idx = sibs.indexOf(cur) + 1;
            parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${idx})` : t);
            node = parent;
          }
          base = parts.join(" > ");
        }
        // Guarantee the selector resolves to exactly this element. A
        // 4-level path (or a stray duplicate id) can be ambiguous —
        // Back4App's "Continue with email" path also matched a
        // "Flexibility" tab, and Playwright strict mode then refuses
        // to act. `>> nth=` is Playwright syntax that pins the exact
        // match. (querySelectorAll can't see into shadow roots, so a
        // shadow element's count reads 0 — fine, it returns base.)
        try {
          const matches = document.querySelectorAll(base);
          if (matches.length <= 1) return base;
          const idx = Array.prototype.indexOf.call(matches, el);
          return idx >= 0 ? `${base} >> nth=${idx}` : base;
        } catch {
          return base;
        }
      };

      const slug = (s: string | null, fallback: string): string => {
        const base = (s ?? fallback)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48);
        return base.length > 0 ? base : fallback;
      };

      const directLabel = (el: Element): string | null =>
        clean(el.getAttribute("aria-label")) ??
        clean(el.getAttribute("title")) ??
        clean(el.getAttribute("name")) ??
        clean(el.textContent);

      const isFormControlElement = (el: Element): boolean =>
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;

      const regionFor = (el: Element): Element | null =>
        el.closest(
          '[role="dialog"],dialog,[aria-modal="true"],nav,main,header,footer,aside,form,section,article',
        );

      const regionName = (region: Element | null): string | null => {
        if (region === null) return null;
        const role = region.getAttribute("role");
        const tag = region.tagName.toLowerCase();
        const kind =
          role === "dialog" || tag === "dialog" || region.getAttribute("aria-modal") === "true"
            ? "dialog"
            : tag === "nav"
              ? "navigation"
              : tag;
        const labelledBy = region.getAttribute("aria-labelledby");
        let label: string | null = null;
        if (labelledBy !== null && labelledBy.length > 0) {
          try {
            label = clean(document.getElementById(labelledBy)?.textContent);
          } catch {
            label = null;
          }
        }
        label =
          label ??
          clean(region.getAttribute("aria-label")) ??
          clean(region.querySelector("h1,h2,h3,[role='heading']")?.textContent) ??
          clean(region.textContent)?.slice(0, 60) ??
          kind;
        return `${kind}:${slug(label, kind)}`;
      };

      const elementKind = (el: Element): string => {
        const role = el.getAttribute("role");
        const tag = el.tagName.toLowerCase();
        if (role !== null && role.length > 0) return role;
        if (tag === "a") return "link";
        return tag;
      };

      const topmostStatus = (el: Element): { topmost: boolean; occludedBy: string | null } => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { topmost: false, occludedBy: null };
        const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
        const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
        const top = document.elementFromPoint(x, y);
        if (top === null) return { topmost: false, occludedBy: null };
        if (top === el || el.contains(top)) return { topmost: true, occludedBy: null };
        return { topmost: false, occludedBy: regionName(regionFor(top)) ?? elementKind(top) };
      };

      // N1 onboarding-wizard cards (2026-06-08). Chakra/React card pickers
      // (imagekit's step-1/3 objective cards, axiom/pusher role cards) render
      // each selectable card as a BARE clickable div — cursor:pointer, but no
      // button/a/role/input semantics — so the SELECTOR walk above misses
      // them entirely and the planner has no target → it hallucinates
      // selectors and the stalled-wizard breaker fires. Collect them so the
      // existing assignCardRadioGroups can cluster them. Tightly scoped to
      // avoid flooding the inventory on ordinary pages:
      //   - cursor:pointer + visible
      //   - card-sized (not a tiny inline link, not a full-page wrapper)
      //   - has its OWN short label text
      //   - does NOT contain an already-collected interactive element (a
      //     wrapper around a real button isn't a card — we already have it)
      //   - OUTERMOST clickable in a nest (keep the card, drop its inner <p>)
      //   - capped
      {
        const alreadyMatched = new Set<Element>(collected);
        const MAX_CARDS = 16;
        const raw: Element[] = [];
        const scan = document.querySelectorAll("div,li,article,section,label");
        for (const el of Array.from(scan)) {
          if (raw.length >= MAX_CARDS) break;
          if (alreadyMatched.has(el)) continue;
          if (!isVisible(el)) continue;
          if (window.getComputedStyle(el).cursor !== "pointer") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 24 || r.width > 900 || r.height > 600) continue;
          const txt = clean(el.textContent);
          if (txt === null || txt.length < 2 || txt.length > 120) continue;
          try {
            if (el.querySelector(SELECTOR) !== null) continue;
          } catch {
            continue;
          }
          raw.push(el);
        }
        // Keep only the outermost clickable per nest (Chakra cards wrap an
        // inner <p>; cursor:pointer inherits, so both match — we want the card).
        const rawSet = new Set(raw);
        for (const el of raw) {
          let p = el.parentElement;
          let nested = false;
          while (p !== null) {
            if (rawSet.has(p)) { nested = true; break; }
            p = p.parentElement;
          }
          if (!nested) collected.push(el);
        }
      }

      const seen = new Set<Element>();
      // T38 — parent identity + bounding-box dimensions + clickable
      // bit, captured in lockstep with `out` so the Node-side
      // assignCardRadioGroups can detect card-radio clusters without
      // re-walking the DOM.
      const parentIds = new Map<Element, number>();
      let nextParentId = 0;
      const clusterMeta: Array<{
        parentId: number;
        width: number;
        height: number;
        clickable: boolean;
      }> = [];
      const out: Array<{
        tag: string;
        type: string | null;
        id: string | null;
        name: string | null;
        placeholder: string | null;
        ariaLabel: string | null;
        role: string | null;
        labelText: string | null;
        visibleText: string | null;
        selector: string;
        visible: boolean;
        inViewport: boolean;
        inConsentWidget: boolean;
        href: string | null;
        iconLabel: string | null;
        testId: string | null;
        title: string | null;
        landmark: string | null;
        value: string | null;
        checked: boolean | null;
        selectOptions: Array<{ value: string; text: string }> | null;
        selectedOptionText: string | null;
        interactedThisRun: boolean;
        screenPath: string | null;
        container: string | null;
        topmost: boolean | null;
        occludedBy: string | null;
      }> = [];
      for (const el of collected) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el) && !isCheckableHiddenByStyledLabel(el)) continue;
        const r = el.getBoundingClientRect();
        // T38 — capture parent identity + dimensions in lockstep with
        // the `out.push` below. Pure scalars only; no DOM nodes leak
        // through serialization.
        const parent = el.parentElement;
        let parentId: number;
        if (parent === null) {
          parentId = -1;
        } else if (parentIds.has(parent)) {
          parentId = parentIds.get(parent) as number;
        } else {
          parentId = nextParentId++;
          parentIds.set(parent, parentId);
        }
        const tagLower = el.tagName.toLowerCase();
        const roleAttr = el.getAttribute("role");
        const clickable =
          tagLower === "button" ||
          tagLower === "a" ||
          tagLower === "label" ||
          roleAttr === "button" ||
          roleAttr === "link" ||
          roleAttr === "radio" ||
          roleAttr === "menuitem" ||
          roleAttr === "menuitemradio" ||
          roleAttr === "option" ||
          window.getComputedStyle(el).cursor === "pointer";
        clusterMeta.push({
          parentId,
          width: r.width,
          height: r.height,
          clickable,
        });
        // 0.8.3-rc.1 — Google Identity Services iframe special-case.
        // The iframe is cross-origin so el.textContent is empty,
        // but we know structurally it's a "Continue with Google"
        // affordance. Surface synthetic text so findOAuthButton
        // matches it and the OAuth-first scan picks it up.
        const isGoogleGSIIframe =
          el instanceof HTMLIFrameElement &&
          (el.getAttribute("src") ?? "").includes("accounts.google.com/gsi/button");
        const container = regionName(regionFor(el));
        const status = topmostStatus(el);
        const pathLabel =
          isGoogleGSIIframe
            ? "Continue with Google"
            : isFormControlElement(el)
              ? labelFor(el) ?? directLabel(el) ?? iconLabelFor(el)
              : directLabel(el) ?? labelFor(el) ?? iconLabelFor(el);
        out.push({
          tag: isGoogleGSIIframe ? "button" : el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          id: el.getAttribute("id"),
          name: el.getAttribute("name"),
          placeholder: el.getAttribute("placeholder"),
          ariaLabel: isGoogleGSIIframe
            ? "Continue with Google"
            : el.getAttribute("aria-label"),
          role: isGoogleGSIIframe ? "button" : el.getAttribute("role"),
          labelText: labelFor(el),
          visibleText: isGoogleGSIIframe
            ? "Continue with Google"
            : clean(el.textContent),
          selector: selectorFor(el),
          visible: true,
          inViewport:
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= window.innerHeight &&
            r.right <= window.innerWidth,
          inConsentWidget: inConsent(el),
          href: (el.getAttribute("href") ?? "").slice(0, 300) || null,
          iconLabel: iconLabelFor(el),
          // The element's test-id, the GOLD-STANDARD stable anchor: authors set
          // data-testid/data-test/data-cy precisely so it survives refactors +
          // copy changes, which is exactly what text_match does not. Captured so
          // the synthesizer can prefer it over planner-gloss text. Common
          // variants folded to one field; first present wins.
          testId:
            el.getAttribute("data-testid") ??
            el.getAttribute("data-test-id") ??
            el.getAttribute("data-test") ??
            el.getAttribute("data-cy") ??
            el.getAttribute("data-qa") ??
            null,
          title: clean(el.getAttribute("title")),
          landmark: (() => {
            // F15 — nearest HTML5 landmark ancestor. Used by the
            // inventory renderer to disambiguate elements with the
            // same visibleText. Returns the lowercased tag name
            // ("header" / "main" / "footer" / "nav" / "aside" /
            // "article" / "section") or null when outside any.
            const lm = el.closest("header,main,footer,nav,aside,article,section");
            return lm !== null ? lm.tagName.toLowerCase() : null;
          })(),
          value:
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : el instanceof HTMLSelectElement
                ? el.value
                : null,
          // 0.8.3-rc.1 — checkbox/radio runtime state. `value` for a
          // checkbox is the static `value` attribute (defaults to
          // "on") regardless of whether it's currently ticked, so any
          // caller wanting to find UNCHECKED checkboxes needs `checked`
          // explicitly. The submit-disabled re-plan hint uses this to
          // surface concrete unticked candidates to the planner.
          checked:
            el instanceof HTMLInputElement &&
            (el.type === "checkbox" || el.type === "radio")
              ? el.checked
              : null,
          // For <select>: the currently-selected option's visible text
          // and a short list of available option labels. The combination
          // is how the planner detects the "React-defaulted dropdown"
          // pattern that broke Railway — `value=""` + a first option
          // whose text reads as a placeholder ("No workspace", "Select
          // …", "Choose …") means the user (or bot) has not yet
          // committed a choice and React form state still treats the
          // field as untouched. The planner needs that signal to issue
          // a `select` step before clicking submit. Limit to 8 options
          // — long pickers (countries, timezones) would otherwise blow
          // the inventory rendering.
          selectOptions:
            el instanceof HTMLSelectElement
              ? Array.from(el.options)
                  .slice(0, 8)
                  .map((o) => ({
                    value: o.value,
                    text: clean(o.textContent) ?? "",
                  }))
              : null,
          selectedOptionText:
            el instanceof HTMLSelectElement
              ? clean(el.options[el.selectedIndex]?.textContent ?? null)
              : null,
          interactedThisRun: el.getAttribute("data-ts-touched") === "1",
          screenPath:
            `${container ?? "body:root"} > ${elementKind(el)}:` +
            slug(pathLabel, `${elementKind(el)}-${out.length}`),
          container,
          topmost: status.topmost,
          occludedBy: status.occludedBy,
        });
      }
      return { out, clusterMeta };
    });
    // T38 — assign card-radio groups in Node (pure logic, unit-tested).
    const groups = assignCardRadioGroups(raw.clusterMeta);
    return raw.out.map((e, i) => ({
      ...e,
      index: i,
      cardRadioGroup: groups[i] ?? null,
    }));
  }

  // Resolve a selector against the live page for the verify step
  // (F3 T5). Returns the match count plus the first match's
  // tag/id/name so the caller can confirm a still-resolving selector
  // points at the element it was extracted from (not a recycled
  // node). An invalid selector (e.g. a stray `:contains()`) is caught
  // and reported as count 0 — never an uncaught throw.
  async inspectSelector(
    selector: string,
  ): Promise<{ count: number; tag: string | null; id: string | null; name: string | null }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const loc = this.page.locator(selector);
      const count = await loc.count();
      if (count === 0) return { count: 0, tag: null, id: null, name: null };
      const info = await loc.first().evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute("id"),
        name: el.getAttribute("name"),
      }));
      return { count, tag: info.tag, id: info.id, name: info.name };
    } catch {
      return { count: 0, tag: null, id: null, name: null };
    }
  }

  // ───────────── OAuth handshake (T6/T7) ─────────────

  // Click an OAuth provider button and adopt whichever page now
  // carries the handshake. Google OAuth either redirects the current
  // tab or opens a popup window; this normalizes both so the agent's
  // consent loop can treat `this.page` as "the page showing Google's
  // screens" without caring which transport the service chose.
  // settleAfterOAuth() restores the product page afterwards.
  async startOAuth(selector: string): Promise<void> {
    if (!this.page || !this.context) throw new Error("Browser not started");
    this.maybeAttachOAuthNetListener();
    if (!/accounts\.google\.com|github\.com\/login|login\.microsoftonline\.com/i.test(this.page.url())) {
      this.oauthProductPage = this.page;
    }
    // Race a popup `page` event against the click. context-level
    // "page" fires for both window.open popups and target=_blank.
    const popupPromise = this.context
      .waitForEvent("page", { timeout: 8000 })
      .catch(() => null);
    await this.click(selector);
    const popup = await popupPromise;
    if (popup !== null && popup !== this.page && !popup.isClosed()) {
      this.page = popup;
    }
    this.adoptLivePage();
    try {
      await this.page?.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      // best-effort — the agent's consent loop re-reads state regardless
    }
  }

  // ── OAuth/SSO debug instrumentation (UNIVERSAL_BOT_OAUTH_DEBUG) ──
  // Attach a context-level response recorder ONCE. Records SSO-relevant
  // responses (the service host + Clerk/Stytch/WorkOS FAPI hosts) with their
  // status + whether they set a cookie — the signal for "did the callback's
  // session-establish request succeed and set the session cookie?"
  private maybeAttachOAuthNetListener(): void {
    if (this.oauthNetListenerAttached) return;
    if (!/^(1|true|on)$/i.test(process.env.UNIVERSAL_BOT_OAUTH_DEBUG ?? "")) return;
    if (!this.context) return;
    this.oauthNetListenerAttached = true;
    const RELEVANT = /clerk|stytch|workos|accounts\.|\/sso|\/oauth|\/session|\/sign|callback|\/v1\/client/i;
    this.context.on("response", (res) => {
      void (async () => {
        try {
          const url = res.url();
          if (!RELEVANT.test(url)) return;
          const headers = res.headers();
          if (this.oauthNetLog.length >= 200) return;
          const entry: { url: string; status: number; setCookie: boolean; ct: string; body?: string } = {
            url: url.slice(0, 200),
            status: res.status(),
            setCookie: "set-cookie" in headers || "Set-Cookie" in headers,
            ct: (headers["content-type"] ?? "").slice(0, 40),
          };
          // Capture the body of a Clerk/Stytch/WorkOS sign-in/up/callback error
          // (>=400) — its error code is the definitive tell (captcha_invalid vs
          // transfer vs identifier_*). JSON only, bounded.
          if (res.status() >= 400 && /\/v1\/client\/(sign_ins|sign_ups)|oauth_callback|\/session/i.test(url)) {
            entry.body = (await res.text().catch(() => "")).slice(0, 800);
          }
          this.oauthNetLog.push(entry);
        } catch {
          // best-effort observability — never perturb the run
        }
      })();
    });
  }

  // Dump cookies + the SSO network log to a file for post-mortem. Called at the
  // oauth_session_not_persisted decision point when UNIVERSAL_BOT_OAUTH_DEBUG.
  async dumpOAuthDebug(service: string, label: string): Promise<void> {
    if (!/^(1|true|on)$/i.test(process.env.UNIVERSAL_BOT_OAUTH_DEBUG ?? "")) return;
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      const cookieSummary = cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        len: c.value.length,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
      const url = this.page ? this.page.url() : "(no page)";
      // Capture the live Clerk SDK state — the definitive read on whether a
      // sign-up transfer is available (the new-user-OAuth fix hinges on this).
      const clerkState = this.page
        ? await this.page
            .evaluate(() => {
              const w = window as unknown as { Clerk?: Record<string, unknown> };
              const c = w.Clerk;
              if (c === undefined) return { present: false };
              const client = (c as { client?: Record<string, unknown> }).client;
              const si = client?.["signIn"] as Record<string, unknown> | undefined;
              const su = client?.["signUp"] as Record<string, unknown> | undefined;
              const ffv = si?.["firstFactorVerification"] as Record<string, unknown> | undefined;
              return {
                present: true,
                loaded: (c as { loaded?: unknown }).loaded ?? null,
                signInStatus: si?.["status"] ?? null,
                signInFFVStatus: ffv?.["status"] ?? null,
                signInFFVError: ffv?.["error"] ?? null,
                signUpStatus: su?.["status"] ?? null,
                signUpMissingFields: su?.["missingFields"] ?? null,
                hasSignUpCreate: typeof (su as { create?: unknown })?.create === "function",
              };
            })
            .catch((e: unknown) => ({ present: "evalError", err: String(e).slice(0, 120) }))
        : { present: false };
      const consoleText = await this.extractText().catch(() => "");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const dir = join(homedir(), ".trusty-squire", "oauth-debug");
      mkdirSync(dir, { recursive: true });
      const ts = process.env.OAUTH_DEBUG_TS ?? String(this.oauthNetLog.length);
      const path = join(dir, `${service}-${label}-${ts}.json`);
      writeFileSync(
        path,
        JSON.stringify(
          { service, label, finalUrl: url, clerkState, cookies: cookieSummary, netLog: this.oauthNetLog, pageText: consoleText.slice(0, 600) },
          null,
          2,
        ),
      );
      console.error(`[oauth-debug] wrote ${path} (${cookieSummary.length} cookies, ${this.oauthNetLog.length} net entries)`);
    } catch (err) {
      console.error(`[oauth-debug] dump failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Read the page's Rails/OmniAuth CSRF token (<meta name="csrf-token">).
  // Needed to recover OmniAuth 2.0 POST-only OAuth when the provider button is
  // a GET <a> that page-JS upgrades to a POST.
  async getMetaCsrfToken(): Promise<string | null> {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(() => {
        const c = document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content");
        return c !== null && c !== undefined && c.length > 0 ? c : null;
      });
    } catch {
      return null;
    }
  }

  // Read an attribute off the first element matching `selector` (e.g. the href
  // of an OAuth affordance). null when absent or the selector doesn't resolve.
  async getElementAttribute(selector: string, attr: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      return await this.page.locator(selector).first().getAttribute(attr);
    } catch {
      return null;
    }
  }

  // Submit a programmatic POST form to `action` with the given hidden fields,
  // from the CURRENT page — so the current-origin session cookies ride along.
  // Recovers OmniAuth 2.0 POST-only OAuth (the GET-click hit "Authentication
  // passthru"): POST /…/auth/<provider> + authenticity_token → 302 to provider.
  async submitPostForm(
    action: string,
    fields: Record<string, string>,
  ): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.evaluate(
      ({ action, fields }) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = action;
        form.style.display = "none";
        for (const [k, v] of Object.entries(fields)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = k;
          input.value = v;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
      },
      { action, fields },
    );
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      // best-effort — the consent loop re-reads state regardless
    }
  }

  // Does the page sign in with Google via Google Identity Services (GSI)
  // rather than classic OAuth redirect? GSI renders its button in a
  // cross-origin iframe (accounts.google.com/gsi/button) and/or exposes the
  // `google.accounts.id` JS API; on use it raises a browser-native FedCM
  // dialog or a popup and returns a JWT to a JS callback — there is NO
  // redirect, so the classic startOAuth flow can't drive it. Detecting this
  // is what lets the agent route to tryGoogleGsiLogin instead.
  async hasGoogleGsiAffordance(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        if (
          document.querySelector('iframe[src*="accounts.google.com/gsi/"]') !== null
        ) {
          return true;
        }
        // On-demand One-Tap: the page loads the GSI client script but renders
        // no static button and may not have initialized `google.accounts.id`
        // yet (amplitude, clerk). A plain click on the in-page "Sign in with
        // Google" affordance never redirects, so the bot used to falsely
        // conclude "signed in" and bounce to login. Treat the loaded client
        // script as a GSI affordance so the agent routes through
        // tryGoogleGsiLogin, which now raises One-Tap programmatically.
        if (
          document.querySelector(
            'script[src*="accounts.google.com/gsi/client"]',
          ) !== null
        ) {
          return true;
        }
        const g = (window as unknown as {
          google?: { accounts?: { id?: unknown } };
        }).google;
        return typeof g?.accounts?.id !== "undefined";
      });
    } catch {
      return false;
    }
  }

  // Drive a Google Identity Services / FedCM sign-in. Two variants are
  // handled:
  //   - FedCM: clicking the GSI widget raises a browser-NATIVE credential
  //     dialog (no DOM, no popup — invisible to Playwright). We enable the
  //     CDP FedCm domain up front and auto-select the first account when
  //     FedCm.dialogShown fires. The page's JS callback then receives the
  //     JWT and establishes the session.
  //   - Popup: older GSI opens a Google account-chooser window; we adopt it
  //     like startOAuth does so the consent loop can drive it.
  // Returns how it resolved. The caller then runs the SAME post-OAuth
  // settle/consent/post-verify path as the redirect flow.
  async tryGoogleGsiLogin(
    triggerSelector: string,
    timeoutMs = 25_000,
  ): Promise<{ ok: boolean; via: "fedcm" | "popup" | "none" }> {
    if (!this.page || !this.context) throw new Error("Browser not started");
    this.oauthProductPage = this.page;
    let fedcmResolved = false;
    let cdp: CDPSession | null = null;
    try {
      cdp = await this.context.newCDPSession(this.page);
      await cdp.send("FedCm.enable", { disableRejectionDelay: true });
      console.error("[operator] FedCm.enable ok — listening for dialogShown");
      cdp.on("FedCm.dialogShown", (ev: unknown) => {
        const e = ev as { dialogId?: string; dialogType?: string; accounts?: unknown[] };
        console.error(
          `[operator] FedCm.dialogShown type=${e.dialogType ?? "?"} accounts=${
            Array.isArray(e.accounts) ? e.accounts.length : "?"
          }`,
        );
        const dialogId = e.dialogId;
        if (dialogId === undefined) return;
        void (async () => {
          // A ConfirmIdpLogin dialog has no account list — it's the "Continue
          // as / sign in to Google" confirmation that precedes the account
          // chooser. selectAccount would error on it, so drive the confirm
          // button directly and skip selectAccount for this dialog type.
          if (e.dialogType === "ConfirmIdpLogin") {
            try {
              await cdp!.send("FedCm.clickDialogButton", {
                dialogId,
                dialogButton: "ConfirmIdpLoginContinue",
              });
            } catch {
              // method/param may not apply to this build/dialog — non-fatal;
              // a subsequent AccountChooser dialog still resolves via select.
            }
            return;
          }
          try {
            // Pick the first account on the account-chooser dialog.
            await cdp!.send("FedCm.selectAccount", { dialogId, accountIndex: 0 });
            fedcmResolved = true;
          } catch {
            // dialog dismissed or already resolved
          }
          if (!fedcmResolved) {
            // Some flows surface a "Continue as <name>" confirm even on the
            // account dialog; selectAccount alone usually completes it, but
            // when it didn't, try the confirm button as a fallback. Failure
            // is non-fatal — the popup/none path still applies.
            try {
              await cdp!.send("FedCm.clickDialogButton", {
                dialogId,
                dialogButton: "ConfirmIdpLoginContinue",
              });
              fedcmResolved = true;
            } catch {
              // button absent or not applicable — degrade to popup/none
            }
          }
        })();
      });
    } catch (err) {
      cdp = null; // FedCm domain unavailable — the popup path still works
      console.error(
        `[operator] FedCm.enable failed (${
          err instanceof Error ? err.message : String(err)
        }) — FedCM path disabled, relying on popup`,
      );
    }

    const popupPromise: Promise<Page | null> = this.context
      .waitForEvent("page", { timeout: timeoutMs })
      .then((p): Page | null => p)
      .catch((): Page | null => null);

    await this.click(triggerSelector);

    // On-demand One-Tap: when the page loaded the GSI client but rendered no
    // static button, the click above hits an in-page affordance that never
    // raises a dialog on its own. If neither a FedCM dialog nor a popup has
    // appeared shortly after the click, ask GSI to raise One-Tap itself.
    // `google.accounts.id.prompt()` triggers the FedCM dialog our handler is
    // already listening for. Guarded — `window.google.accounts.id` may be
    // undefined (no-op) and any failure must degrade to the popup/none path.
    if (cdp !== null) {
      const promptDeadline = Date.now() + Math.min(4_000, timeoutMs);
      while (
        Date.now() < promptDeadline &&
        !fedcmResolved &&
        this.context.pages().length <= 1
      ) {
        await this.sleep(250);
      }
      if (!fedcmResolved && this.context.pages().length <= 1) {
        try {
          await this.page.evaluate(() => {
            const g = (window as unknown as {
              google?: { accounts?: { id?: { prompt?: () => void } } };
            }).google;
            const id = g?.accounts?.id;
            if (id !== undefined && typeof id.prompt === "function") {
              id.prompt();
            }
          });
        } catch {
          // GSI not initialized / prompt unavailable — popup/none still apply
        }
      }
    }

    // Resolve when a popup opens OR FedCM completes OR we hit the deadline.
    const fedcmWait = (async (): Promise<null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !fedcmResolved) {
        await this.sleep(250);
      }
      return null;
    })();
    const popup: Page | null = await Promise.race([popupPromise, fedcmWait]);

    if (cdp !== null) {
      try {
        await cdp.send("FedCm.disable");
      } catch {
        // best-effort
      }
    }

    if (popup !== null && popup !== this.page && !popup.isClosed()) {
      this.page = popup;
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      } catch {
        // consent loop re-reads regardless
      }
      return { ok: true, via: "popup" };
    }
    if (fedcmResolved) {
      // Credential delivered to the page's JS callback — give the app a beat
      // to exchange it for a session and redirect.
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      } catch {
        // best-effort
      }
      return { ok: true, via: "fedcm" };
    }
    console.error(
      `[operator] GSI resolved via none — fedcmEnabled=${cdp !== null} ` +
        `fedcmResolved=${fedcmResolved} pages=${this.context.pages().length}`,
    );
    return { ok: false, via: "none" };
  }

  // URL of the active page (the OAuth page mid-handshake, the product
  // page otherwise). Cheap — no screenshot, unlike getState().
  currentUrl(): string {
    return this.page !== null ? this.page.url() : "";
  }

  recoverActivePage(): boolean {
    return this.adoptLivePage();
  }

  private adoptLivePage(): boolean {
    if (this.page !== null && !this.page.isClosed()) return true;
    if (this.context === null) return false;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (pages.length === 0) return false;
    const product =
      this.oauthProductPage !== null && !this.oauthProductPage.isClosed()
        ? this.oauthProductPage
        : null;
    const nonAuth = [...pages]
      .reverse()
      .find((p) => !/accounts\.google\.com|github\.com\/login|login\.microsoftonline\.com/i.test(p.url()));
    this.page = nonAuth ?? product ?? pages[pages.length - 1] ?? null;
    return this.page !== null;
  }

  // Press a keyboard key (e.g. "Escape" to dismiss a focus-trapped modal that
  // exposes no in-DOM close control). Best-effort. Used by the nav-search
  // overlay handler's dismiss fallback.
  async pressKey(key: string): Promise<void> {
    if (!this.page) return;
    await this.page.keyboard.press(key).catch(() => {});
  }

  // Open obvious collapsed menus (hamburger / avatar / account / "Settings"
  // toggles) so nav links hidden behind them mount in the DOM before the
  // nav-search enumerates candidates (outside-voice #1: the keys link is often
  // behind a menu, not in the rendered top nav). CONSERVATIVE: only clicks
  // elements that ADVERTISE a popup menu (aria-haspopup=menu/true), capped at 3,
  // short timeouts, best-effort — never a plain link, so it can't wander.
  async expandLatentNav(): Promise<void> {
    if (!this.page) return;
    try {
      const n = await this.page
        .$$eval('[aria-haspopup="menu"], [aria-haspopup="true"]', (els) => {
          const slice = els.slice(0, 3);
          slice.forEach((e, i) => e.setAttribute("data-navsearch-toggle", String(i)));
          return slice.length;
        })
        .catch(() => 0);
      for (let i = 0; i < n; i++) {
        await this.page.click(`[data-navsearch-toggle="${i}"]`, { timeout: 1200 }).catch(() => {});
      }
    } catch {
      // best-effort — never fail the search over menu expansion
    }
  }

  // Fetch a URL's final response (following redirects) and return its
  // status, final URL, and body text — or null on any failure.
  //
  // WHY the CONTEXT request API (this.context.request) and not global
  // fetch / a fresh node http client: the context's APIRequestContext
  // shares the BrowserContext's proxy + cookie jar, so this egresses
  // through the SAME residential tunnel the real navigation uses. That
  // makes a probe here representative of what the browser would actually
  // land on (same IP reputation, same cf_clearance cookie) — and needs no
  // separate SOCKS/HTTP-proxy plumbing. Used by the signup-URL resolver to
  // distinguish a stale /signup that serves a login SPA from the real
  // signup form, BEFORE committing to a ~6-minute navigation.
  //
  // Bounded (15s, ≤10 redirects) and non-throwing — the resolver treats
  // null as "couldn't tell" and escalates.
  async fetchText(
    url: string,
  ): Promise<{ finalUrl: string; status: number; bodyText: string } | null> {
    if (this.context === null) return null;
    try {
      const response = await this.context.request.get(url, {
        maxRedirects: 10,
        timeout: 15_000,
        // We inspect 404/redirect bodies ourselves; don't let a non-2xx
        // throw before we can classify it.
        failOnStatusCode: false,
      });
      return {
        finalUrl: response.url(),
        status: response.status(),
        bodyText: await response.text(),
      };
    } catch {
      return null;
    }
  }

  // True when the active OAuth page is gone — for the popup flow, the
  // popup closing IS the signal the handshake finished.
  oauthPageClosed(): boolean {
    return this.page === null || this.page.isClosed();
  }

  // Drive a Google sign-in on the ACTIVE OAuth page (already sitting at
  // accounts.google.com/.../identifier). The whole point: replay must not bail
  // `needs_login` where the full discover bot would just type the password —
  // a freshly-created robot account lands on the identifier page the first time
  // a given relying party requests OAuth even with a live session, and the
  // robot's credentials are available to the verifier. Drives the standard
  // Google in-page steps (email → Enter → password →
  // Enter → ToS/continue speedbumps) but operates on `this.page` instead of
  // navigating to myaccount — in the OAuth flow the success terminus is the
  // consent screen or the return to the relying party, NOT myaccount. Returns
  // true when the flow progressed off the Google identifier/password screens
  // (or the popup closed); false on any failure, so the caller can fall back to
  // its existing needs_login path. Never logs the password.
  async loginGoogleInline(email: string, password: string): Promise<boolean> {
    const page = this.page;
    if (page === null || page.isClosed()) return false;
    const onIdentifierOrPwd = (): boolean =>
      /\/signin\/(?:identifier|v\d+\/(?:identifier|challenge|signin)|challenge|pwd|password)/i.test(
        page.url(),
      );
    try {
      // Cookie-consent wall (EU surfaces) — best-effort.
      await page
        .evaluate(() => {
          const want = /^(accept all|i agree|agree|accept|reject all)$/i;
          for (const b of Array.from(document.querySelectorAll("button,[role=button]"))) {
            if (want.test((b.textContent ?? "").trim())) {
              (b as HTMLElement).click();
              return;
            }
          }
        })
        .catch(() => undefined);
      await page.waitForTimeout(1200);
      // Email — #identifierId, never input[type=email] alone (Google uses a
      // custom input). Only fill if the identifier field is actually present;
      // a flow already past identifier (parked on the password screen) skips it.
      const EMAIL = '#identifierId, input[name="identifier"], input[type="email"]';
      const emailField = await page.$(EMAIL);
      if (emailField !== null) {
        await page.fill(EMAIL, email).catch(() => undefined);
        await page.waitForTimeout(400);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(6000);
      }
      // Password.
      const PW = 'input[type="password"][name="Passwd"], input[type="password"]';
      await page.waitForSelector(PW, { state: "visible", timeout: 15_000 });
      await page.fill(PW, password).catch(() => undefined);
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(7000);
      // New-account ToS speedbump + OAuth follow-ons — patient (renders late).
      for (let i = 0; i < 8; i++) {
        if (page.isClosed()) return true; // popup closed → handshake done
        const clicked = await page
          .evaluate(() => {
            const want =
              /^(not now|skip|confirm|i understand|i agree|accept|agree|got it|continue|allow|done|maybe later|next)$/i;
            for (const b of Array.from(
              document.querySelectorAll("button,[role=button],a,input[type=submit]"),
            )) {
              const t = (b.textContent ?? (b as HTMLInputElement).value ?? "").trim();
              if (want.test(t)) {
                (b as HTMLElement).click();
                return t;
              }
            }
            return null;
          })
          .catch(() => null);
        if (clicked !== null) {
          await page.waitForTimeout(3500);
        } else {
          if (!onIdentifierOrPwd()) break; // left the sign-in screens → progressed
          await page.waitForTimeout(2500);
        }
      }
      // Success = we are no longer parked on a Google identifier/password
      // screen (moved to consent / back to the relying party / popup closed).
      return page.isClosed() || !onIdentifierOrPwd();
    } catch {
      return false;
    }
  }

  // Which OAuth providers have a LIVE session in this profile's cookie jar.
  // The logged-in-providers.json marker is a memo that drifts out of sync
  // (a --force-relogin clears it, a misclassified run clears it, a parallel
  // run overwrites it) — so a session that is genuinely live in the cookies
  // can go invisible to provider selection, which is exactly how a warm
  // GitHub session got skipped in favour of a broken Google path. The cookie
  // jar is the ground truth: read it directly. Cookie NAMES + presence only;
  // values are never read into logs. Best-effort — a read failure returns [].
  async detectSessionProviders(): Promise<OAuthProviderId[]> {
    if (this.context === null) return [];
    try {
      return sessionProvidersFromCookies(await this.context.cookies());
    } catch {
      return [];
    }
  }

  // Advance a provider's consent / account-chooser screen by one click
  // — the scope-gated auto-approve (T7/T13). Returns false when no
  // approve control is present — the agent then aborts rather than
  // hang. Clicks only; never types (the critical guarantee holds here).
  async advanceOAuthConsent(provider: OAuthProviderId): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    if (provider === "github") {
      // GitHub App install flow can include an account target chooser before
      // the Install/Authorize screen:
      //   /apps/<app>/installations/select_target
      // It renders account/org cards as links/buttons, not as an approve
      // button. Advance exactly one visible target and let the caller's
      // consent loop re-classify the next GitHub page.
      if (/\/apps\/[^/]+\/installations\/select_target\b/.test(new URL(this.page.url()).pathname)) {
        const startUrl = this.page.url();
        const clicked = await this.page
          .evaluate(() => {
            const visible = (el: HTMLElement): boolean => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return (
                r.width > 2 &&
                r.height > 2 &&
                s.display !== "none" &&
                s.visibility !== "hidden" &&
                parseFloat(s.opacity || "1") > 0.01
              );
            };
            const bad = /\b(settings|marketplace|learn more|cancel|skip|back|terms|privacy)\b/i;
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>('a[href], button, [role="button"], [role="link"]'),
            ).filter((el) => visible(el));
            const byHref = candidates.find((el) => {
              const href = el instanceof HTMLAnchorElement ? el.href : el.getAttribute("href") ?? "";
              return /\/installations\/(?:new|permissions)\b/.test(href);
            });
            const target =
              byHref ??
              candidates.find((el) => {
                const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
                if (text.length === 0 || text.length > 80 || bad.test(text)) return false;
                return true;
              });
            if (target === undefined) return false;
            target.click();
            return true;
          })
          .catch(() => false);
        if (clicked) {
          const advanced = await this.page
            .waitForFunction((s) => window.location.href !== s, startUrl, { timeout: 8000 })
            .then(() => true)
            .catch(() => false);
          if (advanced) return true;
        }
      }
      // GitHub consent screen variants:
      //   Classic OAuth: "Authorize <app>"
      //   GitHub App (install + auth): "Authorize <app>", "Install",
      //                                "Install & authorize"
      //   Some flows show "Continue" or "Approve"
      // Negative match excludes Cancel/Deny.
      const startUrl = this.page.url();
      const patterns: RegExp[] = [
        /^authorize(\b|\s)/i,
        /^install\s*(&|and)\s*authorize\b/i,
        /^install\b/i,
        /^approve\b/i,
        /^continue\b/i,
        /^grant\b/i,
      ];
      for (const re of patterns) {
        const btn = this.page.getByRole("button", { name: re }).first();
        const count = await btn.count().catch(() => 0);
        if (count === 0) continue;
        // GitHub disables the Authorize button with a clickjacking-protection
        // COUNTDOWN (~3-8s) the first time you authorize an OAuth app that
        // requests org scopes (read:org). Clicking while disabled silently
        // no-ops and the URL never changes, so the whole consent bails
        // "no approve control" even though the button is right there
        // (MEASURED 2026-06-11: defang's "Authorize DefangLabs"). Poll up to
        // 12s for it to enable before clicking.
        {
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            const disabled = await btn
              .evaluate((el) => {
                if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
                  if (el.disabled) return true;
                }
                const aria = el.getAttribute("aria-disabled");
                return aria === "true" || aria === "";
              })
              .catch(() => false);
            if (!disabled) break;
            await this.sleep(400);
          }
        }
        try {
          await btn.click({ timeout: 8000 });
        } catch {
          continue;
        }
        // Verify the click actually advanced — GitHub's consent click
        // navigates within ~2s. If the URL is unchanged after 4s the
        // click silently failed (wrong element, or button disabled
        // behind a hidden iframe). Return false so the caller knows.
        const advanced = await this.page
          .waitForFunction(
            (s) => window.location.href !== s,
            startUrl,
            { timeout: 4000 },
          )
          .then(() => true)
          .catch(() => false);
        if (advanced) return true;
        // Click logged but URL didn't change — fall through to try the
        // next pattern (rare but covers misnamed candidates).
      }
      // Diagnostic: nothing matched OR every match failed to advance.
      // Log the visible button names so the failure trail tells us
      // what GitHub actually rendered.
      const seen = await this.page
        .evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('button, input[type="submit"], [role="button"]'),
          ) as HTMLElement[];
          return buttons
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.width > 1 && r.height > 1;
            })
            .slice(0, 8)
            .map((b) => {
              const t = (b.textContent || (b as HTMLInputElement).value || "").trim();
              return t.slice(0, 50);
            })
            .filter((t) => t.length > 0);
        })
        .catch(() => [] as string[]);
      console.error(
        `[operator] GitHub advanceOAuthConsent failed — visible buttons: ` +
          `${seen.length === 0 ? "<none>" : seen.map((s) => JSON.stringify(s)).join(", ")}`,
      );
      return false;
    }
    // Google. Account chooser: Google renders each account with a
    // stable data-identifier attribute (the account email).
    const tile = this.page.locator("[data-identifier]").first();
    if ((await tile.count().catch(() => 0)) > 0) {
      try {
        await tile.click({ timeout: 8000 });
        return true;
      } catch {
        // fall through to the approve-button path
      }
    }
    // Consent screen: the approve control's name varies by Google's
    // consent layout — "Continue", "Allow", "Allow access" (the
    // /signin/oauth/consent?part=… variant meilisearch hits). Match on a
    // startsWith verb set (not exact) so "Allow access" resolves, while
    // the verbs exclude Cancel/Deny/Back/No. Wait for the button to
    // render — the consent SPA paints the approve control a beat after
    // domcontentloaded, and the old exact-match + no-wait returned false
    // before it appeared.
    const APPROVE_NAME = /^(?:continue|allow|accept|agree)\b/i;
    const approve = this.page.getByRole("button", { name: APPROVE_NAME }).first();
    try {
      await approve.waitFor({ state: "visible", timeout: 8000 });
    } catch {
      // not visible within the window — fall through to the DOM-scan path
    }
    if ((await approve.count().catch(() => 0)) > 0) {
      try {
        await approve.click({ timeout: 8000 });
        return true;
      } catch {
        // fall through to the DOM-scan fallback
      }
    }
    // Fallback: scan the DOM for an approve-like clickable when the ARIA
    // role query missed it (Google occasionally renders the control as a
    // <div role>/<span> or an <input type=submit value="Allow access">).
    // Click the first visible candidate whose text is an approve verb and
    // is NOT a cancel/deny/back. Log what was visible on failure.
    const clicked = await this.page
      .evaluate(() => {
        const APPROVE = /^(?:continue|allow|accept|agree)\b/i;
        const DENY = /\b(?:cancel|deny|back|no\b|not now|reject)\b/i;
        const els = Array.from(
          document.querySelectorAll(
            'button, input[type="submit"], [role="button"], a[href]',
          ),
        ) as HTMLElement[];
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const t = (el.textContent || (el as HTMLInputElement).value || "").trim();
          if (t.length === 0 || t.length > 40) continue;
          if (DENY.test(t)) continue;
          if (APPROVE.test(t)) {
            (el as HTMLElement).click();
            return t.slice(0, 40);
          }
        }
        return null;
      })
      .catch(() => null);
    if (clicked !== null) return true;
    const seen = await this.page
      .evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('button, input[type="submit"], [role="button"]'),
        ) as HTMLElement[];
        return els
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 1 && r.height > 1;
          })
          .slice(0, 8)
          .map((b) => (b.textContent || (b as HTMLInputElement).value || "").trim().slice(0, 40))
          .filter((t) => t.length > 0);
      })
      .catch(() => [] as string[]);
    console.error(
      `[operator] Google advanceOAuthConsent failed — visible buttons: ` +
        `${seen.length === 0 ? "<none>" : seen.map((s) => JSON.stringify(s)).join(", ")}`,
    );
    return false;
  }

  // Wait on a Clerk callback for a session to establish, polling COOKIES (which
  // are world-agnostic — unlike window.Clerk, invisible to our isolated-world
  // page.evaluate under patchright). Clerk's main-world JS, if left alone on the
  // /sso-callback page (not navigated away), completes the new-user sign-up
  // transfer and sets a session; this detects that. Returns true once a Clerk
  // session indicator appears (`__session` cookie, or `__client_uat` flips off
  // "0"), false on timeout. Cheap + safe: only the bot's own context cookies.
  async waitForClerkSession(timeoutMs = 12000): Promise<boolean> {
    if (!this.context) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const cookies = await this.context.cookies();
        const signedIn = cookies.some(
          (c) =>
            (c.name === "__session" && c.value.length > 0) ||
            (c.name.startsWith("__client_uat") && c.value.length > 0 && c.value !== "0"),
        );
        if (signedIn) return true;
      } catch {
        // transient — keep polling
      }
      await this.sleep(1000);
    }
    return false;
  }

  // Restore the product page once the OAuth handshake completes. A
  // no-op for the same-tab redirect flow (the active page already IS
  // the product page); for the popup flow, waits briefly for the popup
  // to close, then switches `this.page` back to the product tab.
  async settleAfterOAuth(): Promise<void> {
    const product = this.oauthProductPage;
    this.oauthProductPage = null;
    if (product === null || product === this.page) return; // same-tab
    for (let i = 0; i < 12 && this.page !== null && !this.page.isClosed(); i++) {
      await this.sleep(1000);
    }
    if (this.page !== null && !this.page.isClosed()) {
      await this.page.close().catch(() => undefined);
    }
    this.page = product;
    await this.page.bringToFront().catch(() => undefined);
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      // best-effort
    }
  }

  async close(): Promise<void> {
    // Each step is best-effort and independent: a throw closing the page
    // or context must NOT skip the Xvfb teardown below, or the virtual
    // display leaks (orphaned Xvfb procs pile up over a long-lived MCP
    // server and, worse, the un-closed Chrome keeps the profile's
    // SingletonLock held — bricking the next signup + `mcp login`).
    //
    // EVERY close call is timeout-capped. On a wedged headed Chrome (e.g. a
    // run that crashed mid-captcha-click), BOTH page.close() AND
    // context.close() can hang INDEFINITELY — and an un-capped page.close()
    // blocked the reap below from ever running, so the browser leaked for
    // minutes and bricked the next 3 services (MEASURED 2026-06-09: supabase
    // crash → cockroachdb/weaviate/honeycomb all "profile held"). The cap
    // guarantees we always reach the SIGKILL reap.
    const capped = (p: Promise<unknown>, ms: number): Promise<void> =>
      Promise.race([
        Promise.resolve(p).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((r) => setTimeout(r, ms)),
      ]);
    if (this.page) await capped(this.page.close(), 5_000);
    if (this.context) await capped(this.context.close(), 10_000);
    // Self-launch path: disconnect the CDP browser and SIGKILL the Chrome we
    // spawned. context.close() on a connectOverCDP context only disconnects —
    // it does NOT necessarily exit the browser process, which would leak the
    // SingletonLock and brick the next run (the reap below is the backstop, but
    // killing our own child directly is cleaner and faster).
    if (this.cdpBrowser) {
      await capped(this.cdpBrowser.close(), 5_000);
      this.cdpBrowser = null;
    }
    if (this.childChrome) {
      try {
        this.childChrome.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (this.childChrome.pid !== undefined) selfManagedChromePids.delete(this.childChrome.pid);
      this.childChrome = null;
    }
    // …and context.close() doesn't always kill the browser: headed Chrome
    // under Xvfb / some patchright teardowns leave the main process alive
    // holding the SingletonLock. A leaked browser makes the NEXT run wait
    // 120s and fail with ProfileBusyError — one leak bricks every subsequent
    // service in a batch. We're done with the profile, so any holder still on
    // THIS host is our own leaked Chrome: reap it. Gated on launchedContext so
    // a pre-launch ProfileBusyError never kills the run we were waiting on.
    if (this.launchedContext) {
      try {
        reapLeakedProfileHolder(this.profileDir);
      } catch {
        /* best-effort */
      }
      this.launchedContext = false;
    }
    // F13 — release the on-demand Xvfb if we spawned one. Order
    // matters: kill Chrome (context.close) first so it has its
    // display until it exits, THEN kill Xvfb.
    if (this.xvfb !== null) {
      try { this.xvfb.stop(); } catch { /* best-effort */ }
      this.xvfb = null;
    }
  }
}

// Random integer in [min, max]. We use Math.random() (not crypto)
// because these values are used for timing only — predictability
// isn't a security concern. The shape of the distribution matters
// for behavior scoring, but uniform-in-range is close enough to the
// human distribution that scorers can't reliably distinguish.
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Score signup-form submit candidates by visible text; return the index
// of the best, or null when none scores positive. Signup pages commonly
// render OAuth buttons ("Continue with Google" / "GitHub") as
// button[type=submit] next to the real account-creation button, so a
// generic selector resolves to several — this picks the right one.
//
// Same shape and rationale as the verification-link picker: a positive
// score gate so an OAuth-only page (every candidate negative) returns
// null rather than mis-clicking "Continue with Google".
// Click disambiguation (regression: #61 weaviate). A bare id selector can
// resolve to >1 element — Descope's <descope-button> stamps the same
// generated id on the web component AND its inner text node — which trips
// Playwright strict mode before the click. When the selector isn't unique,
// narrow to the first match (Playwright's documented click disambiguation).
// Exported so the decision is unit-tested without a live page.
export function pickClickLocator<L extends { first(): L }>(locator: L, count: number): L {
  return count > 1 ? locator.first() : locator;
}

// Reference implementation of the shadow-piercing inventory walk that runs
// inside extractInteractiveElements' page.evaluate. Kept BYTE-FOR-BYTE in
// lockstep with that inline walk's guard + traversal. Exported only so the
// defensive guard (regression: #59 redis-cloud — a detached/closed root with
// no querySelectorAll crashed the whole inventory) is unit-testable in plain
// Node with fake roots. The production copy stays inline because a
// page.evaluate body can't call module code, and injecting source via
// new Function() would trip strict CSPs. If you change the inline walk's
// guard or traversal, change this too.
interface ShadowWalkRoot {
  querySelectorAll(selectors: string): ArrayLike<ShadowWalkEl>;
}
interface ShadowWalkEl {
  // `| undefined` mirrors the live DOM: `Element.shadowRoot` is typed
  // `ShadowRoot | null`, but a detached/closed custom element yields
  // `undefined` at runtime. The walk must survive that — see the guard.
  readonly shadowRoot: ShadowWalkRoot | null | undefined;
}
export function collectAcrossShadowRoots(
  root: ShadowWalkRoot | null | undefined,
  selector: string,
): ShadowWalkEl[] {
  const collected: ShadowWalkEl[] = [];
  const walk = (r: ShadowWalkRoot | null | undefined): void => {
    // `== null` (not `=== null`) covers both null and undefined — the
    // recursion below calls walk() on any non-null shadowRoot, so an
    // `undefined` one reaches here and `typeof undefined.querySelectorAll`
    // would throw before the typeof guard fired (#59 redis-cloud).
    if (r == null || typeof r.querySelectorAll !== "function") return;
    Array.from(r.querySelectorAll(selector)).forEach((n) => collected.push(n));
    Array.from(r.querySelectorAll("*")).forEach((el) => {
      if (el.shadowRoot !== null) walk(el.shadowRoot);
    });
  };
  walk(root);
  return collected;
}

//
// Exported for unit testing — the scoring is the load-bearing logic.
export function pickSubmitButtonIndex(texts: readonly string[]): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;
  texts.forEach((raw, i) => {
    // Shared scorer (F3 Issue 8) — one keyword set for submit
    // disambiguation, the chooser pick, and inventory ranking.
    const score = scoreSignupButton(raw);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}

// ───────────── required-agreement checkbox guard ─────────────

// Patterns shared by the pure helper below and the in-page evaluate in
// `checkRequiredAgreementBoxes`. The evaluate runs in the page realm and
// can't import, so the same two regexes are inlined there verbatim —
// keep them BYTE-IDENTICAL with these.
const AGREEMENT_TEXT_RE =
  /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr|age|18\+|18 years|certif/i;
const MARKETING_TEXT_RE =
  /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;
const SAFE_SIGNUP_CHOICE_TEXT_RE =
  /digital products?|saas|software|developer tools?|apis?|mobile apps?|data|analytics/i;
const RISKY_SIGNUP_CHOICE_TEXT_RE =
  /gambling|financial services?|physical products?|marketplace|human services?|adult|weapons?|medical|restricted|crypto|payments?|banking/i;

// True when a checkbox's associated text reads as a REQUIRED agreement
// (terms/privacy/consent) and NOT as a marketing/newsletter opt-in.
//
// Why a deterministic check instead of trusting the LLM planner:
// amplitude's signup renders the required TOS checkbox next to a pair of
// data-storage-location card-radios; the planner mistook the whole
// cluster for "ambiguous radios" and skipped the box, and amplitude's
// submit isn't disabled when it's unticked — so the form silently
// no-ops. We must never flip a marketing opt-in on the user's behalf,
// hence the explicit marketing exclusion.
export function isAgreementCheckboxText(text: string): boolean {
  return AGREEMENT_TEXT_RE.test(text) && !MARKETING_TEXT_RE.test(text);
}

// True when a required signup-category choice is a low-risk default the bot can
// select deterministically. Keep byte-identical with the in-page regexes in
// `checkRequiredSignupChoiceBoxes`.
export function isSafeSignupChoiceText(text: string): boolean {
  return (
    SAFE_SIGNUP_CHOICE_TEXT_RE.test(text) &&
    !RISKY_SIGNUP_CHOICE_TEXT_RE.test(text) &&
    !AGREEMENT_TEXT_RE.test(text) &&
    !MARKETING_TEXT_RE.test(text)
  );
}

// ───────────── residential proxy (S1) ─────────────

// Playwright proxy settings, narrowed to the fields we set. Structurally
// assignable to Playwright's launch `proxy` option (which also has an
// optional `bypass`).
export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

// Parse a UNIVERSAL_BOT_PROXY_URL — e.g. "http://user:pass@host:8080" or
// "socks5://host:1080" — into Playwright's proxy option shape. Playwright
// wants credentials separate from `server`, so we split them out and
// percent-decode them (residential providers embed session IDs with
// reserved characters in the username, which arrive %-encoded).
//
// Throws on a URL the WHATWG parser rejects, or one with no host (a bare
// "host:port" parses as a scheme with an empty host) — the caller logs
// and falls back to a direct connection.
//
// Exported for unit testing — URL parsing is the error-prone bit.
// Cheap TCP liveness probe for a proxy `server` string ("socks5://host:port").
// A SOCKS5 proxy listens on TCP; if a connect succeeds within the timeout the
// proxy is up. Resolves false on connect error / timeout / a malformed server.
// Pure (no class state) so resolveProxy can call it before launching Chrome.
export async function isProxyReachable(
  server: string,
  timeoutMs = 4000,
): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(server);
    host = u.hostname;
    port = Number(u.port) || (u.protocol.startsWith("socks") ? 1080 : 8080);
  } catch {
    return false;
  }
  if (host.length === 0 || !Number.isFinite(port)) return false;
  return await new Promise<boolean>((resolve) => {
    const sock = new Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // already closed
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

export function parseProxyUrl(raw: string): ProxySettings {
  const u = new URL(raw.trim());
  if (u.hostname.length === 0) {
    throw new Error(
      `proxy URL has no host: "${raw}" (expected e.g. http://host:port)`,
    );
  }
  // `host` includes the port; `protocol` keeps its trailing ":".
  const settings: ProxySettings = { server: `${u.protocol}//${u.host}` };
  if (u.username.length > 0) settings.username = decodeURIComponent(u.username);
  if (u.password.length > 0) settings.password = decodeURIComponent(u.password);
  return settings;
}

// Should this run route through the configured proxy? True when the
// egress network is datacenter-class (the case the proxy exists for) or
// when the operator forced it on. Residential/unknown without the
// override stay direct — the ~80% who don't need it pay nothing.
//
// Exported for unit testing.
export function shouldRouteThroughProxy(
  asnClass: AsnClass,
  forceAlways: boolean,
): boolean {
  return forceAlways || asnClass === "datacenter";
}

// ───────────── egress geo match (T3.1) ─────────────

// Browser-context geo derived from the run's actual egress IP. Set on
// newContext() so the browser's declared timezone matches where its
// traffic exits — a US-timezone browser on a foreign proxy IP is
// itself a signal anti-bot scorers check for.
export interface EgressGeo {
  timezoneId: string;
  geolocation?: { latitude: number; longitude: number };
}

// Parse an ipinfo.io/json response body into EgressGeo. Returns null
// when the timezone is absent or not a plausible IANA zone — the
// caller then keeps a default rather than handing Playwright a bad
// timezoneId (which would throw inside newContext()).
//
// geolocation is optional: a valid `loc` ("lat,long") sets it; a
// missing or malformed one leaves a timezone-only result. Exported
// for unit testing — JSON-shape handling is the error-prone bit.
export function parseEgressGeo(text: string): EgressGeo | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const tz = typeof d.timezone === "string" ? d.timezone : null;
  // IANA zones look like "Asia/Seoul" or "America/Argentina/Buenos_Aires".
  // Reject anything else so a garbage value never reaches newContext().
  if (tz === null || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz)) return null;

  const geo: EgressGeo = { timezoneId: tz };
  if (typeof d.loc === "string") {
    const parts = d.loc.split(",");
    if (parts.length === 2) {
      const latitude = Number(parts[0]);
      const longitude = Number(parts[1]);
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
      ) {
        geo.geolocation = { latitude, longitude };
      }
    }
  }
  return geo;
}

// ───────────── element inventory (F3) ─────────────

// One interactive element the planner can target. `selector` is
// computed by the bot from the live DOM, so it is known to resolve —
// the planner PICKS from these rather than inventing selector
// strings (the bug behind the 0/14 sweep). `index` is assigned after
// ranking, so it is a stable handle for the planner to reference.
export interface InteractiveElement {
  index: number;
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  role: string | null;
  labelText: string | null;
  visibleText: string | null;
  selector: string;
  visible: boolean;
  inViewport: boolean;
  inConsentWidget: boolean;
  // T13 follow-up — OAuth-affordance signals. `href` is the link
  // target (an OAuth <a> points at e.g. /identity/login/google/);
  // `iconLabel` folds in a descendant <img alt> / <svg><title> /
  // [aria-label] so an icon-only "Sign in with Google" button — no
  // visible text at all — is still discoverable. Optional: only the
  // live extractInteractiveElements sets them; test fixtures omit them.
  href?: string | null;
  iconLabel?: string | null;
  // rc.19 — the element's own `title` attribute. Tooltip-style labels
  // used by icon-only buttons like Railway's modal "Copy Code" copy
  // button, which has no visible text and no aria-label. Without this
  // signal, findCopyButton in the synthesizer falls back to
  // extract_via_regex on bare UUIDs (which the regex library cannot
  // match without a label). Optional; test fixtures may omit.
  title?: string | null;
  // The element's data-testid / data-test / data-cy / data-qa — the most stable
  // selector anchor a site offers (authored to survive refactors + copy
  // changes). pickStableDomHint prefers it; replay's matchesDomHint resolves it
  // ahead of text_match. Optional; test fixtures may omit.
  testId?: string | null;
  // F15 — nearest HTML5 landmark ancestor: header | main | footer |
  // nav | aside | article | section, or null when the element is
  // outside any landmark. The agent's inventory renderer uses this to
  // disambiguate elements with identical visibleText (a Railway run
  // had "Email" appear twice — body CTA and footer link — with
  // similar selectors that confused the planner). Optional: only the
  // live extractor sets it; fixtures may omit.
  landmark?: string | null;
  // Current value of a text-shaped input/textarea OR a <select>.
  // Surfaces "is this field actually empty / unselected?" to the
  // planner. For an input/textarea: empty string means the field
  // exists and is empty. For a <select>: empty string means the
  // first option's value is "" — typically the "Select…" placeholder
  // option, which is the React-form-state-untouched pattern that
  // broke Railway's token-creation form (clicking Create silently
  // bailed because React Hook Form treated workspaceId as untouched).
  // null means "not applicable (button/link) or not captured (test
  // fixture)".
  value?: string | null;
  // 0.8.3-rc.1 — runtime `checked` state for checkbox/radio inputs.
  // Null for everything else. Use this (not `value`) to identify
  // unticked checkboxes — checkbox `value` is the static attribute.
  checked?: boolean | null;
  // <select>-only: the visible text of the currently-selected option
  // and a short list of available option labels (capped to 8 — long
  // pickers like countries blow the inventory rendering). Lets the
  // planner emit a `{"kind":"select", option_text: …}` step targeting
  // an option by name. Both null for non-select elements.
  selectOptions?: Array<{ value: string; text: string }> | null;
  selectedOptionText?: string | null;
  // True when the bot has issued a selectOption / type / etc. against
  // this element earlier in this run, leaving a `data-ts-touched`
  // attribute. Inventory rendering uses this to suppress the
  // DEFAULTED-dropdown warning on selects we've already committed —
  // a Railway "No workspace" (value="") select otherwise re-trips
  // the warning every round and the planner gets stuck in a select
  // loop. Default false (or absent).
  interactedThisRun?: boolean;
  // Compact visual/structural context for non-vision host agents.
  // screenPath is a stable-ish human target path like
  // "dialog:finish-account > button:create-account"; container names the
  // closest dialog/nav/main/form/etc.; topmost/occludedBy report whether the
  // element is actually reachable at its center point.
  screenPath?: string | null;
  container?: string | null;
  topmost?: boolean | null;
  occludedBy?: string | null;
  // T38 — card-radio cluster membership. Set on elements that are
  // part of a "choose one of these N visually-similar siblings" group:
  // onboarding wizards like Cloudinary's "What are you using
  // Cloudinary for?" and Koyeb's use-case picker render their radio
  // choices as styled cards/labels with no semantic radio role. The
  // detector groups ≥2 sibling clickables that share parentElement
  // and have bounding boxes within ±20%. The planner reads this to
  // know exactly one card needs to be picked and "Continue" is the
  // expected next step. Null/absent when not part of a group.
  cardRadioGroup?: { id: number; position: number; total: number } | null;
}

// T38 — pure clustering logic. Identifies card-radio groups from a
// flat list of inventory candidates: each candidate carries its
// parent's identity (an integer assigned in DOM-walk order) plus
// the rendered bounding-box dimensions. Returns one slot per
// candidate, populated only for members of a qualifying group.
//
// A group qualifies when:
//   - 2..8 clickable siblings share the same parent (a list of N
//     things in a <ul> would usually exceed 8, and ≥9 sibling
//     similar-sized clickables aren't a card-radio in practice);
//   - their widths and heights agree within ±20% (real card grids
//     line up to a CSS grid template, so this is loose enough for
//     pixel rounding but tight enough to reject a button+text-link
//     row).
//
// Exported so the unit tests can exercise the logic in Node — the
// DOM-side caller in extractInteractiveElements feeds the same
// shape from inside page.evaluate.
export function assignCardRadioGroups(
  candidates: ReadonlyArray<{
    parentId: number;
    width: number;
    height: number;
    clickable: boolean;
  }>,
): Array<{ id: number; position: number; total: number } | null> {
  const result: Array<{ id: number; position: number; total: number } | null> =
    new Array(candidates.length).fill(null);
  // Bucket by parent.
  const byParent = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === undefined || c.parentId < 0) continue;
    const arr = byParent.get(c.parentId) ?? [];
    arr.push(i);
    byParent.set(c.parentId, arr);
  }
  let nextGroupId = 1;
  // Iterate in insertion order — keeps group ids stable across runs
  // for tests that exercise multiple clusters.
  for (const indices of byParent.values()) {
    if (indices.length < 2 || indices.length > 8) continue;
    const clickableIdx = indices.filter((i) => candidates[i]?.clickable === true);
    if (clickableIdx.length < 2) continue;
    const widths = clickableIdx.map((i) => candidates[i]!.width);
    const heights = clickableIdx.map((i) => candidates[i]!.height);
    const minW = Math.min(...widths);
    const minH = Math.min(...heights);
    if (minW < 1 || minH < 1) continue; // degenerate — reject
    const wRatio = Math.max(...widths) / minW;
    const hRatio = Math.max(...heights) / minH;
    if (wRatio > 1.2 || hRatio > 1.2) continue;
    const groupId = nextGroupId++;
    const total = clickableIdx.length;
    clickableIdx.forEach((idx, pos) => {
      result[idx] = { id: groupId, position: pos + 1, total };
    });
  }
  return result;
}

// Score a button/link by how much its text reads like a signup
// action. Shared by submit-button disambiguation, the two-stage
// chooser pick, and inventory button-ranking — one keyword set, no
// drift (F3 Issue 8). OAuth provider names go firmly negative so the
// bot never wanders into a Google/GitHub login dead end.
//
// `oauthProviders` (T6/T13 + auto-prefer) inverts that for OAuth-
// candidate providers: the "Sign in with <provider>" affordance is a
// PRIMARY target, not a dead end — so it must score positive enough to
// survive inventory ranking/capping. Stated as a rule, not arithmetic:
// a candidate provider's button outranks any form field. Only the
// candidate providers flip positive; every other OAuth/SSO button
// stays negative.
export function scoreSignupButton(
  text: string,
  oauthProviders?: readonly OAuthProviderId[],
): number {
  const t = text.toLowerCase();
  let score = 0;
  if (t.includes("create account") || t.includes("create your account")) score += 12;
  if (t.includes("sign up") || t.includes("signup")) score += 10;
  if (t.includes("register")) score += 8;
  if (t.includes("get started")) score += 6;
  // rc.30 — "email" is a strong signal that this button is the
  // signup path even when the page lacks a "Sign up" button (Railway,
  // Vercel, lots of services combine signup + login on one page and
  // label the email path "Log in using email" / "Sign in with email").
  // Bump weight from +5 to +12 so the combined-flow button outranks
  // generic nav anchors that score 0. The compensating auth-verb
  // penalty below is also suppressed when email is present.
  const hasEmail =
    t.includes("continue with email") ||
    t.includes("sign up with email") ||
    t.includes("email");
  if (hasEmail) {
    score += 12;
  }
  // Weak positive: "Continue" is often the real submit on single-field
  // forms; it should beat nothing but lose to OAuth markers.
  if (t.includes("continue")) score += 2;
  // "Next" / "Submit" / "Join" are the real form-submit verb on a multi-step
  // signup (huggingface /join step 1's button is "Next"). Weak positive so the
  // submit survives the button cap among many 0-scored nav anchors — otherwise
  // the planner can't see it and hallucinates a submit_selector. Loses to any
  // real signup CTA / OAuth marker. MEASURED 2026-06-23 (huggingface).
  if (/\bnext\b/.test(t) || /\bsubmit\b/.test(t) || /\bjoin\b/.test(t)) score += 2;
  // Post-signup dashboards reveal the key behind a "Create API Key" /
  // "Add key" / "Generate key" / "Get API Key" CTA — the run's actual
  // goal once the account exists. These score 0 on signup vocabulary, so
  // on a busy dashboard (dozens of nav/account buttons) rankAndCapInventory
  // caps them out: the OpenRouter "Get API Key" + fal.ai "Add key"
  // suppression. Score them as a primary target so they survive ranking.
  if (
    /\b(?:add|create|generate|new|get|reveal|copy)\b[\s\w]{0,20}\b(?:api[\s-]?key|key|token|secret|credential)s?\b/.test(t)
  ) {
    score += 14;
  }
  if (
    oauthProviders !== undefined &&
    oauthProviders.some((p) => new RegExp(`\\b${p}\\b`).test(t))
  ) {
    // OAuth-first: a candidate provider's button is the goal. Score it
    // above every form-field-class button so ranking never caps it out.
    score += 50;
  } else if (/\b(google|github|gitlab|microsoft|apple|facebook|okta|sso|saml)\b/.test(t)) {
    // OAuth / SSO buttons are submit-typed too — the provider name is
    // the reliable discriminator, so drive those firmly negative.
    score -= 20;
  }
  // rc.30 — auth-verb penalty applies only when the button is purely
  // sign-in (no email). "Log in using email" / "Sign in with email"
  // are combined paths where the same button serves signup AND login
  // for first-time visitors. Penalizing them drops the actual signup
  // route from the inventory (the Railway regression diagnosed via
  // screenshots after rc.29).
  const hasAuthVerb =
    t.includes("sign in") || t.includes("log in") || t.includes("login");
  if (hasAuthVerb && !hasEmail) score -= 12;
  return score;
}

// Rank + cap the raw inventory before it goes to the planner. Every
// input/textarea/select is kept — they are the load-bearing form
// fields and a page has few. Only buttons/links/role elements are
// ranked (by signup-relevance) and capped, since a marketing page
// carries dozens of nav/footer buttons (F3 Issue 3 + Tension 2: a
// flat cap could truncate the real email field). Re-indexes the kept
// set and reports how many buttons were dropped.
export function rankAndCapInventory(
  elements: readonly InteractiveElement[],
  buttonCap = 25,
  oauthProviders?: readonly OAuthProviderId[],
): { inventory: InteractiveElement[]; buttonsDropped: number } {
  const isButtonish = (e: InteractiveElement): boolean =>
    e.tag === "button" ||
    e.tag === "a" ||
    e.type === "submit" ||
    e.type === "button" ||
    e.type === "reset";
  const fields = elements.filter((e) => !isButtonish(e));
  const ranked = elements
    .filter(isButtonish)
    .map((e) => ({
      e,
      score: scoreSignupButton(
        `${e.visibleText ?? ""} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`,
        oauthProviders,
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const keptButtons = ranked.slice(0, buttonCap).map((x) => x.e);
  const inventory = [...fields, ...keptButtons].map((e, i) => ({
    ...e,
    index: i,
  }));
  return {
    inventory,
    buttonsDropped: Math.max(0, ranked.length - keptButtons.length),
  };
}
