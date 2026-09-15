// The minted response token is the captcha solve success signal.
//
// 5a018714 added an hCaptcha-only post-token branch to `solveVisibleCaptcha`:
// after the response token appeared it additionally required the challenge
// iframe to stay invisible for 10 continuous seconds and otherwise returned
// `solved: false`. Measured live (real Chromium, data: fixtures): an hCaptcha
// page whose `h-captcha-response` is minted but whose challenge iframe is
// still rendered returned `solved: false` after 15.7s; a page where the frame
// did clear still spent 10.6s. The branch is gone; the token decides.
//
// `waitForCaptchaChallengeToSettle` itself is untouched and still reports
// page shape — it is a wait/backoff primitive for other callers, not a solve
// verdict (see its comment in browser.ts).
//
// Synthetic fixtures only; no network, no credentials.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";

let browser: Browser;

const dataUrl = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url);
  const ctrl = new BrowserController({ humanize: false });
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser.close();
});

// The hCaptcha widget iframe (what `findCaptchaWidget` keys on), a minted
// response token, and a challenge iframe that NEVER clears — the shape the
// removed branch called "not solved" even though the token was present.
const HCAPTCHA_TOKEN_WITH_LINGERING_CHALLENGE = dataUrl(`
  <iframe src="https://hcaptcha.com/frame=checkbox" style="width:300px;height:65px;border:0"></iframe>
  <iframe src="https://newassets.hcaptcha.com/frame=challenge" style="width:300px;height:250px;border:0"></iframe>
  <textarea name="h-captcha-response" style="width:300px;height:40px">P0_eyJhbGciOiJIUzI1NiJ9.MINTED_TOKEN</textarea>`);

const TURNSTILE_TOKEN = dataUrl(`
  <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js" style="width:300px;height:65px;border:0"></iframe>
  <input name="cf-turnstile-response" value="0.MINTED_TURNSTILE_TOKEN" />`);

describe("solveVisibleCaptcha — the response token is the solve signal", () => {
  it("reports solved for a minted hCaptcha token even while the challenge iframe is rendered", async () => {
    const { ctrl, page } = await pageFor(HCAPTCHA_TOKEN_WITH_LINGERING_CHALLENGE);
    try {
      const t0 = Date.now();
      const result = await ctrl.solveVisibleCaptcha(25_000, page);
      expect(result).toEqual({ found: true, solved: true, kind: "hcaptcha" });
      // The removed branch burned its full 15s budget here; the token check
      // is a single 500ms poll.
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(await ctrl.waitForCaptchaResponseToken(750, page)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reports solved for a minted Turnstile token (control — never had the branch)", async () => {
    const { ctrl, page } = await pageFor(TURNSTILE_TOKEN);
    try {
      const result = await ctrl.solveVisibleCaptcha(25_000, page);
      expect(result).toEqual({ found: true, solved: true, kind: "turnstile" });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("keeps the settle predicate as a page-shape observation, not a solve verdict", async () => {
    const { ctrl, page } = await pageFor(HCAPTCHA_TOKEN_WITH_LINGERING_CHALLENGE);
    try {
      // Token present, challenge frame visible → the predicate still says
      // "not settled". It is the callers' business, not solveVisibleCaptcha's.
      expect(await ctrl.waitForCaptchaChallengeToSettle(1500, 250, page)).toBe(false);
      expect(await ctrl.waitForCaptchaResponseToken(750, page)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
