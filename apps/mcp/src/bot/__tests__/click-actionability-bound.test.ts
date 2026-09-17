import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import {
  finishProvisionSession,
  startHarnessProvisionSession,
} from "../provision-session.js";
import {
  operateClickTool,
  provisionObserveTool,
} from "../../tools/provision-drive.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

describe("operate_click actionability bound on an occluded submit", () => {
  it("resolves a transparent-overlay-covered submit far inside the old 30s default burn", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = "https://occluded-submit.test/";
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
      <main><button onclick="document.querySelector('output').textContent=String(++window.clicks)">Submit</button></main>
      <div style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:50;background:transparent"></div>
      <output>0</output><script>window.clicks=0</script>`,
      }),
    );
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
    });
    try {
      await provisionObserveTool.handler({ session_id: started.session_id }, null);
      const rows = (started as unknown as { safe_table: string[][] }).safe_table;
      const ref = rows.find((row) => row[2]?.split("|")[0] === "@submit")![0]!;
      const startedAt = Date.now();
      const observed = await operateClickTool.handler(
        { session_id: started.session_id, ref },
        null,
      );
      const elapsed = Date.now() - startedAt;
      // The plain click burns its bounded actionability wait, then the proven
      // not-dispatched evidence routes the tool into the guarded DOM dispatch,
      // which lands. The unbounded predecessor waited out the Playwright 30s
      // default here (~31s measured) before the same fallback ran.
      expect(elapsed).toBeLessThan(20_000);
      expect(observed).toHaveProperty("session_id", started.session_id);
      expect(await page.locator("output").textContent()).toBe("1");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("still lands a slow success whose cover clears at 3s", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = "https://slow-cover-submit.test/";
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
      <main><button onclick="document.querySelector('output').textContent=String(++window.clicks)">Submit</button></main>
      <div id="cover" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:50;background:transparent"></div>
      <output>0</output>
      <script>
        window.clicks = 0;
        setTimeout(() => document.getElementById('cover').remove(), 3000);
      </script>`,
      }),
    );
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
    });
    try {
      await provisionObserveTool.handler({ session_id: started.session_id }, null);
      const rows = (started as unknown as { safe_table: string[][] }).safe_table;
      const ref = rows.find((row) => row[2]?.split("|")[0] === "@submit")![0]!;
      const startedAt = Date.now();
      const observed = await operateClickTool.handler(
        { session_id: started.session_id, ref },
        null,
      );
      const elapsed = Date.now() - startedAt;
      // The 8s bound must not convert a slow-but-real click into a failure:
      // the cover clears inside the bound and the plain click dispatches.
      expect(elapsed).toBeLessThan(15_000);
      expect(observed).toHaveProperty("session_id", started.session_id);
      expect(await page.locator("output").textContent()).toBe("1");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});
