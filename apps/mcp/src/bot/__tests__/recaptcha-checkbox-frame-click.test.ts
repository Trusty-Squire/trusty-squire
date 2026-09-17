// Real-Chromium regression for the reCAPTCHA v2 CHECKBOX activation
// (Kaggle email-signup shape, fm/ts-recaptcha-checkbox-not-activatable).
//
// Two invariants pinned together, because a standalone mock of either one
// passes while the other still bites:
//
// 1. OBSERVATION SURFACES, ACT REFUSES. The DOM capture attaches every
//    rendered frame by layout (including captcha frames), so the anchor
//    frame's "I'm not a robot" checkbox shows up as an ordinary el_table
//    row with frameOrigin/framePath — but resolveFrameElementInFrame
//    refused every captcha-scoped frame, so the operate-path click on that
//    row died as a misleading `click target detached before dispatch`
//    without ever dispatching. Kaggle's anchor iframe (api2/anchor) is a
//    real cross-site OOPIF, so resolution-by-path (not the frame map) is
//    what must allow it. The one exception is scoped to REAL-MOUSE clicks
//    into the checkbox frame itself; challenge frames (api2/bframe) keep
//    refusing on every intent, and synthetic js clicks stay refused.
//
// 2. OFFSCREEN bframe ≠ RENDERED CHALLENGE. reCAPTCHA pre-positions its
//    hidden challenge frame at top:-9999px with a real 300x150 box on
//    embeds like Kaggle's, so a size-only visibility check read a bare
//    checkbox as challengeRendered=true — exactly the escalation the
//    auto-solver spends the funded 2Captcha key on. Rendered now requires
//    the challenge frame to overlap the viewport.
//
// The mock widget mirrors the live shape: the anchor frame only signals
// "challenge rendered" (parent moves the bframe on-screen) on a TRUSTED
// click (event.isTrusted), mirroring reCAPTCHA's untrusted-event refusal.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectCaptchaVariant } from "../captcha.js";
import { BrowserController, BrowserClickDispatchError } from "../browser.js";

const GOOGLE_ANCHOR_URL =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Ltestsitekey0000000000000000&co=aHR0cHM&hl=en";
const GOOGLE_BFRAME_URL =
  "https://www.google.com/recaptcha/api2/bframe?ar=1&k=6Ltestsitekey0000000000000000&hl=en";

const ANCHOR_HTML = `<!doctype html><html><body style="margin:0">
<button id="recaptcha-anchor" role="checkbox" aria-checked="false"
  style="width:100%;height:100%;font-size:14px">I'm not a robot</button>
<script>
  document.getElementById("recaptcha-anchor").addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    document.getElementById("recaptcha-anchor").setAttribute("aria-checked", "true");
    window.parent.postMessage("ts-mock-challenge-rendered", "*");
  });
</script>
</body></html>`;

const BFRAME_HTML = `<!doctype html><html><body style="margin:0">
<div id="challenge-grid">mock image grid</div>
</body></html>`;

const PARENT_HTML = `<!doctype html><html><body style="margin:0">
<form><input name="email" type="email"><button type="submit">Sign up</button></form>
<iframe id="rc-anchor" title="reCAPTCHA checkbox" width="304" height="78"
  style="margin-top:400px" src="${GOOGLE_ANCHOR_URL}"></iframe>
<iframe id="rc-bframe" title="recaptcha challenge expires in two minutes" width="300" height="150"
  style="position:absolute;top:-9999px;left:1px" src="${GOOGLE_BFRAME_URL}"></iframe>
<script>
  window.addEventListener("message", (event) => {
    if (event.data !== "ts-mock-challenge-rendered") return;
    document.getElementById("rc-bframe").style.top = "200px";
  });
</script>
</body></html>`;

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

describe.skipIf(!available)("recaptcha v2 checkbox frame click (Kaggle shape)", () => {
  let server: Server;
  let baseUrl = "";
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PARENT_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/signup`;
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Fulfill the cross-origin widget frames locally: the frame KEEPS its
    // google.com URL (so OOPIF + captcha-URL classification are exercised
    // for real) while the documents are deterministic mocks.
    await context.route("**://www.google.com/recaptcha/api2/anchor**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: ANCHOR_HTML }),
    );
    await context.route("**://www.google.com/recaptcha/api2/bframe**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: BFRAME_HTML }),
    );
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bare checkbox reads as unrendered; the surfaced row click toggles it; challenge then renders", async () => {
    const page: Page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const waitForMockAnchor = async (p: Page) => {
      await expect
        .poll(
          async () => {
            const f = p
              .frames()
              .find((fr) => fr.url().startsWith("https://www.google.com/recaptcha/api2/anchor"));
            if (f === undefined) return false;
            return (await f.locator("#recaptcha-anchor").count()) > 0;
          },
          { timeout: 15_000, intervals: [250, 500] },
        )
        .toBe(true);
    };
    await waitForMockAnchor(page);
    const controller = BrowserController.fromHarnessPage(page);

    // Invariant 2 first: the offscreen-but-sized bframe is NOT a rendered
    // challenge. The pre-fix size-only check reported true here and made
    // the auto-solver spend on a bare checkbox.
    const before = await detectCaptchaVariant(controller, page);
    expect(before.variant).toBe("recaptcha_v2");
    expect(before.challengeRendered).toBe(false);

    // The capture surfaces the anchor frame's checkbox row (attachFrames has
    // no captcha skip), exactly like Kaggle's live observation did.
    const capture = await controller.extractBrowserUseObservation(page, false);
    const checkboxRow = capture.elements.find(
      (el) =>
        el.frameOrigin === "https://www.google.com" &&
        (el.id === "recaptcha-anchor" ||
          el.selector.includes("recaptcha-anchor") ||
          el.role === "checkbox"),
    );
    expect(checkboxRow).toBeDefined();
    expect(checkboxRow!.framePath).not.toBeNull();

    // The operate-path click on that row must dispatch (pre-fix it died as
    // "click target detached before dispatch" because the captcha-scoped
    // frame refused resolution).
    await controller.click({
      kind: "frame",
      frame: {
        framePath: checkboxRow!.framePath!,
        frameOrigin: checkboxRow!.frameOrigin!,
        frameUrl: checkboxRow!.frameUrl ?? "",
      },
      selector: checkboxRow!.selector,
      method: "click",
    });

    // Trusted click landed: the mock anchor flipped and the parent moved the
    // challenge frame into the viewport (the real widget renders the grid).
    await expect
      .poll(
        async () => {
          const f = page
            .frames()
            .find((fr) => fr.url().startsWith("https://www.google.com/recaptcha/api2/anchor"));
          if (f === undefined) return null;
          return f.getAttribute("#recaptcha-anchor", "aria-checked").catch(() => null);
        },
        { timeout: 10_000, intervals: [250, 500] },
      )
      .toBe("true");
    // The parent moves the challenge frame on-screen only after the queued
    // postMessage lands — poll rather than read once.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const r = document
              .querySelector<HTMLIFrameElement>("#rc-bframe")!
              .getBoundingClientRect();
            return { top: r.top, height: r.height };
          }),
        { timeout: 10_000, intervals: [100, 250] },
      )
      .toSatisfy((b: { top: number; height: number }) => b.top > 0 && b.height > 30);

    const after = await detectCaptchaVariant(controller, page);
    expect(after.challengeRendered).toBe(true);
    await page.close();
  });

  it("still refuses challenge-frame clicks and synthetic js clicks into the checkbox frame", async () => {
    const page: Page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await expect
      .poll(
        async () => {
          const f = page
            .frames()
            .find((fr) => fr.url().startsWith("https://www.google.com/recaptcha/api2/anchor"));
          if (f === undefined) return false;
          return (await f.locator("#recaptcha-anchor").count()) > 0;
        },
        { timeout: 15_000, intervals: [250, 500] },
      )
      .toBe(true);
    const controller = BrowserController.fromHarnessPage(page);

    // The challenge frame keeps refusing every intent.
    await expect(
      controller.click({
        kind: "frame",
        frame: { framePath: "0:1", frameOrigin: "https://www.google.com", frameUrl: GOOGLE_BFRAME_URL },
        selector: "#challenge-grid",
        method: "click",
      }),
    ).rejects.toThrow(/no longer present|detached/i);

    // Synthetic js clicks into the checkbox frame stay refused: reCAPTCHA
    // ignores untrusted events, so a resolved-but-no-op click would report
    // success the widget then contradicts.
    await expect(
      controller.click({
        kind: "frame",
        frame: { framePath: "0:0", frameOrigin: "https://www.google.com", frameUrl: GOOGLE_ANCHOR_URL },
        selector: "#recaptcha-anchor",
        method: "js_click",
      }),
    ).rejects.toThrow(/no longer present|detached/i);
    await page.close();
  });
});
