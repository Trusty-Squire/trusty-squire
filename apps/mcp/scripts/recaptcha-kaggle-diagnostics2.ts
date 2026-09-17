/**
 * MANUAL LIVE DIAGNOSTICS — phase 2. Throwaway, not a test. Never completes a
 * signup.
 *
 * Questions phase 1 left open (fm/ts-recaptcha-checkbox-not-activatable):
 *   1. What does detectCaptchaVariant report on the BARE Kaggle checkbox
 *      (bframe pre-positioned offscreen at y=-9999)? visible() only checks
 *      size, not position — does a mere checkbox already read as
 *      challengeRendered=true?
 *   2. Can the checkbox be toggled at all from this environment, and by which
 *      primitive: locator click inside the anchor frame, coordinate click,
 *      keyboard Space on the focused anchor?
 *
 * Run:  cd apps/mcp && xvfb-run -a node_modules/.bin/tsx scripts/recaptcha-kaggle-diagnostics2.ts
 */
/* eslint-disable no-console -- manual diagnostics printer */
import { chromium } from "playwright";
import type { Page } from "playwright";
import { BrowserController } from "../src/bot/browser.js";
import { detectCaptchaVariant } from "../src/bot/captcha.js";

const SIGNUP_URL =
  process.env.KAGGLE_SIGNUP_URL ?? "https://www.kaggle.com/account/login?phase=emailRegister";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function anchorState(page: Page, label: string): Promise<void> {
  const states: Array<Record<string, unknown>> = [];
  for (const f of page.frames()) {
    if (!f.url().includes("/recaptcha/api2/anchor")) continue;
    const s = await f
      .evaluate(() => {
        const anchor = document.getElementById("recaptcha-anchor");
        if (anchor === null) return { anchor: false };
        const cb = document.querySelector(".recaptcha-checkbox");
        const spinner = document.querySelector(".recaptcha-checkbox-spinner");
        return {
          anchor: true,
          checked: anchor.getAttribute("aria-checked"),
          cbCls: cb?.className.toString().slice(0, 90) ?? null,
          spinnerAnim: spinner ? getComputedStyle(spinner).animationName : null,
        };
      })
      .catch((e) => ({ error: String(e).slice(0, 90) }));
    states.push({ frame: f.url().slice(0, 50), ...s });
  }
  const bframe = await page.evaluate(() => {
    const f = document.querySelector('iframe[src*="recaptcha/api2/bframe"]');
    if (f === null) return { bframe: "absent" };
    const r = f.getBoundingClientRect();
    return {
      bframe: { x: r.x, y: r.y, w: r.width, h: r.height, title: (f as HTMLIFrameElement).title },
    };
  });
  console.log(`[${label}]`, JSON.stringify({ anchors: states, ...bframe }));
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript({
    content: "window.__name = window.__name || function(f){return f;};",
  });

  await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page
    .waitForSelector('iframe[src*="recaptcha/api2/anchor"]', { timeout: 15_000 })
    .catch(() => null);
  await sleep(2_000);

  const controller = BrowserController.fromHarnessPage(page);

  console.log("=== 1. detectCaptchaVariant on the BARE checkbox ===");
  const det = await detectCaptchaVariant(controller, page);
  console.log(JSON.stringify(det));

  await anchorState(page, "before");

  console.log("=== 2a. locator click on #recaptcha-anchor inside the anchor frame ===");
  const anchorFrame = page.frames().find((f) => f.url().includes("/recaptcha/api2/anchor"));
  if (anchorFrame !== undefined) {
    try {
      await anchorFrame.locator("#recaptcha-anchor").click({ timeout: 5_000, force: false });
      console.log("    locator click OK");
    } catch (e) {
      console.log(`    locator click FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(4_000);
    await anchorState(page, "after locator click");
    const det2 = await detectCaptchaVariant(controller, page);
    console.log("    detect after:", JSON.stringify(det2));
  }

  if (anchorState !== undefined) {
    console.log("=== 2b. coordinate click (fresh geometry, humanized-ish move) ===");
    const box = await page.evaluate(() => {
      const f = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
      if (f === null) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    console.log("    box:", JSON.stringify(box));
    if (box !== null) {
      await page.mouse.move(box.x + 28, box.y + box.h / 2, { steps: 12 });
      await sleep(300);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(4_000);
      await anchorState(page, "after coordinate click");
    }

    console.log("=== 2c. keyboard: focus anchor, Space ===");
    if (anchorFrame !== undefined) {
      try {
        await anchorFrame.locator("#recaptcha-anchor").focus();
        // Manual diagnostics record: on the live page this dispatch attempt
        // failed (Frame exposes no keyboard; preserved via the assertion so
        // the run still reports the keyboard FAILED outcome it observed).
        await (anchorFrame as unknown as Page).keyboard.press("Space");
        await sleep(4_000);
        await anchorState(page, "after Space");
      } catch (e) {
        console.log(`    keyboard FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  await page.screenshot({ path: "/tmp/kaggle-recaptcha-phase2.png" });
  console.log("=== done ===");
  await sleep(2_000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
