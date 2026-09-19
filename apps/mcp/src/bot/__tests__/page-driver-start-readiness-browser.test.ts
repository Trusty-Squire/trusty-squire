import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { PageDriver } from "../page-driver.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

it("waits for the deferred Save handler without waiting for images", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let releaseImage!: () => void;
  const imagePending = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  let imageRequested = false;
  await page.route("https://readiness.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/handler.js") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({
        contentType: "application/javascript",
        body: `document.querySelector('button').addEventListener('click', () => {
          document.querySelector('output').textContent = 'Saved';
        });`,
      });
    } else if (path === "/slow-image") {
      imageRequested = true;
      await imagePending;
      await route.abort();
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: `<script defer src="/handler.js"></script>
          <button>Save</button><output>Unsaved</output><img src="/slow-image">`,
      });
    }
  });
  try {
    const driver = new PageDriver(() => context, true);
    await driver.goto("https://readiness.test/", page, "document-ready");
    await page.getByRole("button", { name: "Save" }).click();
    expect(await page.locator("output").textContent()).toBe("Saved");
    expect(imageRequested).toBe(true);
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
  } finally {
    releaseImage();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
    } finally {
      await context.close();
    }
  }
}, 10_000);
