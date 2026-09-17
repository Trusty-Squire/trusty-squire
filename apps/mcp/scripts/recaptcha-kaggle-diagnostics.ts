/**
 * MANUAL LIVE DIAGNOSTICS — throwaway, not a test. Never completes a signup.
 *
 * Reproduces the Kaggle email-signup reCAPTCHA v2 checkbox failure
 * (fm/ts-recaptcha-checkbox-not-activatable) against the real page with plain
 * Playwright Chrome (no operator, no vault). It opens the signup form, waits
 * for the recaptcha anchor frame, then prints:
 *
 *   1. page.frames() URLs + which count as captcha frames
 *   2. the main-document widget host area (g-recaptcha div / anchor iframe
 *      geometry)
 *   3. the real observation inventory: which elements the operator's own
 *      extractInteractiveElements + captureBrowserUseDOM surface near the
 *      widget (checkbox text, iframe rows), with their generated selectors
 *   4. anchor-node stability: a marker attribute is written onto the anchor
 *      <iframe> and re-read after the observe → act gap, so a re-render that
 *      replaces the node is measured, not guessed
 *   5. the operator's own click path (BrowserController.click with the
 *      act-shaped DriverTarget) on the surfaced element — raw return either
 *      side
 *   6. as a control, the Tier-2 coordinate click (solveVisibleCaptcha's
 *      primitive) and the anchor frame's aria-checked state afterwards
 *
 * Run:  cd apps/mcp && xvfb-run -a node_modules/.bin/tsx scripts/recaptcha-kaggle-diagnostics.ts
 */
/* eslint-disable no-console -- manual diagnostics printer */
import { chromium } from "playwright";
import type { Page } from "playwright";
import { BrowserController } from "../src/bot/browser.js";
import { isCaptchaFrameUrl } from "../src/bot/captcha.js";

const SIGNUP_URL =
  process.env.KAGGLE_SIGNUP_URL ?? "https://www.kaggle.com/account/login?phase=emailRegister";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dumpFrames(page: Page, label: string): Promise<void> {
  console.log(`=== frames (${label}) ===`);
  for (const f of page.frames()) {
    console.log(
      `  main=${f === page.mainFrame()} captcha=${isCaptchaFrameUrl(f.url())} detached=${f.isDetached()} url=${JSON.stringify(f.url().slice(0, 110))}`,
    );
  }
}

async function widgetArea(page: Page): Promise<void> {
  console.log("=== main-document widget host area ===");
  const info = await page
    .evaluate(() => {
      const out: Array<Record<string, unknown>> = [];
      const hosts = document.querySelectorAll(
        ".g-recaptcha, [data-sitekey], iframe[src*='recaptcha']",
      );
      for (const el of Array.from(hosts)) {
        const r = el.getBoundingClientRect();
        out.push({
          tag: el.tagName,
          cls: el.className.toString().slice(0, 60),
          src: el instanceof HTMLIFrameElement ? el.src.slice(0, 110) : null,
          sitekey: el.getAttribute("data-sitekey") ? "present" : null,
          box: { x: r.x, y: r.y, w: r.width, h: r.height },
          connected: el.isConnected,
        });
      }
      return out;
    })
    .catch((e) => [{ error: String(e) }]);
  for (const row of info) console.log("  ", JSON.stringify(row));
}

async function anchorState(page: Page, label: string): Promise<void> {
  const state = await page
    .frames()
    .filter((f) => f.url().includes("/recaptcha/api2/anchor"))
    .reduce(
      async (acc, f) => {
        const s = await f
          .evaluate(() => {
            const anchor = document.getElementById("recaptcha-anchor");
            if (anchor === null) return { anchor: false };
            return {
              anchor: true,
              checked: anchor.getAttribute("aria-checked"),
              label: anchor.getAttribute("aria-label")?.slice(0, 60) ?? null,
            };
          })
          .catch((e) => ({ error: String(e).slice(0, 80) }));
        return Promise.resolve([...(await acc), { frame: f.url().slice(0, 60), ...s }]);
      },
      Promise.resolve([] as Array<Record<string, unknown>>),
    );
  console.log(`=== anchor state (${label}) ===`);
  for (const row of state) console.log("  ", JSON.stringify(row));
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // tsx/esbuild keepNames shim — page.evaluate callbacks must be self-contained
  // (repo rule); the shim keeps elementHandle.evaluate from failing under tsx.
  await page.addInitScript({
    content: "window.__name = window.__name || function(f){return f;};",
  });

  console.log(`goto ${SIGNUP_URL}`);
  await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Wait for the anchor iframe the way the operator's settle does.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page
    .waitForSelector('iframe[src*="recaptcha/api2/anchor"]', { timeout: 15_000 })
    .catch(() => null);
  await sleep(2_000);

  await dumpFrames(page, "after load");
  await widgetArea(page);

  const controller = BrowserController.fromHarnessPage(page);

  console.log("=== 3. operator observation inventory (widget-adjacent rows) ===");
  const capture = await controller.extractBrowserUseObservation(page, true);
  for (const el of capture.elements) {
    const hay =
      `${el.tag} ${el.ariaLabel ?? ""} ${el.labelText ?? ""} ${el.visibleText ?? ""} ${el.selector} ${el.frameOrigin ?? ""}`.toLowerCase();
    if (
      hay.includes("recaptcha") ||
      hay.includes("robot") ||
      hay.includes("captcha") ||
      hay.includes("iframe")
    ) {
      console.log(
        "  ",
        JSON.stringify({
          i: el.index,
          tag: el.tag,
          role: el.role,
          aria: el.ariaLabel,
          text: (el.visibleText ?? "").slice(0, 40),
          sel: el.selector.slice(0, 110),
          frameOrigin: el.frameOrigin ?? null,
          framePath: el.framePath ?? null,
          visible: el.visible,
        }),
      );
    }
  }

  // Pick the observation row for the checkbox (or the anchor iframe row).
  const candidates = capture.elements.filter((el) => {
    const hay =
      `${el.ariaLabel ?? ""} ${el.labelText ?? ""} ${el.visibleText ?? ""} ${el.selector}`.toLowerCase();
    return hay.includes("recaptcha") || hay.includes("robot");
  });
  console.log(
    `=== 4. widget-related observation rows: ${candidates.map((c) => c.index).join(",") || "NONE"}`,
  );

  // Anchor-node stability across an observe→act-shaped gap.
  const marker = "data-ts-diag-marker";
  const marked = await page
    .evaluate((m) => {
      const f = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
      if (f === null) return "no-anchor";
      f.setAttribute(m, "1");
      return "marked";
    }, marker)
    .catch((e) => String(e));
  console.log(`=== 5. anchor marker: ${marked}`);
  // An act-shaped gap: fresh observation, then the click below.
  const capture2 = await controller.extractBrowserUseObservation(page, true);
  const markerSurvived = await page
    .evaluate((m) => document.querySelector(`iframe[${m}]`) !== null, marker)
    .catch(() => "eval-failed");
  console.log(
    `    marker after fresh observe: ${markerSurvived} (rows2=${capture2.elements.length})`,
  );

  await anchorState(page, "before click");

  // 6. The operator's own click path on the surfaced row, exactly the way the
  // act drive shapes it (frame target when the row lives in a frame, else
  // selector).
  for (const el of candidates) {
    const framePart =
      el.framePath !== undefined
        ? {
            kind: "frame" as const,
            frame: {
              framePath: el.framePath,
              frameOrigin: el.frameOrigin ?? "",
              frameUrl: el.frameUrl ?? "",
            },
          }
        : {};
    const target =
      el.framePath !== undefined
        ? {
            kind: "frame" as const,
            frame: {
              framePath: el.framePath,
              frameOrigin: el.frameOrigin ?? "",
              frameUrl: el.frameUrl ?? "",
            },
            selector: el.selector,
          }
        : { kind: "selector" as const, selector: el.selector };
    console.log(`--- operate-shaped click on row ${el.index} sel=${el.selector.slice(0, 90)}`);
    try {
      await controller.click(
        { ...target, method: "click" } as Parameters<BrowserController["click"]>[0],
        page,
      );
      console.log(`    click returned OK on row ${el.index}`);
    } catch (error) {
      console.log(
        `    click FAILED on row ${el.index}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
    void framePart;
    await anchorState(page, `after click row ${el.index}`);
  }

  if (candidates.length === 0) {
    // Nothing surfaced: try the documented raw approach — resolve the anchor
    // iframe in the main document and click it as an element.
    console.log("--- fallback: main-document click on iframe[src*=anchor]");
    try {
      await controller.click(
        { kind: "selector", selector: 'iframe[src*="recaptcha/api2/anchor"]', method: "click" },
        page,
      );
      console.log("    click returned OK");
    } catch (error) {
      console.log(
        `    click FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
    await anchorState(page, "after iframe click");
  }

  // 7. Control: Tier-2 coordinate click primitive.
  console.log("=== 6. control: coordinate click into the anchor iframe ===");
  const box = await page
    .evaluate(() => {
      const f = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
      if (f === null) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })
    .catch(() => null);
  if (box !== null) {
    console.log("  ", JSON.stringify(box));
    await page.mouse.click(box.x + 28, box.y + box.h / 2);
    await sleep(4_000);
    await anchorState(page, "after coordinate click");
    await dumpFrames(page, "after coordinate click");
  }

  console.log("=== done (not closing browser for 3s) ===");
  await sleep(3_000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
