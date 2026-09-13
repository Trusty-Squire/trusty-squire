// operate_screenshot's browser implementation. Ordinary sessions still return
// real pixels. Once a card is released, the narrow PAN/CVV output mask composites
// over value-bearing pixels while preserving the live DOM. Real-Chromium, mirroring
// browser-payment.test.ts's
// harness pattern — a screenshot is inherently about actual rendering, not
// something a mocked page can meaningfully stand in for.
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController, type CheckoutCard } from "../browser.js";

const SYNTHETIC_CARD: CheckoutCard = {
  pan: "4111111111111111",
  cvv: "123",
  exp_month: "12",
  exp_year: "2030",
  name: "Synthetic Buyer",
  billing: {
    line1: "1 Test Street",
    city: "Testville",
    postal_code: "10000",
    country: "US",
  },
};

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

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

function isValidPngBase64(base64: string): boolean {
  const buffer = Buffer.from(base64, "base64");
  return (
    buffer.length > 100 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  );
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
    {
      dataUrl: `data:${isValidPngBase64(base64) ? "image/png" : "image/jpeg"};base64,${base64}`,
      samplePoints: points.map((p) => [...p]),
    },
  );
}

function isCompositeGray(pixel: readonly number[]): boolean {
  return [pixel[0], pixel[1], pixel[2]].every((value) => Math.abs((value ?? 0) - 232) <= 2);
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

describe("operate_screenshot before card release (real browser)", () => {
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
          ['[autocomplete="cc-number"]', '[autocomplete="cc-csc"]', 'input[type="text"]'].map(
            async (selector) => await centerOf(page, selector),
          ),
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
          <p id="key" style="font-size:24px">${sk("live-9f2c8a1e4b7d6053ac91")}</p>
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
        await controller.type("#secret", sk("live-secret-value"), true);

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

describe("operate_screenshot card-value output mask (real browser)", () => {
  it.skipIf(!chromiumAvailable)(
    "composites PAN/CVV controls and mirrored PAN text without changing the checkout DOM",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <style>body{font:24px sans-serif} input{display:block;width:420px;height:44px;margin:8px}</style>
          <input id="pan" data-ts-card-mask="pan" value="4111 1111 1111 1111">
          <input id="cvv" data-ts-card-mask="cvv" value="123">
          <div id="mirror" style="display:inline-block">4111-1111-1111-1111</div>
          <div id="prefix" style="display:inline-block">4111.1111.11</div>
          <div id="unicode" style="display:inline-block">4111‑1111‑1111‑1111</div>
          <div id="total" style="display:inline-block">Total: 123 JPY</div>
          <div id="three-ds" style="display:inline-block">Enter your bank OTP</div>
          <div id="split" style="display:block;background:rgb(0,204,0)">4111|1111|1111|1111 / 1 2 3</div>
          <div id="encoded" style="display:block;background:rgb(0,204,0)">NDExMTExMTExMTExMTExMQ==</div>
          <canvas id="canvas" width="420" height="44" style="display:block;background:rgb(204,0,0)"></canvas>
        `);
        await page.locator("#canvas").evaluate((node) => {
          const canvas = node as HTMLCanvasElement;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "white";
          context.font = "24px sans-serif";
          context.fillText("4111 1111 1111 1111", 8, 30);
        });
        const controller = BrowserController.fromHarnessPage(page);
        controller.registerCardValueOutputMask({ pan: "4111111111111111", cvv: "123" });
        const before = await page.content();

        const viewport = await controller.screenshotForOperator();
        const full = await controller.screenshotForOperator({ fullPage: true });

        expect(viewport.mimeType).toBe("image/png");
        expect(isValidPngBase64(viewport.base64)).toBe(true);
        expect(isValidPngBase64(full.base64)).toBe(true);
        const points = await Promise.all(
          [
            "#pan",
            "#cvv",
            "#mirror",
            "#prefix",
            "#unicode",
            "#total",
            "#three-ds",
            "#split",
            "#encoded",
            "#canvas",
          ].map(async (selector) => await centerOf(page, selector)),
        );
        const [pan, cvv, mirror, prefix, unicode, total, threeDs, split, encoded, canvas] =
          await samplePixels(page, viewport.base64, points);
        expect(isCompositeGray(pan ?? [])).toBe(true);
        expect(isCompositeGray(cvv ?? [])).toBe(true);
        expect(isCompositeGray(mirror ?? [])).toBe(true);
        expect(isCompositeGray(prefix ?? [])).toBe(true);
        expect(isCompositeGray(unicode ?? [])).toBe(true);
        expect(isCompositeGray(total ?? [])).toBe(false);
        expect(isCompositeGray(threeDs ?? [])).toBe(false);
        // Accepted hostile-page limit: transformed/split/canvas copies are not
        // ordinary complete-value copies and are intentionally not chased by
        // an information-flow scanner.
        expect(isCompositeGray(split ?? [])).toBe(false);
        expect(isCompositeGray(encoded ?? [])).toBe(false);
        expect(isCompositeGray(canvas ?? [])).toBe(false);
        expect(await page.content()).toBe(before);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "masks both pre-capture and post-capture layout positions",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <style>body{margin:0}</style>
          <input id="pan" data-ts-card-mask="pan" value="4111 1111 1111 1111"
            style="position:absolute;left:300px;top:20px;width:300px;height:44px;background:rgb(204,0,0)">
        `);
        await page.locator("#pan").evaluate((node) => {
          const element = node as HTMLInputElement & {
            getBoundingClientRect: () => DOMRect;
          };
          const actual = element.getBoundingClientRect.bind(element);
          let first = true;
          element.getBoundingClientRect = () => {
            const rect = actual();
            if (!first) return rect;
            first = false;
            return DOMRect.fromRect({ x: 0, y: rect.y, width: rect.width, height: rect.height });
          };
        });
        const controller = BrowserController.fromHarnessPage(page);
        controller.registerCardValueOutputMask(SYNTHETIC_CARD);

        const result = await controller.screenshotForOperator();

        const [staleMask, liveControl] = await samplePixels(page, result.base64, [
          [150, 42],
          [450, 42],
        ]);
        expect(isCompositeGray(staleMask ?? [])).toBe(true);
        expect(isCompositeGray(liveControl ?? [])).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fails the screenshot when an active card mask cannot scan the rendered document",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(`<input data-ts-card-mask="pan" value="${SYNTHETIC_CARD.pan}">`);
        const controller = BrowserController.fromHarnessPage(page);
        controller.registerCardValueOutputMask(SYNTHETIC_CARD);
        await page.evaluate(() => {
          Document.prototype.querySelectorAll = () => {
            throw new Error("synthetic scan failure");
          };
        });

        await expect(controller.screenshotForOperator()).rejects.toThrow(
          "card_mask_frame_scan_failed",
        );
      } finally {
        await browser.close();
      }
    },
  );
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
    "masks a targeted cross-origin frame after PAN/CVV controls rerender with new identities",
    async () => {
      const browser = await launchIsolatedTestBrowser();
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const frameUrl = "https://assets.braintreegateway.test/hosted";
        const page = await servePages(browser, {
          [pageUrl]: `<iframe style="width:400px;height:160px;border:0" src="${frameUrl}"></iframe>`,
          [frameUrl]: `<style>body{margin:0}input{display:block;width:300px;height:60px}</style><input id="number" name="pan"><input id="security" name="cvv">`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);
        const elements = await controller.extractInteractiveElements();
        const pan = elements.find((element) => element.name === "pan");
        const cvv = elements.find((element) => element.name === "cvv");
        if (pan === undefined || cvv === undefined)
          throw new Error("missing synthetic card fields");
        await controller.injectCardIntoTargets(SYNTHETIC_CARD, {
          pan: { element: pan },
          cvv: { element: cvv },
        });
        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        await frame.evaluate((card) => {
          document.body.innerHTML = `<style>body{margin:0}input{display:block;width:300px;height:60px}</style><input id="number-rerendered" name="card-number" value="${card.pan}"><input id="security-rerendered" name="cvv2" value="${card.cvv}">`;
        }, SYNTHETIC_CARD);
        expect(
          await frame.locator("#security-rerendered").getAttribute("data-ts-card-mask"),
        ).toBeNull();

        const result = await controller.screenshotForOperator({ frameIndex: 1 });

        expect(result.mimeType).toBe("image/png");
        expect(result.frameUrl).toBe(frameUrl);
        const [panPixel, cvvPixel] = await samplePixels(page, result.base64, [
          [150, 30],
          [150, 90],
        ]);
        expect(isCompositeGray(panPixel ?? [])).toBe(true);
        expect(isCompositeGray(cvvPixel ?? [])).toBe(true);
        expect(await frame.locator("#number-rerendered").inputValue()).toBe(SYNTHETIC_CARD.pan);
        expect(await frame.locator("#security-rerendered").inputValue()).toBe(SYNTHETIC_CARD.cvv);
      } finally {
        await browser.close();
      }
    },
  );

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
