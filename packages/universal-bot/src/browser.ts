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
import type { Browser, Locator, Page } from "playwright";
import { createRequire } from "node:module";

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
}

export type CaptchaKind = "turnstile" | "recaptcha";

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
  private browser: Browser | null = null;
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

  constructor(opts: BrowserControllerOptions = {}) {
    this.humanize = opts.humanize ?? true;
  }

  // Which browser channel the most recent .start() actually used.
  // `null` means bundled Chromium; a string like "chrome" means a
  // real installed browser of that channel. Throws if .start() hasn't
  // been called yet — there's no sensible default to return.
  get channel(): string | null {
    if (this.browser === null) {
      throw new Error("BrowserController.channel read before .start()");
    }
    return this.launchedChannel;
  }

  async start(): Promise<void> {
    const channel = await detectChromiumChannel();
    this.launchedChannel = channel;
    // Stderr so the MCP stdio transport's framing stays clean (the
    // module's existing logging convention).
    console.error(
      `[universal-bot] launching browser channel=${channel ?? "bundled-chromium"}`,
    );
    this.browser = await getChromium().launch({
      headless: process.env.UNIVERSAL_BOT_HEADLESS !== "false",
      // `channel:` is a Playwright launch option that tells it to use a
      // real installed browser instead of the bundled binary. When null
      // we omit the key entirely so Playwright falls back to default.
      ...(channel !== null ? { channel } : {}),
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    // Patch the navigator.webdriver flag — most anti-bot heuristics look here.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    this.page = await context.newPage();
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

  async close(): Promise<void> {
    if (this.page) await this.page.close();
    if (this.browser) await this.browser.close();
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
    const t = raw.toLowerCase();
    let score = 0;
    if (t.includes("create account") || t.includes("create your account")) score += 12;
    if (t.includes("sign up") || t.includes("signup")) score += 10;
    if (t.includes("register")) score += 8;
    if (t.includes("get started")) score += 6;
    // "Continue" is often the real submit on single-field signup forms;
    // weak positive so it wins over nothing but loses to OAuth markers.
    if (t.includes("continue")) score += 2;
    // OAuth / SSO buttons are submit-typed too — the provider name is
    // the reliable discriminator, so drive those firmly negative.
    if (/\b(google|github|gitlab|microsoft|apple|facebook|okta|sso)\b/.test(t)) score -= 20;
    if (t.includes("sign in") || t.includes("log in") || t.includes("login")) score -= 12;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}
