// Throwaway: capture rebrand screenshots for the /design-review visual
// pass. The gstack `browse` tool's Chromium can't launch in this
// sandbox-restricted env; this drives Playwright directly with
// --no-sandbox (the same arg the mcp bot uses successfully here).
// Deleted after the review.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "/tmp/dr";
const BASE = "http://localhost:3002";
const PAGES: [string, string][] = [
  ["landing", "/"],
  ["login", "/login"],
  ["signup", "/signup"],
  ["signup-connect", "/signup/connect"],
  ["policy", "/policy"],
  ["dashboard", "/dashboard"],
];

async function shoot(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ["--no-sandbox"],
    chromiumSandbox: false,
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const [name, path] of PAGES) {
    try {
      await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 12000 });
    } catch {
      // networkidle may never settle (the dashboard polls a down API) —
      // the DOM is painted regardless; fall through to the screenshot.
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    console.warn("shot", name);
  }
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const m = await mctx.newPage();
  for (const [name, path] of [
    ["landing", "/"],
    ["signup-connect", "/signup/connect"],
  ] as [string, string][]) {
    try {
      await m.goto(BASE + path, { waitUntil: "networkidle", timeout: 12000 });
    } catch {
      // see above
    }
    await m.waitForTimeout(1200);
    await m.screenshot({ path: `${OUT}/${name}-mobile.png`, fullPage: true });
    console.warn("shot", name, "mobile");
  }
  await browser.close();
}

shoot().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
