// `g-recaptcha-response` is hCaptcha's drop-in compatibility field. Filling it
// is correct when hCaptcha REPLACED reCAPTCHA (the field is the site's only
// response input, left empty by a library that never runs), and destructive
// when the two are CO-RESIDENT: there it already holds a live reCAPTCHA score
// token, and overwriting it with an hCaptcha token makes the site submit a
// response Google's siteverify rejects — a silent signup failure, because the
// hCaptcha field IS populated so every later check reads "solved".
//
// Synthetic fixtures only; no network, no credentials.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";
import { injectHcaptchaToken } from "../captcha.js";

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

const valueOf = (page: Page, selector: string): Promise<string> =>
  page.$eval(selector, (el) => (el as HTMLTextAreaElement).value);

describe("injectHcaptchaToken and a co-resident reCAPTCHA response field", () => {
  it("leaves a reCAPTCHA response token that is already present alone", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div class="h-captcha" data-sitekey="00000000-0000-0000-0000-000000000000"></div>
        <textarea name="h-captcha-response"></textarea>
        <textarea name="g-recaptcha-response">v3-score-token</textarea>
      `),
    );
    try {
      expect(await injectHcaptchaToken(ctrl, "bought-hcaptcha-token", page)).toBe(true);

      expect(await valueOf(page, 'textarea[name="h-captcha-response"]')).toBe(
        "bought-hcaptcha-token",
      );
      expect(await valueOf(page, 'textarea[name="g-recaptcha-response"]')).toBe("v3-score-token");
    } finally {
      await page.close();
    }
  });

  it("still fills an EMPTY reCAPTCHA response field, the drop-in compat case", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div class="h-captcha" data-sitekey="00000000-0000-0000-0000-000000000000"></div>
        <textarea name="g-recaptcha-response"></textarea>
      `),
    );
    try {
      expect(await injectHcaptchaToken(ctrl, "bought-hcaptcha-token", page)).toBe(true);

      expect(await valueOf(page, 'textarea[name="g-recaptcha-response"]')).toBe(
        "bought-hcaptcha-token",
      );
    } finally {
      await page.close();
    }
  });
});
