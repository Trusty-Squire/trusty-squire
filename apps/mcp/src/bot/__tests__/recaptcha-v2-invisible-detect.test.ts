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
  hasCaptchaResponseTokenForVariant,
  injectRecaptchaToken,
  injectRecaptchaTokenDetail,
  shouldDeferUnengagedTurnstile,
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

const DUPLICATE_CALLBACK_HTML = `<!doctype html><html><body>
<form><textarea name="g-recaptcha-response"></textarea></form>
<script>
  window.callbackCalls = 0;
  const callback = () => { window.callbackCalls += 1; };
  const other = () => { window.callbackCalls += 100; };
  const shared = { callback };
  window.___grecaptcha_cfg = { clients: { 0: { first: shared, alias: shared, second: { callback: other } } } };
</script>
</body></html>`;

const SDK_RESPONSE_HTML = `<!doctype html><html><body>
<form><textarea name="g-recaptcha-response"></textarea><button id="go" disabled>Next</button></form>
<script>
  window.grecaptcha = { getResponse: () => '' };
  window.___grecaptcha_cfg = { clients: { 0: { callback: () => {
    if (grecaptcha.getResponse(0) === 'bought-token') document.getElementById('go').disabled = false;
  } } } };
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
      res.end(
        req.url?.includes("duplicate-callback") === true
          ? DUPLICATE_CALLBACK_HTML
          : req.url?.includes("sdk-response") === true
            ? SDK_RESPONSE_HTML
            : req.url?.includes("string-callback") === true
              ? STRING_CALLBACK_HTML
              : PARENT_HTML,
      );
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
      route.fulfill({
        contentType: "application/javascript",
        body: "window.onloadcallback=function(){};",
      }),
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

  it("fires a callback only once when reCAPTCHA exposes it through multiple aliases", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl.replace(/\/signup$/, "")}/duplicate-callback`);
      const controller = BrowserController.fromHarnessPage(page);
      const result = await injectRecaptchaTokenDetail(controller, "one-response-token", page);
      expect(result.callbacksFired).toBe(1);
      expect(
        await page.evaluate(() => (window as unknown as { callbackCalls: number }).callbackCalls),
      ).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("makes a bought token visible through the explicit widget SDK response", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl.replace(/\/signup$/, "")}/sdk-response`);
      const controller = BrowserController.fromHarnessPage(page);
      expect(await injectRecaptchaToken(controller, "bought-token", page)).toBe(true);
      expect(await page.locator("#go").isDisabled()).toBe(false);
      expect(
        await page.evaluate(() =>
          (
            window as unknown as { grecaptcha: { getResponse: (id: number) => string } }
          ).grecaptcha.getResponse(0),
        ),
      ).toBe("bought-token");
    } finally {
      await page.close();
    }
  });

  it("does not reuse a response after the checkbox reports challenge expiry", async () => {
    const page = await context.newPage();
    try {
      await page.route("**://www.google.com/recaptcha/api2/anchor**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "Verification challenge expired. Check the checkbox again.",
        }),
      );
      await page.goto(
        `data:text/html,${encodeURIComponent(`<textarea name="g-recaptcha-response">old-token</textarea><iframe src="${ANCHOR_URL}"></iframe>`)}`,
      );
      await expect.poll(() => page.frames().length).toBe(2);
      const controller = BrowserController.fromHarnessPage(page);
      expect(await hasCaptchaResponseTokenForVariant(controller, "recaptcha_v2", page)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("treats a hidden hCaptcha challenge iframe as not rendered until visible", async () => {
    const page = await context.newPage();
    try {
      await page.route("**://newassets.hcaptcha.com/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<div>hcaptcha challenge</div>" }),
      );
      await page.setContent(`<!doctype html><html><body>
        <iframe id="hc" width="400" height="580" style="visibility:hidden;position:fixed;top:20px;left:20px"
          src="https://newassets.hcaptcha.com/captcha/v1/test/static/hcaptcha-challenge.html"></iframe>
      </body></html>`);
      await expect
        .poll(() => page.frames().some((f) => f.url().includes("hcaptcha-challenge.html")))
        .toBe(true);
      const controller = BrowserController.fromHarnessPage(page);
      expect(await detectCaptchaVariant(controller, page)).toMatchObject({
        variant: "hcaptcha",
        challengeRendered: false,
      });

      await page.locator("#hc").evaluate((el) => {
        (el as HTMLElement).style.visibility = "visible";
      });
      expect(await detectCaptchaVariant(controller, page)).toMatchObject({
        variant: "hcaptcha",
        challengeRendered: true,
      });
    } finally {
      await page.close();
    }
  });

  it("classifies embedded Tavily-style Turnstile widgets as deferrable and blocking gates as immediate", async () => {
    const page = await context.newPage();
    try {
      await page.route("**://challenges.cloudflare.com/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<div>turnstile widget</div>" }),
      );
      const controller = BrowserController.fromHarnessPage(page);

      // 1. Tavily-style login page: Turnstile mounted inside email form alongside Google OAuth.
      await page.setContent(`<!doctype html><html><head><title>Log in | Tavily</title></head><body>
        <main>
          <h1>Welcome</h1>
          <form action="/u/login" method="POST">
            <input type="email" name="username" placeholder="Email address" />
            <div class="cf-turnstile" data-sitekey="0x4AAAAAAAAAAAAAAAAAAAAA">
              <iframe width="300" height="65"
                src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/widget"></iframe>
              <input type="hidden" name="cf-turnstile-response" value="" />
            </div>
            <button type="submit">Continue</button>
          </form>
          <button type="button">Continue with Google</button>
        </main>
      </body></html>`);
      await expect
        .poll(() => page.frames().some((f) => f.url().includes("challenges.cloudflare.com")))
        .toBe(true);
      const tavily = await detectCaptchaVariant(controller, page);
      expect(tavily).toMatchObject({
        variant: "turnstile",
        turnstile: {
          interstitial: false,
          widgetVisible: true,
          embeddedInForm: true,
          hasPageControls: true,
        },
      });
      expect(shouldDeferUnengagedTurnstile(tavily.turnstile!)).toBe(true);

      // 2. Invisible/interaction-only Turnstile on an untouched non-interstitial page.
      await page.setContent(`<!doctype html><html><head><title>App</title></head><body>
        <div class="cf-turnstile" data-sitekey="0x4AAAAAAAAAAAAAAAAAAAAA" data-appearance="interaction-only">
          <input type="hidden" name="cf-turnstile-response" value="" />
        </div>
        <a href="/about">About</a>
      </body></html>`);
      const invisible = await detectCaptchaVariant(controller, page);
      expect(invisible).toMatchObject({
        variant: "turnstile",
        turnstile: {
          interstitial: false,
          widgetVisible: false,
          embeddedInForm: false,
          hasPageControls: false,
        },
      });
      expect(shouldDeferUnengagedTurnstile(invisible.turnstile!)).toBe(true);

      // 3. Full-page Cloudflare interstitial ("Just a moment...").
      await page.setContent(`<!doctype html><html><head><title>Just a moment...</title></head><body>
        <h1>example.com</h1>
        <p>Verifying you are human. This may take a few seconds.</p>
        <form id="challenge-form" action="/login?__cf_chl_f_tk=abc" method="POST">
          <div id="challenge-stage">
            <iframe width="300" height="65"
              src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/interstitial"></iframe>
            <input type="hidden" name="cf-turnstile-response" value="" />
          </div>
        </form>
      </body></html>`);
      await expect
        .poll(() => page.frames().some((f) => f.url().includes("challenges.cloudflare.com")))
        .toBe(true);
      const interstitial = await detectCaptchaVariant(controller, page);
      expect(interstitial).toMatchObject({
        variant: "turnstile",
        turnstile: {
          interstitial: true,
          widgetVisible: true,
          embeddedInForm: false,
          hasPageControls: false,
        },
      });
      expect(shouldDeferUnengagedTurnstile(interstitial.turnstile!)).toBe(false);

      // 4. Standalone visible blocking Turnstile gate (no interstitial copy, no other form/OAuth controls),
      // including footer/social links naming providers like GitHub or Discord.
      await page.setContent(`<!doctype html><html><head><title>Security check</title></head><body>
        <h1>Verify you are human</h1>
        <form action="/verify" method="POST">
          <div class="cf-turnstile" data-sitekey="0x4AAAAAAAAAAAAAAAAAAAAA">
            <iframe width="300" height="65"
              src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/gate"></iframe>
            <input type="hidden" name="cf-turnstile-response" value="" />
          </div>
          <button type="submit">Continue</button>
        </form>
        <footer>
          <a href="https://github.com/example/app">Star us on GitHub</a>
          <a href="https://discord.gg/example">Join our Discord</a>
        </footer>
        <div><a href="https://github.com/example/app">GitHub</a></div>
      </body></html>`);
      await expect
        .poll(() => page.frames().some((f) => f.url().includes("challenges.cloudflare.com")))
        .toBe(true);
      const standalone = await detectCaptchaVariant(controller, page);
      expect(standalone).toMatchObject({
        variant: "turnstile",
        turnstile: {
          interstitial: false,
          widgetVisible: true,
          embeddedInForm: false,
          hasPageControls: false,
        },
      });
      expect(shouldDeferUnengagedTurnstile(standalone.turnstile!)).toBe(false);
    } finally {
      await page.close();
    }
  });
});
