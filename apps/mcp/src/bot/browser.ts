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
    // T3: a PERSISTENT context. The profile dir carries the user's
    // Google session (established by `mcp login` — see google-login.ts),
    // so the OAuth-first signup path reuses it instead of starting
    // logged-out. launchPersistentContext takes launch + context
    // options in one call.
    const context = await getChromium().launchPersistentContext(this.profileDir, {
      headless: process.env.UNIVERSAL_BOT_HEADLESS !== "false",
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
      ...(geo?.geolocation !== undefined
        ? { geolocation: geo.geolocation, permissions: ["geolocation"] }
        : {}),
    });
    this.context = context;
    // Patch the navigator.webdriver flag — most anti-bot heuristics look here.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    this.page = context.pages()[0] ?? (await context.newPage());
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
      const resultSelector = `a[href^="${targetOrigin}"]`;
      const hasResult = (await this.page.locator(resultSelector).count()) > 0;
      if (hasResult) {
        // Use humanClick if available — moves the mouse along a bezier
        // path to the link, which feeds the scoring JS pointer entropy
        // as a side effect.
        if (this.humanize) {
          await this.humanClick(resultSelector);
        } else {
          await this.page.click(resultSelector);
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
    //   - pressSequentially with per-character delay 40-110ms baseline
    //   - Inject occasional "thinking" pauses 200-600ms every ~5-12 chars
    //
    // page.fill() bypasses keydown/keypress/input events entirely — it
    // sets value via JS. That's a giant red flag to behavior scoring.
    // pressSequentially emits real key events so the page sees a normal
    // typing pattern.
    await this.humanClick(selector);
    // Clear any prefilled value (browser autofill, etc.) before typing.
    const locator = this.page.locator(selector);
    await locator.fill("");
    let typedSinceLastPause = 0;
    let nextPauseAt = rand(5, 12);
    for (const ch of text) {
      // Per-char delay. Real typing is bursty; we use a slightly
      // skewed distribution that occasionally lands a fast char and
      // occasionally a slow one.
      await locator.pressSequentially(ch, { delay: rand(40, 110) });
      typedSinceLastPause += 1;
      if (typedSinceLastPause >= nextPauseAt) {
        // Brief "thinking" pause — looking at the keyboard, reading
        // the label, etc.
        await this.sleep(rand(180, 600));
        typedSinceLastPause = 0;
        nextPauseAt = rand(5, 12);
      }
    }
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    if (!this.humanize) {
      await this.page.click(selector);
      return;
    }
    await this.humanClick(selector);
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

  // Pick a valid option for a <select> (F3 T6). The bot must not call
  // type() on a <select> (Sentry: "Element is not an <input>").
  // Signup <select>s are country / region / role pickers — any
  // non-placeholder option satisfies the form. Throws (caught by the
  // executor) when the select has no selectable option.
  async selectOption(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    const values = await this.page
      .locator(`${selector} option`)
      .evaluateAll((opts) =>
        opts
          .map((o) => (o instanceof HTMLOptionElement ? o.value : ""))
          .filter((v) => v.length > 0),
      );
    const first = values[0];
    if (first === undefined) {
      throw new Error(`<select> ${selector} has no selectable option`);
    }
    await this.page.selectOption(selector, first);
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
    if (this.humanize) {
      await this.bezierMouseTo(clickX, clickY);
      await this.sleep(rand(120, 350));
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
  private async findCaptchaWidget(): Promise<{
    kind: "turnstile" | "recaptcha";
    box: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!this.page) throw new Error("Browser not started");

    // Cloudflare Turnstile iframes look like:
    //   https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/...
    // reCAPTCHA v2 iframes look like:
    //   https://www.google.com/recaptcha/api2/anchor?...
    const candidates: Array<{ kind: "turnstile" | "recaptcha"; selector: string }> = [
      { kind: "turnstile", selector: 'iframe[src*="challenges.cloudflare.com"]' },
      { kind: "recaptcha", selector: 'iframe[src*="recaptcha/api2"]' },
    ];

    for (const { kind, selector } of candidates) {
      const locator = this.page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;
      // Some pages embed multiple widgets (e.g., one in the signup
      // form, one in a hidden login modal). Take the first visible
      // one with a non-trivial bounding box.
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        const box = await el.boundingBox();
        if (box === null) continue;
        if (box.width < 50 || box.height < 30) continue; // hidden/clipped
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
    const buffer = await this.page.screenshot({ fullPage: false });
    return buffer.toString("base64");
  }

  async getState(): Promise<BrowserState> {
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
    try {
      await this.page.waitForLoadState("networkidle", { timeout: timeoutMs });
    } catch {
      // networkidle never settles on pages with analytics sockets or
      // long-poll — not fatal, fall through to the element wait.
    }
    try {
      await this.page.waitForSelector("input, button", {
        state: "visible",
        timeout: timeoutMs,
      });
    } catch {
      // No interactive element appeared in time — let the planner run
      // anyway; it fails cleanly rather than hanging.
    }
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
        'input,textarea,select,button,a,[role="button"],[role="checkbox"],[contenteditable=""],[contenteditable="true"]';

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
      }> = [];
      for (const el of collected) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el)) continue;
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
      // GitHub's authorize screen: a single green "Authorize <app>"
      // button. The accessible name starts with "Authorize".
      const authorize = this.page
        .getByRole("button", { name: /^authorize\b/i })
        .first();
      if ((await authorize.count().catch(() => 0)) > 0) {
        try {
          await authorize.click({ timeout: 8000 });
          return true;
        } catch {
          return false;
        }
      }
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
}

// Score a button/link by how much its text reads like a signup
// action. Shared by submit-button disambiguation, the two-stage
// chooser pick, and inventory button-ranking — one keyword set, no
// drift (F3 Issue 8). OAuth provider names go firmly negative so the
// bot never wanders into a Google/GitHub login dead end.
//
// `oauthProvider` (T6/T13) inverts that for the requested provider:
// when an OAuth-first signup is requested, the "Sign in with
// <provider>" affordance is the PRIMARY target, not a dead end — so it
// must score positive enough to survive inventory ranking/capping.
// Stated as a rule, not arithmetic (spec refinement): under OAuth-first
// the provider's button outranks any form field. Only the REQUESTED
// provider flips positive; the others stay negative.
export function scoreSignupButton(
  text: string,
  oauthProvider?: OAuthProviderId,
): number {
  const t = text.toLowerCase();
  let score = 0;
  if (t.includes("create account") || t.includes("create your account")) score += 12;
  if (t.includes("sign up") || t.includes("signup")) score += 10;
  if (t.includes("register")) score += 8;
  if (t.includes("get started")) score += 6;
  if (
    t.includes("continue with email") ||
    t.includes("sign up with email") ||
    t.includes("email")
  ) {
    score += 5;
  }
  // Weak positive: "Continue" is often the real submit on single-field
  // forms; it should beat nothing but lose to OAuth markers.
  if (t.includes("continue")) score += 2;
  if (oauthProvider !== undefined && new RegExp(`\\b${oauthProvider}\\b`).test(t)) {
    // OAuth-first: the requested provider's button is the goal. Score
    // it above every form-field-class button so ranking never caps it out.
    score += 50;
  } else if (/\b(google|github|gitlab|microsoft|apple|facebook|okta|sso|saml)\b/.test(t)) {
    // OAuth / SSO buttons are submit-typed too — the provider name is
    // the reliable discriminator, so drive those firmly negative.
    score -= 20;
  }
  if (t.includes("sign in") || t.includes("log in") || t.includes("login")) score -= 12;
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
  oauthProvider?: OAuthProviderId,
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
        oauthProvider,
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
