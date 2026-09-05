// operate_screenshot's browser implementation. There is no redaction pass and no
// sealed-context refusal any more (owner's decision, 2026-09-05: ALL seals out),
// so these tests pin the opposite of what they used to: the scenarios that
// previously masked pixels or threw `screenshot_unavailable_sealed_context` must
// now return the page's real pixels. The read-only property (no navigation, no
// DOM mutation, no page-visible byte handling) and frame targeting are unchanged
// and still covered here. Real-Chromium, mirroring browser-payment.test.ts's
// harness pattern — a screenshot is inherently about actual rendering, not
// something a mocked page can meaningfully stand in for.
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";

let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

let sharedBrowser: Browser | undefined;

beforeAll(async () => {
  if (chromiumAvailable) sharedBrowser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await sharedBrowser?.close();
});

type IsolatedTestBrowser = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

async function launchIsolatedTestBrowser(): Promise<IsolatedTestBrowser> {
  if (sharedBrowser === undefined) throw new Error("Chromium test browser was not started");
  const contexts: BrowserContext[] = [];
  return {
    async newPage() {
      const context = await sharedBrowser!.newContext();
      contexts.push(context);
      return await context.newPage();
    },
    async close() {
      await Promise.all(contexts.map(async (context) => await context.close()));
    },
  };
}

function isValidJpegBase64(base64: string): boolean {
  const buffer = Buffer.from(base64, "base64");
  // JPEG SOI marker.
  return buffer.length > 100 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

// Decode the captured JPEG with the browser already at hand (Image + canvas —
// a real decode of the produced bytes) and sample one RGBA pixel per point.
// The canvas is never attached to the DOM.
async function samplePixels(
  page: Page,
  base64: string,
  points: ReadonlyArray<readonly [number, number]>,
): Promise<number[][]> {
  return await page.evaluate(
    async ({ dataUrl, samplePoints }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("jpeg decode failed"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.drawImage(image, 0, 0);
      return samplePoints.map((point) =>
        Array.from(
          context.getImageData(Math.round(point[0] ?? 0), Math.round(point[1] ?? 0), 1, 1).data,
        ),
      );
    },
    { dataUrl: `data:image/jpeg;base64,${base64}`, samplePoints: points.map((p) => [...p]) },
  );
}

// The old redaction painted #FF00FF over every masked box. Nothing paints it now,
// so a magenta pixel anywhere a value is rendered means a mask came back.
function isMaskMagenta(pixel: readonly number[]): boolean {
  return (pixel[0] ?? 0) > 200 && (pixel[1] ?? 255) < 80 && (pixel[2] ?? 0) > 200;
}

async function centerOf(page: Page, selector: string): Promise<readonly [number, number]> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return [box.x + box.width / 2, box.y + box.height / 2] as const;
}

describe("operate_screenshot returns unmasked pixels (real browser)", () => {
  it.skipIf(!chromiumAvailable)(
    "captures a filled card PAN/expiry/CVV/name without masking, and without mutating the DOM",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <input autocomplete="cc-number" value="4242424242424242" style="border:1px solid red">
          <input autocomplete="cc-name" value="Synthetic Cardholder">
          <input autocomplete="cc-exp" placeholder="MM/YY" value="12/30">
          <input autocomplete="cc-csc" value="123">
          <input type="text" value="not a card field">
        `);
        const domBefore = await page.content();
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        expect(result.frameUrl).toBeNull();

        const points = await Promise.all(
          [
            '[autocomplete="cc-number"]',
            '[autocomplete="cc-csc"]',
            'input[type="text"]',
          ].map(async (selector) => await centerOf(page, selector)),
        );
        const pixels = await samplePixels(page, result.base64, points);
        for (const pixel of pixels) expect(isMaskMagenta(pixel)).toBe(false);

        // Read-only: the capture path must not touch the live checkout DOM.
        expect(await page.content()).toBe(domBefore);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "captures a payment-marked node and a password field without masking either",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <div data-ts-sealed-payment="1" style="font-size:28px">4242 4242 4242 4242</div>
          <input type="password" value="hunter2hunter2">
        `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        const points = await Promise.all(
          ['div[data-ts-sealed-payment="1"]', 'input[type="password"]'].map(
            async (selector) => await centerOf(page, selector),
          ),
        );
        for (const pixel of await samplePixels(page, result.base64, points)) {
          expect(isMaskMagenta(pixel)).toBe(false);
        }
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "captures a rendered API key, recovery code and TOTP — the case the operator was blocked on",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <p id="key" style="font-size:24px">sk-live-9f2c8a1e4b7d6053ac91</p>
          <p id="recovery" style="font-size:24px">ABCD-EFGH-IJKL-MNOP</p>
          <p id="totp" style="font-size:24px">482913</p>
        `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        const points = await Promise.all(
          ["#key", "#recovery", "#totp"].map(async (selector) => await centerOf(page, selector)),
        );
        for (const pixel of await samplePixels(page, result.base64, points)) {
          expect(isMaskMagenta(pixel)).toBe(false);
        }
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "captures a Luhn-valid PAN rendered as page text without refusing or masking",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent('<p id="pan" style="font-size:24px">4242-4242-4242-4242</p>');
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.captureOperatorScreenshot();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        const [pixel] = await samplePixels(page, result.base64, [await centerOf(page, "#pan")]);
        expect(isMaskMagenta(pixel ?? [])).toBe(false);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "captures while an operator-typed secret sits in a marked field",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent('<input id="secret" style="width:400px">');
        const controller = BrowserController.fromHarnessPage(page);
        await controller.type("#secret", "sk-live-secret-value", true);

        const result = await controller.captureOperatorScreenshot();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        // The payment marker is still stamped — it is card-fill machinery, not a
        // read seal — but it no longer changes what the capture returns.
        expect(await page.locator('#secret[data-ts-sealed-payment="1"]').count()).toBe(1);
        const [pixel] = await samplePixels(page, result.base64, [await centerOf(page, "#secret")]);
        expect(isMaskMagenta(pixel ?? [])).toBe(false);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "never passes raw screenshot bytes through merchant page APIs",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent('<input autocomplete="cc-number" value="4242424242424242">');
        await page.evaluate(() => {
          const state = window as Window & { screenshotApiTouches?: number };
          state.screenshotApiTouches = 0;
          const NativeImage = window.Image;
          Object.defineProperty(window, "Image", {
            configurable: true,
            value: class extends NativeImage {
              constructor(width?: number, height?: number) {
                super(width, height);
                state.screenshotApiTouches! += 1;
              }
            },
          });
          const createElement = document.createElement.bind(document);
          document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
            if (tagName.toLowerCase() === "canvas") state.screenshotApiTouches! += 1;
            return createElement(tagName, options);
          }) as typeof document.createElement;
        });
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        expect(
          await page.evaluate(
            () => (window as Window & { screenshotApiTouches?: number }).screenshotApiTouches,
          ),
        ).toBe(0);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("captures the full scrollable page on full_page", async () => {
    const browser = await launchIsolatedTestBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<div style="height:3000px">tall</div>');
      const controller = BrowserController.fromHarnessPage(page);

      const viewport = await controller.screenshotForOperator();
      const full = await controller.screenshotForOperator({ fullPage: true });

      expect(isValidJpegBase64(viewport.base64)).toBe(true);
      expect(isValidJpegBase64(full.base64)).toBe(true);
      expect(full.base64.length).toBeGreaterThan(viewport.base64.length);
    } finally {
      await browser.close();
    }
  });
});

describe("operate_screenshot frame targeting (real browser)", () => {
  async function servePages(
    browser: IsolatedTestBrowser,
    pages: Record<string, string>,
  ): Promise<Page> {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      const body = pages[url];
      if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ contentType: "text/html", body });
    });
    return page;
  }

  it.skipIf(!chromiumAvailable)("captures ONE cross-origin frame by index", async () => {
    const browser = await launchIsolatedTestBrowser();
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
      expect(isValidJpegBase64(result.base64)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "captures an isolated ACS frame while the parent checkout holds a filled card field",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const frameUrl = "https://authentication.cardinalcommerce.com/challenge/CReq";
        const page = await servePages(browser, {
          [pageUrl]: `<input data-ts-sealed-payment="1" value="4242424242424242"><iframe src="${frameUrl}"></iframe>`,
          [frameUrl]: `<p>Complete authentication</p>`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);

        // The whole page captures too — a filled card field is no longer a refusal.
        const whole = await controller.captureOperatorScreenshot();
        expect(isValidJpegBase64(whole.base64)).toBe(true);

        const result = await controller.captureOperatorScreenshot({
          frameUrlContains: "cardinalcommerce.com",
        });
        expect(result.frameUrl).toBe(frameUrl);
        expect(isValidJpegBase64(result.base64)).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("resolves a frame by a URL substring", async () => {
    const browser = await launchIsolatedTestBrowser();
    try {
      const pageUrl = "https://shop.example.test/checkout";
      const frameUrl = "https://authentication.cardinalcommerce.com/challenge";
      const page = await servePages(browser, {
        [pageUrl]: `<iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `<p>Approve this payment in your banking app</p>`,
      });
      await page.goto(pageUrl);
      await page.waitForLoadState("networkidle");
      const controller = BrowserController.fromHarnessPage(page);

      const result = await controller.screenshotForOperator({
        frameUrlContains: "cardinalcommerce.com",
      });
      expect(result.frameUrl).toBe(frameUrl);
      expect(result.frameCount).toBe(2);
      expect(isValidJpegBase64(result.base64)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "throws screenshot_frame_not_found for an out-of-range frame_index",
    async () => {
      const browser = await launchIsolatedTestBrowser();
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
      const browser = await launchIsolatedTestBrowser();
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
