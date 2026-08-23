// operate_screenshot's implementation: BrowserController.screenshotForOperator
// (page/frame capture) plus its money-fence redaction — capture-time Playwright
// mask locators (collectOperatorScreenshotMask), never a style/attribute write
// into the live checkout DOM. Real-Chromium, mirroring browser-payment.test.ts's
// harness pattern — a screenshot is inherently about actual rendering, not
// something a mocked page can meaningfully stand in for.
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";

let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

function isValidJpegBase64(base64: string): boolean {
  const buffer = Buffer.from(base64, "base64");
  // JPEG SOI marker.
  return buffer.length > 100 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

describe("operate_screenshot money-fence redaction (real browser)", () => {
  it.skipIf(!chromiumAvailable)(
    "redacts a filled card PAN/expiry/CVV/name at capture time without mutating the DOM",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <input autocomplete="cc-number" value="4242424242424242" style="border:1px solid red">
          <input autocomplete="cc-name" value="Synthetic Cardholder">
          <input autocomplete="cc-exp" placeholder="MM/YY" value="12/30">
          <input autocomplete="cc-csc" value="123">
          <input type="text" value="not a card field">
        `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();

        expect(result.redactedCount).toBe(4);
        expect(isValidJpegBase64(result.base64)).toBe(true);
        expect(result.frameUrl).toBeNull();

        // The mask is painted into the image by Playwright's capture
        // machinery — the live DOM keeps its exact pre-capture state: no
        // marker attributes, and the ONE field with a pre-existing inline
        // style still has it byte-for-byte.
        const panStyle = await page.locator('[autocomplete="cc-number"]').getAttribute("style");
        expect(panStyle).toBe("border:1px solid red");
        const nameStyle = await page.locator('[autocomplete="cc-name"]').getAttribute("style");
        expect(nameStyle).toBeNull();
        const redactedMarkerCount = await page.locator("[data-ts-screenshot-redacted]").count();
        expect(redactedMarkerCount).toBe(0);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "redacts a password field and a non-input element sealed via data-ts-sealed-payment",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <input type="password" value="hunter2">
          <div data-ts-sealed-payment="1">4242 4242 4242 4242</div>
        `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();
        expect(result.redactedCount).toBe(2);

        // No style ever written into the page — masking is capture-side only.
        const divStyle = await page
          .locator('div[data-ts-sealed-payment="1"]')
          .getAttribute("style");
        expect(divStyle).toBeNull();
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("redacts a sealed field inside an open shadow root", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div id="host"></div>`);
      await page.evaluate(() => {
        const host = document.querySelector("#host")!;
        const shadow = host.attachShadow({ mode: "open" });
        const input = document.createElement("input");
        input.setAttribute("autocomplete", "cc-number");
        input.value = "4242424242424242";
        shadow.append(input);
      });
      const controller = BrowserController.fromHarnessPage(page);

      const result = await controller.screenshotForOperator();
      expect(result.redactedCount).toBe(1);
      expect(isValidJpegBase64(result.base64)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "includes session-supplied extra redaction selectors in the mask set",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <input id="otp-field" type="text" value="123456">
          <input type="text" value="not sealed">
        `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator({
          extraRedactionSelectors: ["#otp-field"],
        });
        expect(result.redactedCount).toBe(1);
        expect(isValidJpegBase64(result.base64)).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fails closed — an unqueryable redaction selector aborts the capture entirely",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<input autocomplete="cc-number" value="4242424242424242">`);
        const controller = BrowserController.fromHarnessPage(page);

        await expect(
          controller.screenshotForOperator({ extraRedactionSelectors: ["#not[a(valid"] }),
        ).rejects.toThrow("screenshot_redaction_unresolved");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "captures with no redaction when no card/sealed fields exist",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<h1>Nothing sensitive here</h1>");
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();
        expect(result.redactedCount).toBe(0);
        expect(isValidJpegBase64(result.base64)).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "full_page passes through without redacting anything extra",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
        <div style="height:3000px">tall page</div>
        <input autocomplete="cc-number" value="4242424242424242">
      `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator({ fullPage: true });
        expect(result.redactedCount).toBe(1);
        expect(isValidJpegBase64(result.base64)).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );
});

describe("operate_screenshot frame targeting (real browser)", () => {
  async function servePages(browser: Browser, pages: Record<string, string>): Promise<Page> {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      const body = pages[url];
      if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ contentType: "text/html", body });
    });
    return page;
  }

  it.skipIf(!chromiumAvailable)(
    "captures ONE cross-origin frame by index, redacting only that frame's card fields",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const frameUrl = "https://checkout.pci.shopifyinc.com/card-fields";
        const page = await servePages(browser, {
          [pageUrl]: `
            <input autocomplete="cc-number" value="9999888877776666">
            <iframe src="${frameUrl}"></iframe>`,
          [frameUrl]: `<input autocomplete="cc-number" value="4242424242424242">`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator({ frameIndex: 1 });
        expect(result.frameUrl).toBe(frameUrl);
        expect(result.redactedCount).toBe(1);
        expect(isValidJpegBase64(result.base64)).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("resolves a frame by a URL substring", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageUrl = "https://shop.example.test/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/card-fields";
      const page = await servePages(browser, {
        [pageUrl]: `<iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `<p>card fields</p>`,
      });
      await page.goto(pageUrl);
      await page.waitForLoadState("networkidle");
      const controller = BrowserController.fromHarnessPage(page);

      const result = await controller.screenshotForOperator({
        frameUrlContains: "shopifyinc.com",
      });
      expect(result.frameUrl).toBe(frameUrl);
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "throws screenshot_frame_not_found for an out-of-range frame_index",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<p>no frames here</p>");
        const controller = BrowserController.fromHarnessPage(page);

        await expect(controller.screenshotForOperator({ frameIndex: 5 })).rejects.toThrow(
          "screenshot_frame_not_found",
        );
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "throws screenshot_frame_not_found for a frame_url_contains with no match",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<p>no frames here</p>");
        const controller = BrowserController.fromHarnessPage(page);

        await expect(
          controller.screenshotForOperator({ frameUrlContains: "nonexistent.example" }),
        ).rejects.toThrow("screenshot_frame_not_found");
      } finally {
        await browser.close();
      }
    },
  );
});
