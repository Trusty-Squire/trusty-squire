/**
 * MANUAL LIVE VERIFICATION — phase 3 (post-fix). Throwaway, not a test. Never
 * completes a signup.
 *
 * Drives the FIXED operator click path end-to-end on real Kaggle:
 *   1. detectCaptchaVariant on the bare checkbox (must NOT read as a rendered
 *      challenge — offscreen bframe).
 *   2. extractBrowserUseObservation → the surfaced anchor-frame row.
 *   3. controller.click({kind:"frame", ...}) — the exact path that died as
 *      "click target detached before dispatch" pre-fix.
 *   4. detectCaptchaVariant after the click (challenge must render → true).
 *
 * Run:  cd apps/mcp && xvfb-run -a node_modules/.bin/tsx scripts/recaptcha-kaggle-verify.ts
 */
/* eslint-disable no-console -- manual verification printer */
import { chromium } from "playwright";
import { BrowserController } from "../src/bot/browser.js";
import { detectCaptchaVariant } from "../src/bot/captcha.js";

const SIGNUP_URL =
  process.env.KAGGLE_SIGNUP_URL ?? "https://www.kaggle.com/account/login?phase=emailRegister";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  console.log("=== 1. detectCaptchaVariant on the BARE checkbox (fixed detection) ===");
  const before = await detectCaptchaVariant(controller, page);
  console.log(JSON.stringify(before));

  console.log("=== 2. observation rows in the anchor frame ===");
  const capture = await controller.extractBrowserUseObservation(page, true);
  const rows = capture.elements.filter(
    (el) => el.frameOrigin != null && el.frameOrigin.includes("google"),
  );
  console.log(JSON.stringify(rows.map((el) => ({ ...el, ariaLabel: el.ariaLabel }))));

  const row =
    rows.find((el) => el.id === "recaptcha-anchor") ??
    rows.find((el) => el.role === "checkbox") ??
    rows[0];
  if (row === undefined) throw new Error("no anchor-frame row surfaced");

  console.log("=== 3. operator click on the surfaced row (fixed path) ===");
  await controller.click({
    kind: "frame",
    frame: {
      framePath: row.framePath!,
      frameOrigin: row.frameOrigin!,
      frameUrl: row.frameUrl ?? "",
    },
    selector: row.selector,
    method: "click",
  });
  console.log("click dispatched without error");

  await sleep(5_000);
  console.log("=== 4. detectCaptchaVariant after the click ===");
  const after = await detectCaptchaVariant(controller, page);
  console.log(JSON.stringify(after));

  const bframeBox = await page.evaluate(() => {
    const f = document.querySelector('iframe[src*="recaptcha/api2/bframe"]');
    if (f === null) return { bframe: "absent" };
    const r = f.getBoundingClientRect();
    return { bframe: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
  console.log(JSON.stringify(bframeBox));
  await page.screenshot({ path: "/tmp/kaggle-recaptcha-phase3.png" });

  console.log("=== done ===");
  await sleep(3_000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
