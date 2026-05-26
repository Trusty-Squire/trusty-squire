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
// captchas still need the click-and-wait pattern documented in
// agent.ts.

import { chromium as baseChromium } from "playwright";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { createRequire } from "node:module";
import { detectAsn, type AsnClass } from "./asn.js";
import { CHROME_PROFILE_DIR } from "./profile.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import { startXvfb, xvfbAvailable, type XvfbRig } from "./xvfb.js";

// Lazy registration: installing the plugin mutates the chromium singleton
// from playwright-extra so we only do it once per process. We require()
// the CJS modules lazily (the stealth toolchain only ships CJS) and treat
// stealth as best-effort — a missing dep should never crash the bot.
const require = createRequire(import.meta.url);

let cachedChromium: typeof baseChromium | null = null;
function getChromium(): typeof baseChromium {
  if (cachedChromium !== null) return cachedChromium;
  try {
    const { chromium: extra } = require("playwright-extra") as {
      chromium: { use: (plugin: unknown) => unknown };
    };
    const stealth = require("puppeteer-extra-plugin-stealth") as () => unknown;
    extra.use(stealth());
    cachedChromium = extra as unknown as typeof baseChromium;
  } catch (err) {
    // Fall back to vanilla playwright if stealth isn't installed. The bot
    // still works, it's just easier to fingerprint as a bot.
    console.warn(
      `[universal-bot] stealth plugin unavailable, falling back to vanilla chromium: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cachedChromium = baseChromium;
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
}

export type CaptchaKind = "turnstile" | "recaptcha";

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

export class BrowserController {
  // The persistent browser context. Persistent (launchPersistentContext)
  // rather than an ephemeral context so the profile carries the user's
  // Google session across runs — see profile.ts / google-login.ts.
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly humanize: boolean;
  // Tracks the simulated mouse position so successive clicks can move
  // along a continuous path (humans don't teleport between clicks).
  private mouseX = 100;
  private mouseY = 100;
  // Records the browser channel that .start() actually launched. Set
  // post-launch so telemetry (provision-any.ts) can surface "this run
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

  // F13 — on-demand Xvfb. Set when start() determined the host has no
  // display surface but Xvfb is available, so Chrome can run with
  // `headless: false` against a virtual display (Cloudflare/Stytch et
  // al. detect Chromium-headless and block their signup forms). Torn
  // down by close().
  private xvfb: XvfbRig | null = null;

  // F13 — which launch path start() took. Surfaced via .launchMode so
  // the agent can push it into the run's step trail and we can see
  // (from outside the box) whether the bot ran headed.
  private launchedMode: "display" | "xvfb" | "headless" | "unknown" =
    "unknown";

  get launchMode(): "display" | "xvfb" | "headless" | "unknown" {
    return this.launchedMode;
  }

  constructor(opts: BrowserControllerOptions = {}) {
    this.humanize = opts.humanize ?? true;
    this.profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  }

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

  async start(): Promise<void> {
    const channel = await detectChromiumChannel();
    this.launchedChannel = channel;
    const proxy = await this.resolveProxy();
    this.proxyServer = proxy?.server ?? null;
    // Stderr so the MCP stdio transport's framing stays clean (the
    // module's existing logging convention).
    console.error(
      `[universal-bot] launching browser channel=${channel ?? "bundled-chromium"} ` +
        `proxy=${proxy?.server ?? "direct"}`,
    );
    // T3.1: probe where this run's traffic actually exits so the
    // browser's declared timezone matches its egress IP (a US-timezone
    // browser on a foreign proxy IP is itself an anti-bot signal).
    // Done before the real launch: launchPersistentContext bakes the
    // timezone in at creation, with no way to set it afterward.
    const geo = await this.probeEgressGeo(channel, proxy);
    if (geo !== null) {
      console.error(
        `[universal-bot] egress geo: timezone=${geo.timezoneId}` +
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
        this.xvfb = await startXvfb({ width: 1280, height: 720 });
        chromeEnv = { ...process.env, DISPLAY: this.xvfb.display };
        chromeHeadless = false;
        this.launchedMode = "xvfb";
        console.error(
          `[universal-bot] no DISPLAY — spawned Xvfb at ${this.xvfb.display} for headed Chrome`,
        );
      } catch (err) {
        console.error(
          `[universal-bot] Xvfb failed (${err instanceof Error ? err.message : String(err)}) — ` +
            `falling back to true headless; Cloudflare/Stytch-class signups may fail`,
        );
        chromeHeadless = true;
        this.launchedMode = "headless";
      }
    } else {
      console.error(
        `[universal-bot] no DISPLAY and Xvfb not installed — running true headless. ` +
          `For Cloudflare/Stytch-class signups install xvfb: apt-get install -y xvfb`,
      );
      chromeHeadless = true;
      this.launchedMode = "headless";
    }

    // T3: a PERSISTENT context. The profile dir carries the user's
    // Google session (established by `mcp login` — see google-login.ts),
    // so the OAuth-first signup path reuses it instead of starting
    // logged-out. launchPersistentContext takes launch + context
    // options in one call.
    const context = await getChromium().launchPersistentContext(this.profileDir, {
      headless: chromeHeadless,
      ...(chromeEnv !== undefined ? { env: chromeEnv } : {}),
      // `channel:` selects a real installed browser over the bundled
      // binary; omitted entirely when null.
      ...(channel !== null ? { channel } : {}),
      // `proxy:` routes egress through a residential proxy — only for
      // datacenter-class egress (see resolveProxy()).
      ...(proxy !== null ? { proxy } : {}),
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      // locale stays en-US deliberately: matching it to the proxy
      // country would render signup pages in that language, and the
      // Claude vision form-planner expects English.
      locale: "en-US",
      // timezone + geolocation track the real egress (T3.1); a fixed
      // default when the probe failed.
      timezoneId: geo?.timezoneId ?? "America/New_York",
      // F10: `clipboard-read` is what makes `navigator.clipboard.readText()`
      // return the user's just-clicked Copy-button value, which is how
      // every modern API-key modal (OpenRouter, Anthropic, OpenAI,
      // Stripe) reveals the full secret — the visible display is
      // masked / truncated and only the clipboard has the whole key.
      // `clipboard-write` is a freebie; some Copy buttons no-op without
      // it. Granting both at context-creation time so we don't have to
      // re-grant on every nav.
      permissions: [
        ...(geo?.geolocation !== undefined ? ["geolocation"] : []),
        "clipboard-read",
        "clipboard-write",
      ],
      ...(geo?.geolocation !== undefined ? { geolocation: geo.geolocation } : {}),
    });
    this.context = context;
    // Patch the navigator.webdriver flag — most anti-bot heuristics look here.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // rc.33 — spoof WebGL renderer/vendor. Under Xvfb (or any non-GPU
    // host) Chrome falls back to SwiftShader, which reports
    //   UNMASKED_VENDOR_WEBGL   = "Google Inc. (Google)"
    //   UNMASKED_RENDERER_WEBGL = "ANGLE (Google, ...SwiftShader...)"
    // Both strings are on every published anti-bot fingerprint
    // blocklist; Cloudflare Turnstile responds with error 600010
    // ("internal client execution error") rather than even trying to
    // grade the click. Override the two parameter codes on both
    // WebGL1 and WebGL2 prototypes to look like a stock Intel laptop
    // GPU. Doesn't change actual rendering — only the strings the
    // fingerprint probe reads back.
    await context.addInitScript(() => {
      const VENDOR_WEBGL = 0x9245; // UNMASKED_VENDOR_WEBGL
      const RENDERER_WEBGL = 0x9246; // UNMASKED_RENDERER_WEBGL
      const spoof = (proto: WebGLRenderingContext | WebGL2RenderingContext) => {
        const orig = proto.getParameter;
        proto.getParameter = function (this: typeof proto, p: number) {
          if (p === VENDOR_WEBGL) return "Intel Inc.";
          if (p === RENDERER_WEBGL) return "Intel(R) UHD Graphics 620";
          return orig.call(this, p);
        };
      };
      if (typeof WebGLRenderingContext !== "undefined") {
        spoof(WebGLRenderingContext.prototype as WebGLRenderingContext);
      }
      if (typeof WebGL2RenderingContext !== "undefined") {
        spoof(WebGL2RenderingContext.prototype as WebGL2RenderingContext);
      }
    });
    this.page = context.pages()[0] ?? (await context.newPage());

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
        if (!/challenges\.cloudflare\.com|google\.com\/recaptcha/.test(url)) {
          return;
        }
        const status = resp.status();
        const ct = resp.headers()["content-type"] ?? "";
        let bodyPreview = "";
        if (/json|javascript|html|plain/.test(ct)) {
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
        `[universal-bot] egress geo probe failed — using default ` +
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
    const raw = process.env.UNIVERSAL_BOT_PROXY_URL;
    if (raw === undefined || raw.trim().length === 0) return null;

    let proxy: ProxySettings;
    try {
      proxy = parseProxyUrl(raw);
    } catch (err) {
      console.error(
        `[universal-bot] UNIVERSAL_BOT_PROXY_URL is malformed — running ` +
          `direct: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const forceAlways = process.env.UNIVERSAL_BOT_PROXY_ALWAYS === "true";
    // detectAsn is best-effort (5s timeout, null on failure) → "unknown".
    const asn = await detectAsn();
    const asnClass: AsnClass = asn?.class ?? "unknown";
    if (shouldRouteThroughProxy(asnClass, forceAlways)) {
      console.error(
        `[universal-bot] routing through residential proxy ` +
          `(asn=${asnClass}${forceAlways ? ", forced" : ""})`,
      );
      return proxy;
    }
    console.error(
      `[universal-bot] direct connection (asn=${asnClass}) — proxy ` +
        `configured but not needed for this network`,
    );
    return null;
  }

  async goto(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
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
        `[universal-bot] referrer-chain prewarm partial failure (non-fatal): ${
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

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    if (!this.humanize) {
      await this.page.click(selector);
      return;
    }
    await this.humanClick(selector);
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
    const locator = this.page.locator(selector);
    const count = await locator.count();
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
      await this.page.check(selector, { force: true });
      return;
    }
    // For visible checkboxes, move the mouse to it first (a real user
    // would). For force-checked invisible ones, fall back to the
    // Playwright API so we don't try to mouse-click an offscreen element.
    try {
      await this.humanClick(selector);
      // Verify it actually became checked; some checkboxes need the
      // explicit `check()` call to flip state (e.g., styled labels
      // that swallow the click event).
      const isChecked = await this.page.locator(selector).isChecked();
      if (!isChecked) {
        await this.page.check(selector, { force: true });
      }
    } catch {
      await this.page.check(selector, { force: true });
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
    const tagName = await this.page
      .locator(selector)
      .first()
      .evaluate((node) => node.tagName.toLowerCase());

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
        .locator(`${selector} option`)
        .evaluateAll((opts) =>
          opts.map((o) => (o instanceof HTMLOptionElement ? o.value : "")),
        );
      if (allValues.length === 0) {
        throw new Error(`<select> ${selector} has no selectable option`);
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
          .locator(`${selector} option`)
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
        throw new Error(`<select> ${selector} has no selectable option`);
      }
      await this.page.selectOption(selector, chosenValue);
      // rc.17 — mark the element as touched so subsequent inventory
      // reads can suppress the DEFAULTED-dropdown warning for it.
      // Without this, a select whose committed value is "" (Railway's
      // "No workspace") keeps tripping the warning every round, and
      // the planner gets stuck in a select→select→… loop trying to
      // satisfy a warning the form has already satisfied.
      await this.page
        .locator(selector)
        .first()
        .evaluate((el) => {
          if (el instanceof HTMLElement) el.setAttribute("data-ts-touched", "1");
        })
        .catch(() => {});
      return;
    }

    // Custom combobox path. Sentry, Radix, Headless UI, React Aria
    // — every modern React picker emits role=option on its items.
    await this.selectFromCombobox(selector, optionMatcher);
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
    await this.humanClick(triggerSelector);

    const patternSelectors: readonly string[] = [
      '[role="option"]:visible',
      '[role="menuitem"]:visible',
      '[role="menuitemradio"]:visible',
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
      `combobox ${triggerSelector}: no options found after click. ` +
        `Tried: ${triedDescriptors.join(", ")}. ` +
        `The trigger may not have opened a popover, or the popover uses ` +
        `an option pattern this executor doesn't recognize.`,
    );
  }

  // F11: pick an option from a Playwright Locator already-narrowed to
  // candidates. Matcher → filter by hasText (case-insensitive by
  // default in Playwright). No matcher → first.
  private async pickComboboxOption(
    options: Locator,
    matcher?: string,
  ): Promise<void> {
    if (matcher !== undefined) {
      const filtered = options.filter({ hasText: matcher });
      const filteredCount = await filtered.count();
      if (filteredCount > 0) {
        await this.humanClickLocator(filtered.first());
        await this.wait(0.5);
        return;
      }
    }
    await this.humanClickLocator(options.first());
    await this.wait(0.5);
  }

  // ───────────── humanization internals ─────────────

  // Click that mimics a real user: locate element, bezier-path the
  // mouse to it, hover briefly, then click. The mouse position is
  // remembered so successive clicks form a continuous path.
  private async humanClick(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.humanClickLocator(this.page.locator(selector));
  }

  // Locator-based core of humanClick. Taking a Locator (not a selector
  // string) lets clickSubmit() hand us a `.nth(i)`-narrowed locator
  // when a selector matched several elements — a bare selector through
  // a strict-mode locator would throw before we could disambiguate.
  private async humanClickLocator(locator: Locator): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await locator.waitFor({ state: "visible", timeout: 10000 });
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
    // Poll for up to 6s for the disabled state to clear. Both the
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
      const deadline = Date.now() + 6000;
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
        throw new Error(
          "target is disabled (HTML disabled or aria-disabled=true) after 6s — " +
            "the click would no-op. A required precondition is unmet: an empty " +
            "input, an unselected dropdown, an unchecked agreement checkbox, or " +
            "a missing preset/permission choice. Do NOT retry this click — pick a " +
            "different action that fills the missing field first.",
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
        // Some Turnstile installs use a managed mode that emits its
        // own attribute on the host div when solved.
        const cfManaged = document.querySelector(".cf-turnstile[data-state='success']");
        if (cfManaged !== null) return true;
        return false;
      });
      if (solved) {
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
    kind: "turnstile" | "recaptcha";
    box: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!this.page) throw new Error("Browser not started");

    // Phase 1: iframe shape with polling.
    //   Cloudflare Turnstile: src contains "challenges.cloudflare.com"
    //   reCAPTCHA v2:         src contains "recaptcha/api2"
    const iframeCandidates: Array<{
      kind: "turnstile" | "recaptcha";
      selector: string;
    }> = [
      { kind: "turnstile", selector: 'iframe[src*="challenges.cloudflare.com"]' },
      { kind: "recaptcha", selector: 'iframe[src*="recaptcha/api2"]' },
    ];
    const iframeDeadline = Date.now() + 5000;
    while (Date.now() < iframeDeadline) {
      for (const { kind, selector } of iframeCandidates) {
        const locator = this.page.locator(selector);
        const count = await locator.count();
        if (count === 0) continue;
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          const box = await el.boundingBox();
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
      kind: "turnstile" | "recaptcha";
      selector: string;
    }> = [
      { kind: "turnstile", selector: 'input[name="cf-turnstile-response"]' },
      { kind: "recaptcha", selector: 'textarea[name="g-recaptcha-response"]' },
    ];
    for (const { kind, selector } of hostCandidates) {
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
        if (present('iframe[src*="challenges.cloudflare.com"]')) {
          variant = "turnstile";
        } else if (present('iframe[src*="hcaptcha.com"]')) {
          variant = "hcaptcha";
        } else if (present('iframe[src*="recaptcha/api2/anchor"]')) {
          variant = "recaptcha_v2";
        } else if (present(".grecaptcha-badge")) {
          // Badge but no clickable anchor → score-mode reCAPTCHA.
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
      screenshot: await this.screenshot(),
    };
  }

  async extractText(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.textContent("body") || "";
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
      // Find every Copy-class affordance.
      const copyButtons = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, [role="button"], a, [aria-label]',
        ),
      ).filter((el) => {
        if (!isVisible(el)) return false;
        const hay =
          `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.toLowerCase();
        return /\bcopy\b/.test(hay);
      });
      // For each, walk up a few ancestors and dump the subtree's
      // innerText. The token is somewhere in there.
      const seen = new Set<string>();
      for (const btn of copyButtons) {
        let anc: HTMLElement | null = btn;
        for (let i = 0; i < 6 && anc !== null; i++) {
          anc = anc.parentElement;
        }
        if (anc === null) continue;
        const text = (anc.innerText ?? "").trim();
        if (text.length === 0 || text.length > 4096) continue;
        // Tokenize by whitespace — each token is a separate candidate.
        text.split(/\s+/).forEach((tok) => {
          if (tok.length < 16 || tok.length > 256) return;
          if (seen.has(tok)) return;
          seen.add(tok);
          out.push(tok);
        });
      }
      return out;
    });
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
        if (
          el instanceof HTMLInputElement &&
          (el.type === "hidden" || el.type === "password")
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
        const count = await this.page.evaluate((min: number) => {
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
        }, minElements);
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
    let detected = await this.pollUntilInterstitialClears(timeoutMs);
    if (!detected) {
      // We either never saw an interstitial, or we saw one and it
      // cleared on its own. Nothing more to do.
      return;
    }
    // The interstitial outlived the wait. Cloudflare frequently shows
    // "Verification successful. Wait" but then never fires the JS
    // redirect — the challenge passed, but the redirect script got
    // stuck or the cookie set is racing the navigation. A single
    // reload, now that the cf_clearance cookie is set, often lets the
    // real page render. (If the issue is a server-side risk-score
    // block — fingerprint/IP — reload won't help, but the caller's
    // inventory diagnostic will still surface the block.)
    try {
      await this.page.reload({ waitUntil: "networkidle", timeout: 10_000 });
    } catch {
      // reload failed — proceed with what's there
    }
    await this.pollUntilInterstitialClears(Math.max(5000, timeoutMs / 2));
  }

  // One poll loop. Returns true if an interstitial was ever observed
  // (cleared or still there at timeout), false if never seen.
  private async pollUntilInterstitialClears(timeoutMs: number): Promise<boolean> {
    if (!this.page) return false;
    const deadline = Date.now() + timeoutMs;
    let detected = false;
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
      const onInterstitial =
        /just a moment|performing security verification|verifying you are human|checking your browser|attention required/i.test(
          title + " " + bodyText,
        );
      if (!onInterstitial) {
        if (detected) {
          // Give the freshly-revealed page a tick to hydrate before
          // the inventory scan.
          await new Promise((r) => setTimeout(r, 800));
        }
        return detected;
      }
      detected = true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return detected;
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
        'input,textarea,select,button,a,label,[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="combobox"],[contenteditable=""],[contenteditable="true"]';

      // Collect candidates across the document and every open shadow
      // root. Closed shadow roots are unreachable — accepted.
      const collected: Element[] = [];
      const walk = (root: Document | ShadowRoot): void => {
        root.querySelectorAll(SELECTOR).forEach((n) => collected.push(n));
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot !== null) walk(el.shadowRoot);
        });
      };
      walk(document);

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
        const anc = el.closest("label");
        return anc !== null ? clean(anc.textContent) : null;
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
        const id = el.getAttribute("id");
        const name = el.getAttribute("name");
        if (id !== null && /^[A-Za-z][\w-]*$/.test(id)) {
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

      const seen = new Set<Element>();
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
        title: string | null;
        landmark: string | null;
        value: string | null;
        selectOptions: Array<{ value: string; text: string }> | null;
        selectedOptionText: string | null;
        interactedThisRun: boolean;
      }> = [];
      for (const el of collected) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el) && !isCheckableHiddenByStyledLabel(el)) continue;
        const r = el.getBoundingClientRect();
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          id: el.getAttribute("id"),
          name: el.getAttribute("name"),
          placeholder: el.getAttribute("placeholder"),
          ariaLabel: el.getAttribute("aria-label"),
          role: el.getAttribute("role"),
          labelText: labelFor(el),
          visibleText: clean(el.textContent),
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
        });
      }
      return out;
    });
    return raw.map((e, i) => ({ ...e, index: i }));
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
    this.oauthProductPage = this.page;
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
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      // best-effort — the agent's consent loop re-reads state regardless
    }
  }

  // URL of the active page (the OAuth page mid-handshake, the product
  // page otherwise). Cheap — no screenshot, unlike getState().
  currentUrl(): string {
    return this.page !== null ? this.page.url() : "";
  }

  // True when the active OAuth page is gone — for the popup flow, the
  // popup closing IS the signal the handshake finished.
  oauthPageClosed(): boolean {
    return this.page === null || this.page.isClosed();
  }

  // Advance a provider's consent / account-chooser screen by one click
  // — the scope-gated auto-approve (T7/T13). Returns false when no
  // approve control is present — the agent then aborts rather than
  // hang. Clicks only; never types (the critical guarantee holds here).
  async advanceOAuthConsent(provider: OAuthProviderId): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    if (provider === "github") {
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
        `[universal-bot] GitHub advanceOAuthConsent failed — visible buttons: ` +
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
    // Consent screen: the approve control's accessible name is
    // "Continue" or "Allow". A full-match regex excludes "Cancel".
    const approve = this.page
      .getByRole("button", { name: /^(continue|allow)$/i })
      .first();
    if ((await approve.count().catch(() => 0)) > 0) {
      try {
        await approve.click({ timeout: 8000 });
        return true;
      } catch {
        return false;
      }
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
    if (this.page) await this.page.close();
    // Closing the persistent context shuts the browser down too.
    if (this.context) await this.context.close();
    // F13 — release the on-demand Xvfb if we spawned one. Order
    // matters: kill Chrome (context.close) first so it has its
    // display until it exits, THEN kill Xvfb.
    if (this.xvfb !== null) {
      this.xvfb.stop();
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
// Same shape and rationale as agent.ts's pickVerificationLink: a positive
// score gate so an OAuth-only page (every candidate negative) returns
// null rather than mis-clicking "Continue with Google".
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
