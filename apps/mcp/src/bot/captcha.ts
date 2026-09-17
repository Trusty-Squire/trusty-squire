// Captcha widget detection, solving, and 2Captcha token injection.
//
// Moved out of browser.ts (design PR 7, layer-contracts): every captcha
// primitive — detection, the substrate solves, token injection — lives here.
// Functions take the live BrowserController as their first argument for the
// operations that need the humanized mouse path and request-lease-aware
// sleeps; the pure page readers/writers take only the page. The controller
// keeps no captcha state.
//
// Tier 2 is the click-and-wait solve (Turnstile/reCAPTCHA v2 checkbox);
// Tier 3 is the 2Captcha token solver merged verbatim from
// captcha-solver-2captcha.ts at the bottom of this file. browser.ts imports
// back only isCaptchaFrameUrl for its frame walk. What ORCHESTRATES a Tier 3
// solve lives in captcha-solve.ts: the vault-backed transport both callers
// share, plus the operate-path auto-solve.

import type { Page } from "playwright";

import type { BrowserController } from "./browser.js";

const HCAPTCHA_UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

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
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
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

// Hosts of known captcha-challenge iframes (Turnstile, reCAPTCHA, hCaptcha,
// Arkose/FunCaptcha). Shared between the per-navigation WebGL-spoof reapply
// (start(), below) and extractInteractiveElements' frame walk, which skips
// these frames — their content is handled by the dedicated captcha-gate flow,
// not surfaced as ordinary el_table rows.
const CAPTCHA_FRAME_HOST_RE =
  /(?:^|\.)(?:hcaptcha\.com|challenges\.cloudflare\.com|recaptcha\.net|arkoselabs\.com|funcaptcha\.com)$/i;
const GOOGLE_RECAPTCHA_HOST_RE = /(?:^|\.)google\.com$/i;

export function isCaptchaFrameUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      CAPTCHA_FRAME_HOST_RE.test(url.hostname) ||
      (GOOGLE_RECAPTCHA_HOST_RE.test(url.hostname) && /^\/recaptcha(?:\/|$)/i.test(url.pathname))
    );
  } catch {
    return false;
  }
}

export type CaptchaKind = "turnstile" | "recaptcha" | "hcaptcha";

// Finer-grained captcha classification for spike telemetry (T3.2).
// `recaptcha_v3` covers any score-mode reCAPTCHA with no clickable
// checkbox (true v3 and v2-invisible behave the same to the bot:
// nothing to solve). Static-vs-dynamic of a v2 grid is intentionally
// not split here — reliable pre-solve classification needs the grid
// inspection that T3.4 (Module A) builds; the spike's question is
// answered by family + challenge_rendered.
export type CaptchaVariant = "turnstile" | "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "unknown";

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

// Timing-only jitter, same shape as browser.ts/page-driver.ts's local copies.
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
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
export async function solveVisibleCaptcha(
  browser: BrowserController,
  timeoutMs = 30000,
  page: Page | null = browser.page,
): Promise<CaptchaSolveResult> {
  if (!page) throw new Error("Browser not started");

  // Locate the widget. Turnstile and reCAPTCHA both use distinctive
  // iframe URLs that are easy to discriminate.
  const widget = await findCaptchaWidget(browser, page);
  if (widget === null) return { found: false };

  // rc.33 — fingerprint probe. When tracing, dump the values
  // Cloudflare Turnstile (and other anti-bot solutions) actually
  // read: WebGL renderer/vendor strings, canvas hash, hw concurrency,
  // device memory, screen, languages, webdriver flag. Turnstile
  // error 600010 ("internal client execution error") usually points
  // at one of these returning something the challenge JS can't
  // handle (e.g. a SwiftShader/llvmpipe renderer).
  if (process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1") {
    try {
      const fp = await page.evaluate(() => {
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
            out.webglShadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
            const dbg = gl.getExtension("WEBGL_debug_renderer_info");
            if (dbg !== null) {
              out.webglUnmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
              out.webglUnmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
            }
            out.webglExtensions = (gl.getSupportedExtensions() ?? []).slice(0, 6).join(",");
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
        out.deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
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
      browser.logOperatorDiagnostic("[fingerprint] " + JSON.stringify(fp));
    } catch (err) {
      browser.logOperatorDiagnostic(
        "[fingerprint] probe failed: " + (err instanceof Error ? err.message : String(err)),
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
  if (browser.humanize) {
    const wanderX = widget.box.x + widget.box.width / 2 + rand(-40, 40);
    const wanderY = widget.box.y - rand(60, 110);
    await browser.bezierMouseTo(wanderX, wanderY, page);
    await browser.sleep(rand(600, 1400));
    await browser.bezierMouseTo(clickX, clickY, page);
    await browser.sleep(rand(180, 450));
  }
  await page.mouse.click(clickX, clickY);
  browser.mouseX = clickX;
  browser.mouseY = clickY;

  // Poll for the success token. We check both Turnstile and reCAPTCHA
  // selectors because some sites embed multiple widgets and we want
  // either to count.
  const start = Date.now();
  const pollIntervalMs = 500;
  while (Date.now() - start < timeoutMs) {
    await browser.sleep(pollIntervalMs);
    const solved = await page.evaluate(() => {
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
      // The minted response token IS the success signal (see the module's
      // own comments and captchaGate's). The removed 5a018714 hCaptcha
      // branch additionally required the challenge iframe to stay gone for
      // 10 continuous seconds and returned `solved: false` otherwise —
      // measured live to discard a genuinely minted hCaptcha token after
      // 15.7s, and to spend 10.6s even when the frame did clear.
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
async function findCaptchaWidget(
  browser: BrowserController,
  page: Page | null,
): Promise<{
  kind: CaptchaKind;
  box: { x: number; y: number; width: number; height: number };
} | null> {
  if (!page) throw new Error("Browser not started");

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
  const recaptchaInvisibleOnly = await page
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
        q('iframe[src*="recaptcha/api2/anchor"][src*="size=invisible"]') || q(".grecaptcha-badge");
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
    {
      kind: "recaptcha",
      selector: 'iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])',
    },
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
      const locator = page.locator(selector);
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
    await browser.sleep(250);
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
    const locator = page.locator(selector);
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
export async function detectCaptchaVariant(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<{
  variant: CaptchaVariant;
  challengeRendered: boolean;
}> {
  if (!page) throw new Error("Browser not started");
  try {
    const raw = await page.evaluate(() => {
      const present = (sel: string): boolean => document.querySelector(sel) !== null;
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
      } else if (present('iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])')) {
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
    // hCaptcha's checkbox and challenge iframes are CHILDREN of the
    // cross-origin hcaptcha.html frame host, and Bluesky renders that host
    // inside a shadow root — so a main-document querySelector can never see
    // them (step-3 gate: checkbox toggled, image grid rendered, `variant`
    // still "unknown" and `challengeRendered` still false). Classify and
    // check the rendered challenge against the LIVE frame tree instead. The
    // checkbox frame's URL (`frame=checkbox`) never matches the challenge
    // pattern, so a mere checkbox still reads as no rendered challenge —
    // the solver only escalates once the image grid exists.
    let variant = isCaptchaVariant(raw.variant) ? raw.variant : "unknown";
    let hcaptchaChallengeFrameRendered = false;
    if (variant === "unknown" || !raw.challengeRendered) {
      for (const frame of page.frames()) {
        const url = frame.url();
        if (
          url.includes("hcaptcha.com") &&
          /(?:hcaptcha-challenge\.html|frame=challenge)/i.test(url)
        ) {
          hcaptchaChallengeFrameRendered = true;
        }
        if (variant === "unknown" && url.includes("hcaptcha.com")) {
          variant = "hcaptcha";
        }
        if (variant === "unknown" && url.includes("challenges.cloudflare.com")) {
          variant = "turnstile";
        }
      }
    }
    return {
      variant,
      challengeRendered: raw.challengeRendered || hcaptchaChallengeFrameRendered,
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
export async function extractRecaptchaSitekey(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<string | null> {
  if (!page) throw new Error("Browser not started");
  try {
    const sitekey = await page.evaluate(() => {
      const isRecaptchaKey = (k: string | null): k is string =>
        k !== null && /^6L/.test(k) && k.length > 30;
      // 1. data-sitekey, but NOT on an hCaptcha/Turnstile widget (or
      //    nested inside one). Those publish data-sitekey too.
      const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-sitekey]")).filter(
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
export async function injectRecaptchaToken(
  browser: BrowserController,
  token: string,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  try {
    const injected = await page.evaluate((tok: string) => {
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
        const cfg = (
          window as unknown as {
            ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
          }
        ).___grecaptcha_cfg;
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
export async function extractTurnstileSitekey(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<string | null> {
  if (!page) throw new Error("Browser not started");
  try {
    return await page.evaluate(() => {
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
export async function injectTurnstileToken(
  browser: BrowserController,
  token: string,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  try {
    return await page.evaluate((tok: string) => {
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
export async function triggerInvisibleRecaptcha(
  browser: BrowserController,
  timeoutMs = 9000,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  const tokenPresent = (): Promise<boolean> => hasCaptchaResponseToken(page);

  if (await tokenPresent()) return true;

  const fired = await page
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
    await browser.sleep(500);
    if (await tokenPresent()) return true;
  }
  return false;
}

// The provider → response-field rule, in ONE place: both the any-provider
// check and the variant-scoped one below fold over it.
const VARIANT_RESPONSE_SELECTOR: Record<Exclude<CaptchaVariant, "unknown">, string> = {
  recaptcha_v2: 'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]',
  recaptcha_v3: 'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]',
  hcaptcha: 'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"]',
  turnstile: 'input[name="cf-turnstile-response"], input[id^="cf-chl-widget"]',
};

// Turnstile also marks its host element on success, with no value anywhere.
const TURNSTILE_SUCCESS_SELECTOR = ".cf-turnstile[data-state='success']";

async function hasResponseTokenIn(
  page: Page | null,
  selectors: string[],
  turnstile: boolean,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  return page
    .evaluate(
      ({ sels, cf }: { sels: string[]; cf: string | null }) => {
        for (const sel of sels) {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
          if (el !== null && el.value.trim().length > 0) return true;
        }
        return cf !== null && document.querySelector(cf) !== null;
      },
      { sels: selectors, cf: turnstile ? TURNSTILE_SUCCESS_SELECTOR : null },
    )
    .catch(() => false);
}

async function hasCaptchaResponseToken(page: Page | null): Promise<boolean> {
  return hasResponseTokenIn(page, Object.values(VARIANT_RESPONSE_SELECTOR), true);
}

export async function waitForCaptchaResponseToken(
  browser: BrowserController,
  timeoutMs = 5000,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  const start = Date.now();
  do {
    if (await hasCaptchaResponseToken(page)) return true;
    await browser.sleep(250);
  } while (Date.now() - start < timeoutMs);
  return false;
}

// Whether the DETECTED provider already holds a token. Unlike
// hasCaptchaResponseToken this does not answer true for a co-resident
// provider's field, so a page running reCAPTCHA v3 for scoring alongside a
// rendered hCaptcha gate is not mistaken for "already solved".
export async function hasCaptchaResponseTokenForVariant(
  browser: BrowserController,
  variant: CaptchaVariant,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (variant === "unknown") return false;
  return hasResponseTokenIn(page, [VARIANT_RESPONSE_SELECTOR[variant]], variant === "turnstile");
}

// The same question for hCaptcha, allowing for its DROP-IN shape: a page that
// swapped hCaptcha in for reCAPTCHA carries no h-captcha-response field at all,
// and injectHcaptchaToken legitimately lands the token in the g-recaptcha-response
// compat field instead. Only a page with NO own field of its own answers from
// the compat one — where both exist, the co-resident reCAPTCHA's token is not
// hCaptcha's answer.
export async function hasHcaptchaResponseTokenWithCompat(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  // The widget can live in a dedicated gate frame (e.g. Bluesky embeds a
  // cross-origin bsky.social/gate/signup frame that owns the response
  // textareas), so the check must run in EVERY frame — a main-frame-only
  // evaluate never sees the token that landed there.
  for (const frame of page.frames()) {
    const present = await frame
      .evaluate(
        ({ own, compat }: { own: string; compat: string }) => {
          // Shadow-DOM-aware: the widget host (and its response textarea) can
          // sit inside an open shadow root, invisible to document.querySelector.
          const deepAll = (selector: string): Element[] => {
            const out: Element[] = [];
            const walk = (root: Document | ShadowRoot): void => {
              for (const el of Array.from(root.querySelectorAll(selector))) out.push(el);
              for (const el of Array.from(root.querySelectorAll("*"))) {
                const sr = (el as HTMLElement).shadowRoot;
                if (sr) walk(sr);
              }
            };
            walk(document);
            return out;
          };
          const value = (selector: string): string | null => {
            const el = deepAll(selector)[0] as HTMLInputElement | HTMLTextAreaElement | undefined;
            return el === undefined ? null : el.value.trim();
          };
          const ownValue = value(own);
          if (ownValue !== null) return ownValue.length > 0;
          return (value(compat) ?? "").length > 0;
        },
        { own: VARIANT_RESPONSE_SELECTOR.hcaptcha, compat: VARIANT_RESPONSE_SELECTOR.recaptcha_v2 },
      )
      .catch(() => false);
    if (present) return true;
  }
  return false;
}

// Tier 3 hCaptcha support — extract the hCaptcha sitekey so 2Captcha
// can solve it. hCaptcha publishes its key on `.h-captcha[data-sitekey]`
// or in the checkbox iframe's `?sitekey=` query. Keys are UUIDs (the
// reCAPTCHA `6L` guard in extractRecaptchaSitekey deliberately rejects
// them, which is why hCaptcha needs its own extractor). Returns null
// when no hCaptcha widget is present.
export async function extractHcaptchaSitekey(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<string | null> {
  if (!page) throw new Error("Browser not started");
  try {
    const fromDom = await page.evaluate(() => {
      const div = document.querySelector<HTMLElement>(
        ".h-captcha[data-sitekey], [data-hcaptcha-sitekey]",
      );
      if (div !== null) {
        const k = div.getAttribute("data-sitekey") ?? div.getAttribute("data-hcaptcha-sitekey");
        if (k !== null && k.length > 10) return k;
      }
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]');
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
    // SHADOW-ROOT embeds (Bluesky): the hCaptcha host is rendered inside a
    // shadow root, so a main-document querySelector never sees the widget
    // div or its iframes — but Playwright tracks the live frame tree
    // regardless of DOM nesting. The widget's own frame URL carries the
    // sitekey in its query or hash params; a plain hcaptcha.com asset frame
    // without a sitekey param contributes nothing.
    for (const frame of page.frames()) {
      const url = frame.url();
      if (!url.includes("hcaptcha.com")) continue;
      try {
        const parsed = new URL(url);
        const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
        const k =
          parsed.searchParams.get("sitekey") ?? new URLSearchParams(hash).get("sitekey");
        if (k !== null && k.length > 10) return k;
      } catch {
        // not a parseable URL — skip this frame
      }
    }
    // INVISIBLE hCaptcha (Hugging Face, Stripe): no .h-captcha div, no
    // iframe `?sitekey=` param — the sitekey lives in the page's JS/JSON
    // config (`captchaApiKey`, `express_hcaptcha_site_key`,
    // `hcaptcha_login_main_site_key`, etc.). Scan the HTML for a UUID-shaped
    // key next to a sitekey/captcha hint, but only when an hCaptcha marker is
    // present so an unrelated config UUID cannot match.
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    return extractHcaptchaSitekeyFromHtml(html);
  } catch {
    return null;
  }
}

// The page URL the widget is rendered on. Ordinary integrations render the
// container in the top document; some sites (Bluesky's signup gate) embed it
// in a cross-origin iframe, and the hCaptcha token's siteverify `hostname`
// derives from the page the solve is attributed to — so the widget-hosting
// frame's URL, not the top page, is the faithful attribution. Returns null
// when no distinct widget-hosting frame is found (solve attributes to the
// top page).
export async function findHcaptchaWidgetPageUrl(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<string | null> {
  if (!page) throw new Error("Browser not started");
  const topUrl = page.url();
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url === topUrl || url === "about:blank") continue;
    if (/hcaptcha\.com|newassets\.hcaptcha\.com/.test(url)) continue;
    try {
      const hosts = await frame.evaluate(() => ({
        container:
          document.querySelector<HTMLElement>("[data-sitekey], .h-captcha") !== null,
        textarea:
          document.querySelector<HTMLTextAreaElement>(
            'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]',
          ) !== null,
      }));
      if (hosts.container || hosts.textarea) return url;
    } catch {
      // detached or inaccessible frame — skip
    }
  }
  return null;
}

async function getBrowserUserAgent(page: Page | null): Promise<string | null> {
  if (!page) throw new Error("Browser not started");
  try {
    return await page.evaluate(() => navigator.userAgent);
  } catch {
    return null;
  }
}

export async function getHcaptchaSolveContext(
  browser: BrowserController,
  page: Page | null = browser.page,
): Promise<{
  invisible: boolean;
  userAgent: string | null;
  rqdata: string | null;
}> {
  if (!page) throw new Error("Browser not started");
  try {
    return await page.evaluate(() => {
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
          const clientOptions =
            url.searchParams.get("clientOptions") ?? hashParams.get("clientOptions");
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
      userAgent: await getBrowserUserAgent(page).catch(() => null),
      rqdata: null,
    };
  }
}

// Inject a 2Captcha-resolved hCaptcha token into the page's
// h-captcha-response textarea(s), update hCaptcha runtime response
// accessors, and fire registered callbacks. Mirrors injectRecaptchaToken;
// hCaptcha also mirrors the response token into a g-recaptcha-response
// textarea on some compat installs, so populate both names if present.
export async function injectHcaptchaToken(
  browser: BrowserController,
  token: string,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  try {
    const responseKey = extractHcaptchaResponseKeyFromToken(token);
    // The widget and its SDK can live in a dedicated gate frame (e.g. Bluesky
    // embeds a cross-origin bsky.social/gate/signup frame that owns the
    // response textareas), so the fill must run in EVERY frame — a
    // main-frame-only evaluate lands nothing.
    let ok = false;
    for (const frame of page.frames()) {
      try {
        const diag = await frame.evaluate(hcaptchaInjectScript, {
          tok: token,
          key: responseKey,
        });
        console.error(
          `[captcha-inject-diag] frame=${frame.url().slice(0, 60)} ok=${diag.ok} textareas=${diag.textareas} widgets=${diag.widgets} callbackFired=${diag.callbackFired} formSubmitted=${diag.formSubmitted} dataCbHosts=${diag.dataCallbackHosts} globalFns=${diag.globalFnMatches} hasGlobal=${diag.hasHcaptchaGlobal}`,
        );
        if (diag.ok) ok = true;
      } catch {
        // A frame can detach mid-injection; the others still get the token.
      }
    }
    return ok;
  } catch {
    return false;
  }
}

// Page-side fill body, run in every frame. Self-contained: Playwright
// serializes only this function's source, closure variables do not travel.
// Exported for the detached gate-page handoff (captcha-solve.ts), which runs
// the same fill on a standalone copy of a gate URL with `submitMode: "top"`.
export function hcaptchaInjectScript({
  tok,
  key,
  submitMode = "hidden-frame",
}: {
  tok: string;
  key: string | null;
  submitMode?: "hidden-frame" | "top";
}): {
  ok: boolean;
  textareas: number;
  widgets: number;
  callbackFired: boolean;
  formSubmitted: boolean;
  dataCallbackHosts: number;
  globalFnMatches: number;
  hasHcaptchaGlobal: boolean;
} {
  {
        // Shadow-DOM-aware: the widget host and its response textarea can sit
        // inside an open shadow root, invisible to document.querySelector.
        const deepAll = (selector: string): Element[] => {
          const out: Element[] = [];
          const walk = (root: Document | ShadowRoot): void => {
            for (const el of Array.from(root.querySelectorAll(selector))) out.push(el);
            for (const el of Array.from(root.querySelectorAll("*"))) {
              const sr = (el as HTMLElement).shadowRoot;
              if (sr) walk(sr);
            }
          };
          walk(document);
          return out;
        };
        const widgetIds = new Set<string>();
        const inputs = deepAll(
          'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"], textarea[name="g-recaptcha-response"]',
        ) as HTMLTextAreaElement[];
        for (const input of inputs) {
          // g-recaptcha-response is hCaptcha's DROP-IN compat field: filling it
          // is right when hCaptcha replaced reCAPTCHA, and wrong when the two
          // are co-resident — there it holds a live reCAPTCHA score token an
          // hCaptcha token would invalidate. Fill it only when it is empty.
          if (input.name === "g-recaptcha-response" && input.value.trim().length > 0) continue;
          input.value = tok;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        for (const host of Array.from(
          deepAll(".h-captcha, [data-hcaptcha-widget-id], [data-hcaptcha-response]"),
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
            if (id === undefined || widgetIds.size === 0 || widgetIds.has(String(id)))
              return key ?? "";
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
        // Not scoped to .h-captcha hosts: some integrations (e.g. Bluesky's
        // signup gate) put data-callback on the plain div the SDK renders
        // into, and that div never gains the h-captcha class.
        try {
          for (const host of Array.from(deepAll("[data-callback]"))) {
            const name = (host as HTMLElement).getAttribute("data-callback");
            if (name) fire(win[name]);
          }
        } catch {
          // no named callback, continue to runtime config scan.
        }
        // Last resort: a page that wires its completion through a well-named
        // global (e.g. onCaptchaComplete) but registers it programmatically.
        // Deliberately NOT matching /captcha/ - that also catches
        // onCaptchaError / onCaptchaExpired, which must never fire.
        if (!callbackFired) {
          try {
            for (const name of Object.getOwnPropertyNames(win)) {
              if (
                typeof win[name] === "function" &&
                /complete|success|verify/i.test(name)
              ) {
                fire(win[name]);
              }
            }
          } catch {
            // heuristic only
          }
        }
        // Programmatic hCaptcha integrations pass function callbacks to
        // hcaptcha.render(). The SDK keeps them in ___hcaptcha_cfg; crawl it
        // generically so React/Vue wrappers are handled like plain forms.
        // This must run BEFORE the form-submit fallback below: a programmatic
        // integration whose response textarea sits inside a form has no
        // data-callback attribute and no well-named global, so an earlier
        // submit would bypass the app's own completion handler and then double
        // up when the real callback fired here.
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

        // Final fallback for classic form-post integrations: no callback was
        // reachable, but the token now sits in a response textarea INSIDE a
        // form - the standard hCaptcha contract reads exactly that field at
        // submit time, so submitting is the completion a solved human would
        // trigger. Only forms that actually contain the filled field qualify.
        let formSubmitted = false;
        if (!callbackFired && inputs.length > 0) {
          try {
            for (const input of inputs) {
              const form = input.form ?? input.closest("form");
              if (form !== null) {
                // POST into a hidden frame instead of navigating this one: the
                // gate answers with a redirect that carries the completion code,
                // and the driver reads it off that frame's URL to hand it to the
                // embedding page. Navigating the form frame directly destroys
                // the widget before the handoff can be observed.
                if (submitMode === "top") {
                  // Standalone gate page: navigate the page itself so the
                  // gate's redirect (the completion code) becomes the page URL.
                  form.submit();
                } else {
                  const postFrame = document.createElement("iframe");
                  postFrame.name = "hcaptcha-gate-post";
                  postFrame.style.display = "none";
                  document.body.appendChild(postFrame);
                  form.target = "hcaptcha-gate-post";
                  form.submit();
                }
                formSubmitted = true;
                break;
              }
            }
          } catch {
            // submit is best-effort
          }
        }

        const result = {
          ok: inputs.length > 0 || widgetIds.size > 0 || callbackFired,
          textareas: inputs.length,
          widgets: widgetIds.size,
          callbackFired,
          formSubmitted,
          dataCallbackHosts: (() => {
            try {
              return deepAll("[data-callback]").length;
            } catch {
              return -1;
            }
          })(),
          globalFnMatches: (() => {
            try {
              return Object.getOwnPropertyNames(win).filter(
                (n) =>
                  typeof win[n] === "function" && /complete|success|verify/i.test(n),
              ).length;
            } catch {
              return -1;
            }
          })(),
          hasHcaptchaGlobal: win.hcaptcha !== undefined,
        };
        return result;
  }
}

// True once no vendor challenge frame has been visible for `stableClearMs`
// within `timeoutMs` — a bounded page-shape observation, NOT a solve
// verdict. Introduced in 5a018714 to decide whether a minted hCaptcha
// token had "really" taken (the challenge image should disappear); that
// use was removed in the 2026-09-15 audit wave because it discarded a
// genuinely minted token (measured: `solved: false` after 15.7s with
// `h-captcha-response` populated). Callers today are wait/backoff uses
// (Gmail search retries, consent-banner hydrate retry) plus captchaGate's
// own `settled` verdict; the minted response token is the success signal.
export async function waitForCaptchaChallengeToSettle(
  browser: BrowserController,
  timeoutMs = 4000,
  stableClearMs = 2_500,
  page: Page | null = browser.page,
): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  const hasVisibleChallenge = async (): Promise<boolean> =>
    await page.evaluate(() => {
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
    await browser.sleep(250);
  }
  return false;
}

// 2Captcha solver client — Tier 3 fallback for image-challenge
// reCAPTCHA v2.
//
// The bot's existing captcha handling is two tiers:
//   - Tier 1: behavior simulation (passes invisible reCAPTCHA v3 +
//             Turnstile-invisible — no cost)
//   - Tier 2: click-and-wait for visible checkboxes (passes reCAPTCHA
//             v2 checkbox + Turnstile checkbox — no cost)
//
// This module is Tier 3 — when Tier 2 times out on a reCAPTCHA v2
// image challenge (the "select all crosswalks" kind), submit the
// page's sitekey to 2Captcha's API. They route to a human solver
// (or their own ML), return a token in ~30-90s. We inject the token
// into the hidden `g-recaptcha-response` textarea + fire the
// onSuccess callback that the captcha widget registered.
//
// Cost: ~$0.003 per solve. Reliability: ~95% for vanilla v2 image
// challenge. IP-mismatch concern is theoretical for v2 (the token
// validation API doesn't check solver IP). Doesn't help with
// reCAPTCHA v3 / Enterprise scoring or Cloudflare Turnstile — those
// fail at the scoring layer, not the challenge layer.
//
// Env-gated: TWOCAPTCHA_API_KEY unset → module returns null and the
// existing captcha_blocked classification stands. No code path
// silently turns on a paid service.

const TWOCAPTCHA_BASE = "https://2captcha.com";
const TWOCAPTCHA_API_BASE = "https://api.2captcha.com";

// Per-solve timeouts. The IN call should answer fast (sitekey
// submission is just queued). The RES polling can take 60-120s on
// busy days; we cap at 180s to keep the bot's overall budget bounded.
const IN_TIMEOUT_MS = 10_000;
const RES_POLL_INTERVAL_MS = 5_000;
const RES_TIMEOUT_MS = 180_000;

// A single authenticated 2Captcha request, with the API key NOT yet attached —
// the transport (direct or vault-proxy) injects it. `keyInjection` says where:
// the `key` query param (in.php/res.php) or the `clientKey` JSON field
// (createTask/getTaskResult).
export interface TwoCaptchaVaultRequest {
  url: string;
  method: "GET" | "POST";
  query?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
  keyInjection: { in: "query"; name: string } | { in: "body"; name: string };
}

// The vault-proxy transport. When set, the solver never holds the raw key —
// every 2Captcha call goes through Squire's injecting proxy (use_credential),
// which substitutes the vaulted key server-side. The captcha TOKEN that comes
// back is still injected into the user's real browser session, so this changes
// nothing the target site can fingerprint (reCAPTCHA-v2 tokens aren't IP-bound).
export interface TwoCaptchaVaultProxy {
  request(
    req: TwoCaptchaVaultRequest,
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface TwoCaptchaSolverOpts {
  apiKey?: string;
  // When set, the solver routes every 2Captcha call through this proxy and the
  // raw key never lives in the bot process. Takes precedence over apiKey/env.
  vaultProxy?: TwoCaptchaVaultProxy;
  // Override globalThis.fetch (tests).
  fetchFn?: typeof globalThis.fetch;
  // Override polling sleep (tests).
  sleepFn?: (ms: number) => Promise<void>;
  // Override max polling deadline (tests).
  resTimeoutMs?: number;
  // Hard per-request bound for the calls that don't already carry one (the
  // res/getTaskResult polls). Unset — the provision gate — leaves those polls
  // bounded only by the overall deadline, which a transport that never settles
  // can outlive; a caller that must not hang on one request sets it.
  requestTimeoutMs?: number;
}

export type TwoCaptchaResult =
  | { kind: "ok"; token: string; durationMs: number }
  | { kind: "no_key" }
  | { kind: "submission_failed"; reason: string }
  | { kind: "solve_timeout"; durationMs: number }
  | { kind: "solver_error"; reason: string };

export type TwoCaptchaCoordinatesResult =
  | { kind: "ok"; coordinates: Array<{ x: number; y: number }>; durationMs: number }
  | Exclude<TwoCaptchaResult, { kind: "ok"; token: string; durationMs: number }>;

export class TwoCaptchaSolver {
  private readonly apiKey: string | undefined;
  private readonly vaultProxy: TwoCaptchaVaultProxy | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly resTimeoutMs: number;
  private readonly requestTimeoutMs: number | undefined;

  constructor(opts: TwoCaptchaSolverOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.TWOCAPTCHA_API_KEY;
    this.vaultProxy = opts.vaultProxy;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resTimeoutMs = opts.resTimeoutMs ?? RES_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs;
  }

  isAvailable(): boolean {
    if (this.vaultProxy !== undefined) return true;
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  // One authenticated 2Captcha request. Vault-proxy mode hands it to the proxy
  // (key injected server-side); direct mode inlines the raw key into the query
  // (`key`) or JSON body (`clientKey`) per `keyInjection`. Both return the same
  // {ok,status,json} shape so the callers don't branch on transport.
  private async dispatch(
    req: TwoCaptchaVaultRequest & { timeoutMs?: number },
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    const exec = async (): Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }> => {
      if (this.vaultProxy !== undefined) {
        return this.vaultProxy.request({
          url: req.url,
          method: req.method,
          ...(req.query !== undefined ? { query: req.query } : {}),
          ...(req.jsonBody !== undefined ? { jsonBody: req.jsonBody } : {}),
          keyInjection: req.keyInjection,
        });
      }
      const apiKey = this.apiKey!;
      if (req.keyInjection.in === "query") {
        const u = new URL(req.url);
        for (const [k, v] of Object.entries(req.query ?? {})) u.searchParams.set(k, v);
        u.searchParams.set(req.keyInjection.name, apiKey);
        const r = await this.fetchFn(u.toString(), { method: req.method });
        return { ok: r.ok, status: r.status, json: () => r.json() };
      }
      const body = JSON.stringify({ [req.keyInjection.name]: apiKey, ...(req.jsonBody ?? {}) });
      const r = await this.fetchFn(req.url, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body,
      });
      return { ok: r.ok, status: r.status, json: () => r.json() };
    };
    const timeoutMs = req.timeoutMs ?? this.requestTimeoutMs;
    return timeoutMs !== undefined ? withTimeout(exec(), timeoutMs) : exec();
  }

  /**
   * Submit a reCAPTCHA v2 sitekey + page URL to 2Captcha, poll until
   * a token is returned (or the deadline elapses). Fire-and-forget
   * is wrong here — the caller is gated on the token to inject into
   * the page, so this is await-mandatory.
   */
  async solveRecaptchaV2(input: {
    sitekey: string;
    pageUrl: string;
    // Optional: data-action for reCAPTCHA v2 invisible / v3-styled
    // challenges. 2Captcha returns an action-bound token when set.
    action?: string;
    // Invisible reCAPTCHA uses the same 2Captcha method as v2 checkbox, but
    // the provider needs the invisible flag to solve the right widget mode.
    invisible?: boolean;
  }): Promise<TwoCaptchaResult> {
    return this.submitAndPoll({
      method: "userrecaptcha",
      googlekey: input.sitekey,
      pageurl: input.pageUrl,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.invisible === true ? { invisible: "1" } : {}),
    });
  }

  /**
   * Submit an hCaptcha sitekey + page URL to 2Captcha (method=hcaptcha)
   * and poll for the token. hCaptcha (plausible, several others) is a
   * distinct provider from reCAPTCHA — 2Captcha routes it through a
   * different worker pool and the response token goes into the page's
   * `h-captcha-response` textarea, not `g-recaptcha-response`.
   */
  async solveHcaptcha(input: {
    sitekey: string;
    pageUrl: string;
    invisible?: boolean;
    userAgent?: string;
    data?: string;
  }): Promise<TwoCaptchaResult> {
    return this.submitAndPoll({
      method: "hcaptcha",
      sitekey: input.sitekey,
      pageurl: input.pageUrl,
      ...(input.invisible === true ? { invisible: "1" } : {}),
      ...(input.userAgent !== undefined && input.userAgent.trim().length > 0
        ? { userAgent: input.userAgent }
        : {}),
      ...(input.data !== undefined && input.data.trim().length > 0 ? { data: input.data } : {}),
    });
  }

  /**
   * Submit a Cloudflare Turnstile sitekey + page URL to 2Captcha
   * (method=turnstile) and poll for the token. The returned token goes into
   * the page's `cf-turnstile-response` input + the widget's success callback.
   *
   * Historically NOT wired, on the belief that "Cloudflare IP-scores Turnstile
   * so a solver token is rejected." That belief was FALSIFIED 2026-06-12 (exa
   * fails on a fresh direct residential IP + real GPU — it is NOT IP-bound; see
   * STATE.md), so a 2Captcha token may actually be accepted. Optional
   * `action`/`data` fields carry through for the managed-challenge variants
   * that bind a cData/chlPageData blob.
   */
  async solveTurnstile(input: {
    sitekey: string;
    pageUrl: string;
    action?: string;
    data?: string;
  }): Promise<TwoCaptchaResult> {
    return this.submitAndPoll({
      method: "turnstile",
      sitekey: input.sitekey,
      pageurl: input.pageUrl,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
  }

  async solveCoordinates(input: {
    imageBase64: string;
    comment?: string;
    minClicks?: number;
    maxClicks?: number;
  }): Promise<TwoCaptchaCoordinatesResult> {
    if (!this.isAvailable()) return { kind: "no_key" };
    const startMs = Date.now();

    let taskId: number;
    try {
      const res = await this.dispatch({
        url: `${TWOCAPTCHA_API_BASE}/createTask`,
        method: "POST",
        jsonBody: {
          task: {
            type: "CoordinatesTask",
            body: input.imageBase64,
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
            ...(input.minClicks !== undefined ? { minClicks: input.minClicks } : {}),
            ...(input.maxClicks !== undefined ? { maxClicks: input.maxClicks } : {}),
          },
        },
        keyInjection: { in: "body", name: "clientKey" },
        timeoutMs: IN_TIMEOUT_MS,
      });
      if (!res.ok) return { kind: "submission_failed", reason: `createTask HTTP ${res.status}` };
      const body = (await res.json()) as {
        errorId?: number;
        errorCode?: string;
        errorDescription?: string;
        taskId?: number;
      };
      if (body.errorId !== 0 || typeof body.taskId !== "number") {
        return {
          kind: "submission_failed",
          reason: body.errorCode ?? body.errorDescription ?? "unknown_2captcha_error",
        };
      }
      taskId = body.taskId;
    } catch (err) {
      return {
        kind: "submission_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    while (Date.now() - startMs < this.resTimeoutMs) {
      await this.sleepFn(RES_POLL_INTERVAL_MS);
      try {
        const res = await this.dispatch({
          url: `${TWOCAPTCHA_API_BASE}/getTaskResult`,
          method: "POST",
          jsonBody: { taskId },
          keyInjection: { in: "body", name: "clientKey" },
        });
        if (!res.ok) continue;
        const body = (await res.json()) as {
          errorId?: number;
          errorCode?: string;
          errorDescription?: string;
          status?: string;
          solution?: { coordinates?: Array<{ x?: unknown; y?: unknown }> };
        };
        if (body.errorId !== 0) {
          return {
            kind: "solver_error",
            reason: body.errorCode ?? body.errorDescription ?? "unknown_res_error",
          };
        }
        if (body.status !== "ready") continue;
        const coordinates = (body.solution?.coordinates ?? [])
          .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (coordinates.length === 0) {
          return { kind: "solver_error", reason: "missing_coordinates" };
        }
        return { kind: "ok", coordinates, durationMs: Date.now() - startMs };
      } catch {
        // transient; retry on next tick
      }
    }
    return { kind: "solve_timeout", durationMs: Date.now() - startMs };
  }

  // Shared in.php submit + res.php poll. `params` carries the
  // provider-specific fields (method + sitekey param name); everything
  // else (auth, json, the polling loop, timeouts) is identical across
  // reCAPTCHA and hCaptcha.
  private async submitAndPoll(params: Record<string, string>): Promise<TwoCaptchaResult> {
    if (!this.isAvailable()) return { kind: "no_key" };
    const startMs = Date.now();

    // ── 1. Submit ────────────────────────────────────────────────
    let captchaId: string;
    try {
      const inRes = await this.dispatch({
        url: `${TWOCAPTCHA_BASE}/in.php`,
        method: "POST",
        query: { ...params, json: "1" },
        keyInjection: { in: "query", name: "key" },
        timeoutMs: IN_TIMEOUT_MS,
      });
      if (!inRes.ok) {
        return {
          kind: "submission_failed",
          reason: `in.php HTTP ${inRes.status}`,
        };
      }
      const body = (await inRes.json()) as { status: number; request: string };
      if (body.status !== 1) {
        // 2Captcha returns status=0 with a textual error code like
        // "ERROR_KEY_DOES_NOT_EXIST" / "ERROR_NO_SLOT_AVAILABLE".
        return {
          kind: "submission_failed",
          reason: body.request ?? "unknown_2captcha_error",
        };
      }
      captchaId = body.request;
    } catch (err) {
      return {
        kind: "submission_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    // ── 2. Poll for the token ────────────────────────────────────
    while (Date.now() - startMs < this.resTimeoutMs) {
      await this.sleepFn(RES_POLL_INTERVAL_MS);
      try {
        const resRes = await this.dispatch({
          url: `${TWOCAPTCHA_BASE}/res.php`,
          method: "GET",
          query: { action: "get", id: captchaId, json: "1" },
          keyInjection: { in: "query", name: "key" },
        });
        if (!resRes.ok) continue; // transient — retry on next tick
        const body = (await resRes.json()) as { status: number; request: string };
        if (body.status === 1) {
          return {
            kind: "ok",
            token: body.request,
            durationMs: Date.now() - startMs,
          };
        }
        // status=0 with request="CAPCHA_NOT_READY" means keep polling.
        // Any other status=0 request is a hard error (worker
        // unavailable, sitekey rejected, etc.).
        if (body.request === "CAPCHA_NOT_READY") continue;
        return {
          kind: "solver_error",
          reason: body.request ?? "unknown_res_error",
        };
      } catch {
        // Transient network error — retry on next tick.
      }
    }
    return { kind: "solve_timeout", durationMs: Date.now() - startMs };
  }
}

// Race a promise against a hard timeout. 2Captcha's in.php should
// answer in <2s; a 10s cap is generous.
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
