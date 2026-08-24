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

// Playwright's default mask color is #FF00FF; allow for JPEG compression drift.
function isMaskMagenta(pixel: readonly number[]): boolean {
  return (pixel[0] ?? 0) > 200 && (pixel[1] ?? 255) < 80 && (pixel[2] ?? 0) > 200;
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

        // Pixel-level proof the IMAGE is redacted, not just the metadata:
        // the PAN field's box must be the mask color, while the non-card
        // field keeps ordinary (non-magenta) pixels.
        const panBox = await page.locator('[autocomplete="cc-number"]').boundingBox();
        const plainBox = await page.locator('input[type="text"]').boundingBox();
        expect(panBox).not.toBeNull();
        expect(plainBox).not.toBeNull();
        const [panPixel, plainPixel] = await samplePixels(page, result.base64, [
          [panBox!.x + panBox!.width / 2, panBox!.y + panBox!.height / 2],
          [plainBox!.x + plainBox!.width / 2, plainBox!.y + plainBox!.height / 2],
        ]);
        expect(isMaskMagenta(panPixel!)).toBe(true);
        expect(isMaskMagenta(plainPixel!)).toBe(false);

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

  it.skipIf(!chromiumAvailable)("allows a proven hidden empty secret control", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<input type="password" value="" style="display:none">`);
      const controller = BrowserController.fromHarnessPage(page);

      await expect(controller.captureOperatorScreenshot()).resolves.toMatchObject({
        redactedCount: 1,
      });
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "masks an input whose VALUE is a Luhn-valid PAN even without card attributes",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <input id="freeform" type="text" value="4242 4242 4242 4242">
          <input id="harmless" type="text" value="order 123456">
        `);
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.screenshotForOperator();
        expect(result.redactedCount).toBe(1);

        const panBox = await page.locator("#freeform").boundingBox();
        expect(panBox).not.toBeNull();
        const [panPixel] = await samplePixels(page, result.base64, [
          [panBox!.x + panBox!.width / 2, panBox!.y + panBox!.height / 2],
        ]);
        expect(isMaskMagenta(panPixel!)).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "refuses populated sealed, password, PAN, expiry, CVV, and select fields",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const sensitiveFields = [
          '<input data-ts-sealed-payment="1" value="still-secret">',
          '<input type="password" value="otp-secret">',
          '<input autocomplete="one-time-code" value="654321">',
          '<input name="challenge_pin" value="9876">',
          '<input value="4242 4242 4242 4242">',
          '<input autocomplete="cc-exp" value="12/30">',
          '<input autocomplete="cc-csc" value="123">',
          '<select autocomplete="cc-exp-year"><option value="30" selected>2030</option></select>',
          '<select autocomplete="cc-exp-year"><option value="" selected>2030</option></select>',
        ];
        for (const field of sensitiveFields) {
          const page = await browser.newPage();
          await page.setContent(field);
          const controller = BrowserController.fromHarnessPage(page);
          await expect(controller.captureOperatorScreenshot()).rejects.toThrow(
            "screenshot_unavailable_sealed_context",
          );
          await page.close();
        }
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "preserves type_secret identity across a controlled-input rerender",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<nav><input></nav>");
        const controller = BrowserController.fromHarnessPage(page);
        const sealedFieldKeys = await controller.type("input", "secret-value", true);
        await page.locator("input").evaluate((input) => {
          const replacement = input.cloneNode(true) as HTMLInputElement;
          replacement.removeAttribute("data-ts-sealed-payment");
          input.replaceWith(replacement);
        });

        await expect(
          controller.captureOperatorScreenshot({}, sealedFieldKeys),
        ).rejects.toThrow("screenshot_unavailable_sealed_context");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "returns durable sealed identity from locator typing across a controlled rerender",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<nav><input id="secret"></nav>');
        const controller = BrowserController.fromHarnessPage(page);
        const resolved = await controller.resolvePageTarget("css", "#secret", "type");
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error("locator did not resolve");

        const sealedFieldKeys = await controller.typeHandle(resolved.handle, "secret-value", true);
        await resolved.handle.dispose();
        await page.locator("#secret").evaluate((input) => {
          const replacement = input.cloneNode(true) as HTMLInputElement;
          replacement.removeAttribute("data-ts-sealed-payment");
          input.replaceWith(replacement);
        });

        await expect(
          controller.captureOperatorScreenshot({}, sealedFieldKeys),
        ).rejects.toThrow("screenshot_unavailable_sealed_context");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("refuses a rendered separator-formatted PAN", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<div>Card on file: 4242-4242 4242-4242</div>");
      const controller = BrowserController.fromHarnessPage(page);

      await expect(controller.captureOperatorScreenshot()).rejects.toThrow(
        "screenshot_unavailable_sealed_context",
      );
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "never passes raw screenshot bytes through merchant page APIs",
    async () => {
      const browser = await chromium.launch({ headless: true });
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

  it.skipIf(!chromiumAvailable)(
    "rejects redaction geometry and element identity changes during capture",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        for (const mutation of ["move", "replace"] as const) {
          const page = await browser.newPage();
          await page.setContent('<input id="secret" autocomplete="cc-number" value="">');
          const context = page.context();
          const newCDPSession = context.newCDPSession.bind(context);
          context.newCDPSession = async (target) => {
            const session = await newCDPSession(target);
            const send = session.send.bind(session);
            session.send = async (method, params) => {
              const result = await send(method, params);
              if (method === "Page.captureScreenshot") {
                await page.locator("#secret").evaluate((element, kind) => {
                  if (kind === "move") {
                    (element as HTMLElement).style.marginLeft = "80px";
                  } else {
                    element.replaceWith(element.cloneNode(true));
                  }
                }, mutation);
              }
              return result;
            };
            return session;
          };
          const controller = BrowserController.fromHarnessPage(page);

          await expect(controller.screenshotForOperator()).rejects.toThrow(
            "screenshot_redaction_unstable",
          );
          await page.close();
        }
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "re-verifies sealed content immediately before pixel capture",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<div id=card></div>");
        const context = page.context();
        const newCDPSession = context.newCDPSession.bind(context);
        let captureCalls = 0;
        context.newCDPSession = async (target) => {
          const session = await newCDPSession(target);
          await page.locator("#card").evaluate((element) => {
            element.textContent = "4242 4242 4242 4242";
          });
          const send = session.send.bind(session);
          session.send = async (method, params) => {
            if (method === "Page.captureScreenshot") captureCalls += 1;
            return await send(method, params);
          };
          return session;
        };
        const controller = BrowserController.fromHarnessPage(page);

        await expect(controller.captureOperatorScreenshot()).rejects.toThrow(
          "screenshot_unavailable_sealed_context",
        );
        expect(captureCalls).toBe(0);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "retries one observed capture mutation against fresh geometry",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<input id="secret" autocomplete="cc-number" value="">');
        const context = page.context();
        const newCDPSession = context.newCDPSession.bind(context);
        let captureCalls = 0;
        context.newCDPSession = async (target) => {
          const session = await newCDPSession(target);
          const send = session.send.bind(session);
          session.send = async (method, params) => {
            const result = await send(method, params);
            if (method === "Page.captureScreenshot") {
              captureCalls += 1;
              if (captureCalls === 1) {
                await page.locator("#secret").evaluate((element) => {
                  (element as HTMLElement).style.marginLeft = "80px";
                });
              }
            }
            return result;
          };
          return session;
        };
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.captureOperatorScreenshot();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        expect(captureCalls).toBe(2);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "allows empty ACS secret controls without mutating the document",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <input type="password" value="">
          <input autocomplete="one-time-code" value="">
          <select autocomplete="cc-exp-year"><option value="" selected>Year</option></select>
        `);
        await page.evaluate(() => {
          (window as Window & { mutationCount?: number }).mutationCount = 0;
          new MutationObserver((records) => {
            (window as Window & { mutationCount?: number }).mutationCount! += records.length;
          }).observe(document, { attributes: true, childList: true, subtree: true });
        });
        const controller = BrowserController.fromHarnessPage(page);

        const result = await controller.captureOperatorScreenshot();

        expect(isValidJpegBase64(result.base64)).toBe(true);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(
          await page.evaluate(
            () => (window as Window & { mutationCount?: number }).mutationCount ?? -1,
          ),
        ).toBe(0);
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

  it.skipIf(!chromiumAvailable)(
    "allows an isolated clean ACS frame even while the parent checkout still has a sealed field",
    async () => {
      const browser = await chromium.launch({ headless: true });
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

        await expect(controller.captureOperatorScreenshot()).rejects.toThrow(
          "screenshot_unavailable_sealed_context",
        );
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

  it.skipIf(!chromiumAvailable)(
    "verifies parent compositor overlays included in a targeted capture",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const frameUrl = "https://authentication.cardinalcommerce.com/challenge/overlay";
        const page = await servePages(browser, {
          [pageUrl]: `
            <style>
              iframe { border: 0; width: 320px; height: 180px }
              #overlay { position: fixed; inset: 0; background: white; z-index: 10 }
            </style>
            <iframe src="${frameUrl}"></iframe><div id="overlay">4242 4242 4242 4242</div>`,
          [frameUrl]: `<style>html,body { margin: 0; background: rgb(0, 128, 0) }</style>`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);

        await expect(
          controller.captureOperatorScreenshot({ frameUrlContains: "cardinalcommerce.com" }),
        ).rejects.toThrow("screenshot_unavailable_sealed_context");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "verifies descendant documents included by a targeted frame",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const frameUrl = "https://authentication.cardinalcommerce.com/challenge/nested";
        const nestedUrl = "https://issuer.example.test/card";
        const page = await servePages(browser, {
          [pageUrl]: `<iframe src="${frameUrl}"></iframe>`,
          [frameUrl]: `<iframe src="${nestedUrl}"></iframe>`,
          [nestedUrl]: `<input autocomplete="cc-csc" value="123">`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);

        await expect(
          controller.captureOperatorScreenshot({ frameUrlContains: "cardinalcommerce.com" }),
        ).rejects.toThrow("screenshot_unavailable_sealed_context");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fails closed on an unreadable included frame but allows a separate verified target",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const badFrameUrl = "https://broken.example.test/frame";
        const acsFrameUrl = "https://authentication.cardinalcommerce.com/challenge";
        const page = await servePages(browser, {
          [pageUrl]: `<iframe src="${badFrameUrl}"></iframe><iframe src="${acsFrameUrl}"></iframe>`,
          [badFrameUrl]: `<input type="password"><script>Object.defineProperty(document.querySelector('input'), 'value', { get() { throw new Error('unreadable'); } })</script>`,
          [acsFrameUrl]: `<p>Approve in your banking app</p>`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);

        await expect(controller.captureOperatorScreenshot()).rejects.toThrow(
          "screenshot_unavailable_sealed_context",
        );
        await expect(
          controller.captureOperatorScreenshot({ frameUrlContains: "cardinalcommerce.com" }),
        ).resolves.toMatchObject({ frameUrl: acsFrameUrl });
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "discards a targeted capture when its verified document navigates",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pageUrl = "https://shop.example.test/checkout";
        const frameUrl = "https://authentication.cardinalcommerce.com/challenge";
        const replacementUrl = "https://issuer.example.test/replacement";
        const page = await servePages(browser, {
          [pageUrl]: `<iframe src="${frameUrl}"></iframe>`,
          [frameUrl]: `<input type="password"><script>Object.defineProperty(document.querySelector('input'), 'value', { get() { location.href = '${replacementUrl}'; return ''; } })</script>`,
          [replacementUrl]: `<input autocomplete="cc-csc" value="123">`,
        });
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = BrowserController.fromHarnessPage(page);

        await expect(
          controller.captureOperatorScreenshot({ frameUrlContains: "cardinalcommerce.com" }),
        ).rejects.toThrow("screenshot_unavailable_sealed_context");
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
