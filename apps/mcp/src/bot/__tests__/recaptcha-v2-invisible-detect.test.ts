// Fail-before / pass-after for IPInfo's v2-invisible image grid:
// api.js?render=explicit + an anchor with type=image&size=invisible + a
// visible api2/bframe. The old detector mapped size=invisible to
// recaptcha_v3 and bought a score token the grid cannot accept.
//
// After inject, the widget callback must fire (that is what enables
// submit). Textarea fill alone is not enough.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectCaptchaVariant,
  grecaptchaClientCountInWorld,
  injectRecaptchaToken,
} from "../captcha.js";
import { injectCaptchaToken } from "../captcha-solve.js";
import { BrowserController } from "../browser.js";

const SITEKEY = "6LftmFkUAAAAADydGEH99T-xmZoK69ErtRCzfVFf";
const ANCHOR_URL = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${SITEKEY}&type=image&theme=light&size=invisible`;
const BFRAME_URL = `https://www.google.com/recaptcha/api2/bframe?ar=1&k=${SITEKEY}&type=image`;

const ANCHOR_HTML = `<!doctype html><html><body style="margin:0"><div id="anchor">invisible</div></body></html>`;
const BFRAME_HTML = `<!doctype html><html><body style="margin:0"><div id="challenge-grid">select all images with cars</div></body></html>`;

const PARENT_HTML = `<!doctype html><html><body style="margin:0">
<script src="https://www.google.com/recaptcha/api.js?onload=onloadcallback&amp;render=explicit"></script>
<form>
  <textarea name="g-recaptcha-response" id="g-recaptcha-response"></textarea>
  <button type="submit" id="go" disabled>Get started now</button>
</form>
<iframe id="rc-anchor" title="reCAPTCHA" width="32" height="32" src="${ANCHOR_URL}"></iframe>
<iframe id="rc-bframe" title="recaptcha challenge expires in two minutes" width="400" height="580"
  style="position:absolute;top:20px;left:20px" src="${BFRAME_URL}"></iframe>
<script>
  window.___grecaptcha_cfg = {
    clients: {
      0: {
        callback: function (tok) {
          document.getElementById("go").disabled = false;
          document.getElementById("rc-bframe").style.top = "-9999px";
        },
      },
    },
  };
</script>
</body></html>`;

const STRING_CALLBACK_HTML = `<!doctype html><html><body style="margin:0">
<script src="https://www.google.com/recaptcha/api.js?onload=onloadcallback&amp;render=explicit"></script>
<form>
  <textarea name="g-recaptcha-response" id="g-recaptcha-response"></textarea>
  <button type="submit" id="go" disabled>Get started now</button>
</form>
<iframe id="rc-anchor" title="reCAPTCHA" width="32" height="32" src="${ANCHOR_URL}"></iframe>
<iframe id="rc-bframe" title="recaptcha challenge expires in two minutes" width="400" height="580"
  style="position:absolute;top:20px;left:20px" src="${BFRAME_URL}"></iframe>
<script>
  window.onSubmit = function () {
    document.getElementById("go").disabled = false;
  };
  window.___grecaptcha_cfg = {
    clients: {
      0: { callback: "onSubmit" },
    },
  };
</script>
</body></html>`;

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

describe.skipIf(!available)("recaptcha v2-invisible image challenge (IPInfo shape)", () => {
  let server: Server;
  let baseUrl = "";
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url?.includes("string-callback") === true ? STRING_CALLBACK_HTML : PARENT_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/signup`;
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**://www.google.com/recaptcha/api2/anchor**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: ANCHOR_HTML }),
    );
    await context.route("**://www.google.com/recaptcha/api2/bframe**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: BFRAME_HTML }),
    );
    await context.route("**://www.google.com/recaptcha/api.js**", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "window.onloadcallback=function(){};" }),
    );
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("detects recaptcha_v2 and enables submit by firing the widget callback", async () => {
    const page: Page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expect
      .poll(
        async () =>
          page
            .frames()
            .some((fr) => fr.url().startsWith("https://www.google.com/recaptcha/api2/anchor")),
        { timeout: 15_000, interval: 250 },
      )
      .toBe(true);
    const controller = BrowserController.fromHarnessPage(page);
    const detected = await detectCaptchaVariant(controller, page);
    expect(detected.variant).toBe("recaptcha_v2");
    expect(detected.challengeRendered).toBe(true);
    expect(detected.recaptcha?.anchorType).toBe("image");
    expect(detected.recaptcha?.anchorSize).toBe("invisible");
    expect(detected.recaptcha?.apiRender).toBe("explicit");
    expect(detected.recaptcha?.challengeFrameVisible).toBe(true);

    expect(await page.locator("#go").isDisabled()).toBe(true);
    const token = "03AGdBq24-fixture-v2-token";
    expect(await injectRecaptchaToken(controller, token, page)).toBe(true);
    expect(await page.locator("#g-recaptcha-response").inputValue()).toBe(token);
    expect(await page.locator("#go").isDisabled()).toBe(false);
    const after = await detectCaptchaVariant(controller, page);
    expect(after.challengeRendered).toBe(false);
    await page.close();
  }, 60_000);

  it("resolves a string-named grecaptcha callback and treats an enabled submit as solved", async () => {
    const page: Page = await context.newPage();
    await page.goto(`${baseUrl.replace(/\/signup$/, "")}/string-callback`, {
      waitUntil: "domcontentloaded",
    });
    await expect
      .poll(
        async () =>
          page
            .frames()
            .some((fr) => fr.url().startsWith("https://www.google.com/recaptcha/api2/anchor")),
        { timeout: 15_000, interval: 250 },
      )
      .toBe(true);
    const controller = BrowserController.fromHarnessPage(page);
    expect(await grecaptchaClientCountInWorld(page, "isolated")).toBe(0);
    expect(await grecaptchaClientCountInWorld(page, "main")).toBe(1);
    expect(await page.locator("#go").isDisabled()).toBe(true);
    const token = "03AGdBq24-fixture-v2-string-cb";
    expect(await injectRecaptchaToken(controller, token, page)).toBe(true);
    expect(await page.locator("#g-recaptcha-response").inputValue()).toBe(token);
    expect(await page.locator("#go").isDisabled()).toBe(false);
    const after = await detectCaptchaVariant(controller, page);
    expect(after.challengeRendered).toBe(true);
    const result = await injectCaptchaToken(controller, "recaptcha_v2", token, page);
    expect(result).toEqual({ solved: true, outcome: "ok" });
    await page.close();
  }, 60_000);
});
