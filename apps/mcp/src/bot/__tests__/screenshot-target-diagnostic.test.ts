import { chromium } from "playwright";
import { expect, it } from "vitest";
import { BrowserController } from "../browser.js";
it("compares open framed control and closed-shadow control without provider access", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/frame")
          ? "<label><input type=checkbox>Verify open</label>"
          : '<iframe src="/frame"></iframe><div id="host"></div>',
      }),
    );
    await page.goto("http://fixture.test/");
    await page.evaluate(() => {
      const root = document.querySelector("#host")!.attachShadow({ mode: "closed" });
      root.innerHTML = '<label><input type="checkbox">Verify closed</label>';
    });
    const controller = BrowserController.fromHarnessPage(page);
    const observation = await controller.extractBrowserUseObservation();
    expect(
      observation.elements.some((el) =>
        `${el.labelText} ${el.visibleText}`.includes("Verify open"),
      ),
    ).toBe(true);
    expect(
      observation.elements.some((el) =>
        `${el.labelText} ${el.visibleText}`.includes("Verify closed"),
      ),
    ).toBe(false);
    const frame = page.frames()[1]!;
    await frame.getByRole("checkbox").click();
    expect(await frame.getByRole("checkbox").isChecked()).toBe(true);
    expect(await page.getByRole("checkbox").count()).toBe(0);
    const box = await page.locator("#host").boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const node = await cdp.send("DOM.getNodeForLocation", {
      x: Math.round(box!.x + 12),
      y: Math.round(box!.y + 10),
      includeUserAgentShadowDOM: true,
    });
    const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId!,
      functionDeclaration: "function(){ return this.outerHTML; }",
      returnByValue: true,
    });
    expect(result.result.value).toContain("checkbox");
    await cdp.detach();
  } finally {
    await browser.close();
  }
});
