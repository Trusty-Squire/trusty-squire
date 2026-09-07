import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { operateClickTool, provisionObserveTool } from "../../tools/provision-drive.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

describe("operate_click internal fallback with a real browser", () => {
  it("clicks an intercepted control exactly once in legacy mode", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(1000);
    const url = "https://click-fallback.test/";
    await page.route(url, async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
      <button id="continue" style="position:absolute;left:20px;top:20px;width:150px;height:50px"
        onclick="document.querySelector('output').textContent=String(++window.clicks)">Continue</button>
      <div style="position:absolute;left:20px;top:20px;width:150px;height:50px;z-index:10">Overlay</div>
      <output>0</output><script>window.clicks=0</script>`,
      }),
    );
    await page.goto(url);
    const controller = BrowserController.fromHarnessPage(page);
    const plainClick = vi.spyOn(controller, "click");
    const domClick = vi.spyOn(controller, "clickViaJs");
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: url,
    });
    try {
      await provisionObserveTool.handler({ session_id: started.session_id }, null);
      await operateClickTool.handler({ session_id: started.session_id, ref: "Continue" }, null);
      expect(plainClick).toHaveBeenCalledOnce();
      await expect(plainClick.mock.results[0]!.value).rejects.toThrow("intercepts pointer events");
      expect(domClick).toHaveBeenCalledOnce();
      expect(await page.locator("output").textContent()).toBe("1");
      expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});
