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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectCaptchaVariant, TwoCaptchaSolver } from "../captcha.js";
import { attemptOperateCaptchaAutoSolve } from "../captcha-solve.js";
import type { Session } from "../session/model.js";
import { actInternally } from "../act/act.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { finishProvisionSession, startProvisionSession } from "../session/lifecycle.js";
import { BrowserController } from "../browser.js";

// startProvisionSession's admission reads see a signed-in fixture profile.
vi.mock("../oauth-login.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OauthLoginModule>()),
  detectSessionProviders: async () => ["google"],
  detectGoogleAccountEmail: async () => "fixture@example.test",
}));

import type * as OauthLoginModule from "../oauth-login.js";

const SITEKEY = "6LftmFkUAAAAADydGEH99T-xmZoK69ErtRCzfVFf";
const GOOGLE_ANCHOR_URL = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${SITEKEY}&co=aHR0cHM&hl=en`;
const GOOGLE_BFRAME_URL = `https://www.google.com/recaptcha/api2/bframe?ar=1&k=${SITEKEY}&hl=en`;

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
          { timeout: 15_000, interval: 250 },
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
        { timeout: 10_000, interval: 250 },
      )
      .toBe("true");
    // The parent moves the challenge frame on-screen only after the queued
    // postMessage lands — poll rather than read once.
    await expect
      .poll(
        async () => {
          const box = await page.evaluate(() => {
            const r = document
              .querySelector<HTMLIFrameElement>("#rc-bframe")!
              .getBoundingClientRect();
            return { top: r.top, height: r.height };
          });
          return box.top > 0 && box.height > 30;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe(true);

    const after = await detectCaptchaVariant(controller, page);
    expect(after.challengeRendered).toBe(true);
    await page.close();
  }, 120_000);

  it("escalates a visible image grid after a hidden bframe, but not a collapsed grid", async () => {
    const page = await context.newPage();
    const solve = vi
      .spyOn(TwoCaptchaSolver.prototype, "solveRecaptchaV2")
      .mockResolvedValue({ kind: "solver_error", reason: "fixture stop" });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate((src) => {
        const frame = document.createElement("iframe");
        frame.id = "visible-bframe";
        frame.title = "recaptcha challenge expires in two minutes";
        frame.src = src;
        frame.style.cssText = "position:fixed;top:120px;left:120px;width:400px;height:580px";
        document.body.append(frame);
      }, GOOGLE_BFRAME_URL);
      await expect
        .poll(() => page.frames().filter((f) => f.url() === GOOGLE_BFRAME_URL).length)
        .toBe(2);
      const controller = BrowserController.fromHarnessPage(page);
      const session = () =>
        ({
          id: "fixture-recaptcha",
          browser: controller,
          releasedPaymentCard: null,
          api: {
            listCredentials: async () => ({ credentials: [{ service: "2captcha" }] }),
            useCredential: async () => {
              throw new Error("unexpected network request");
            },
          },
        }) as unknown as Session;

      expect(await detectCaptchaVariant(controller, page)).toMatchObject({
        variant: "recaptcha_v2",
        challengeRendered: true,
        recaptcha: { challengeFrameVisible: true },
      });

      // Move the displayed frame into a shadow root: the main-document
      // selector now sees only the parked bframe, while the frame tree still
      // exposes the displayed grid.
      await page.evaluate(() => {
        const host = document.createElement("div");
        document.body.append(host);
        host.attachShadow({ mode: "open" }).append(document.querySelector("#visible-bframe")!);
      });
      expect(await detectCaptchaVariant(controller, page)).toMatchObject({
        variant: "recaptcha_v2",
        challengeRendered: true,
        recaptcha: { challengeFrameVisible: true },
      });
      expect(await attemptOperateCaptchaAutoSolve(session(), page)).toBe("fetch_started");
      await expect.poll(() => solve.mock.calls.length).toBe(1);

      await page.locator("#visible-bframe").evaluate((frame) => {
        (frame as HTMLElement).style.display = "none";
      });
      expect(await detectCaptchaVariant(controller, page)).toMatchObject({
        variant: "recaptcha_v2",
        challengeRendered: false,
        recaptcha: { challengeFrameVisible: false },
      });
      expect(await attemptOperateCaptchaAutoSolve(session(), page)).toBe("no_challenge");
      expect(solve).toHaveBeenCalledTimes(1);
    } finally {
      solve.mockRestore();
      await page.close();
    }
  }, 60_000);

  it("clicks an hCaptcha checkbox ref after its iframe remounts", async () => {
    const page = await context.newPage();
    const hcaptchaUrl = "https://newassets.hcaptcha.com/captcha/v1/checkbox.html?sitekey=fixture";
    await context.route("**://newassets.hcaptcha.com/captcha/v1/checkbox.html**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button id="checkbox" role="checkbox" aria-checked="false">Verify you are human</button><script>document.querySelector("button").onclick = () => document.querySelector("button").setAttribute("aria-checked", "true")</script>',
      }),
    );
    await page.setContent(
      `<iframe id="hc" title="hCaptcha checkbox" src="${hcaptchaUrl}"></iframe>`,
    );
    await expect
      .poll(async () => page.frames().some((frame) => frame.url() === hcaptchaUrl))
      .toBe(true);
    const controller = BrowserController.fromHarnessPage(page);
    const captured = await controller.extractBrowserUseObservation(page, false);
    const checkbox = captured.elements.find((element) => element.id === "checkbox");
    expect(checkbox?.framePath).toBeTruthy();
    const internals = controller as unknown as {
      resolveFrameElement: (...args: unknown[]) => Promise<unknown>;
    };
    const originalResolve = internals.resolveFrameElement.bind(controller);
    let remounted = false;
    internals.resolveFrameElement = async (...args) => {
      const handle = await originalResolve(...args);
      if (handle !== null && !remounted) {
        remounted = true;
        await page.locator("#hc").evaluate((frame) => frame.replaceWith(frame.cloneNode(true)));
        await expect
          .poll(async () => {
            const frame = page.frames().find((candidate) => candidate.url() === hcaptchaUrl);
            return frame !== undefined && (await frame.locator("#checkbox").count()) > 0;
          })
          .toBe(true);
      }
      return handle;
    };
    await controller.click({
      kind: "frame",
      frame: {
        framePath: checkbox!.framePath!,
        frameOrigin: checkbox!.frameOrigin!,
        frameUrl: checkbox!.frameUrl ?? "",
      },
      selector: checkbox!.selector,
      method: "click",
    });
    const liveFrame = page.frames().find((frame) => frame.url() === hcaptchaUrl)!;
    expect(await liveFrame.locator("#checkbox").getAttribute("aria-checked")).toBe("true");
    expect(remounted).toBe(true);
    await page.close();
  }, 30_000);

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
        { timeout: 15_000, interval: 250 },
      )
      .toBe(true);
    const controller = BrowserController.fromHarnessPage(page);

    // The challenge frame keeps refusing every intent.
    await expect(
      controller.click({
        kind: "frame",
        frame: {
          framePath: "0:1",
          frameOrigin: "https://www.google.com",
          frameUrl: GOOGLE_BFRAME_URL,
        },
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
        frame: {
          framePath: "0:0",
          frameOrigin: "https://www.google.com",
          frameUrl: GOOGLE_ANCHOR_URL,
        },
        selector: "#recaptcha-anchor",
        method: "js_click",
      }),
    ).rejects.toThrow(/no longer present|detached/i);

    // The locator escape hatch (text=/css= → resolvePageTarget) honors the
    // same rule: a js_click locator must NOT resolve inside the anchor frame
    // (otherwise the resolved handle would be dispatched as an untrusted
    // synthetic click that reCAPTCHA ignores while the action reports
    // success), while a real-mouse click locator still resolves there.
    const jsLocator = await controller.resolvePageTarget(
      "css",
      "#recaptcha-anchor",
      "js_click",
      page,
    );
    expect(jsLocator.ok).toBe(false);
    const jsLocatorText = await controller.resolvePageTarget(
      "text",
      "I'm not a robot",
      "js_click",
      page,
    );
    expect(jsLocatorText.ok).toBe(false);
    const clickLocator = await controller.resolvePageTarget(
      "css",
      "#recaptcha-anchor",
      "click",
      page,
    );
    expect(clickLocator.ok).toBe(true);
    if (clickLocator.ok) await clickLocator.handle.dispose().catch(() => undefined);
    await page.close();
  }, 120_000);

  it("operate_act locator dispatch honors the trust rule: js_click refuses, real click toggles", async () => {
    // This drives the FULL operate_act locator path (act.ts →
    // resolvePageTarget → dispatch), not just the BrowserController
    // primitives: the original leak was act.ts mapping a js_click locator to
    // the trusted "click" resolution intent, so the anchor frame admitted
    // resolution and the synthetic click reported a success reCAPTCHA then
    // contradicted (checkbox untoggled, challenge never rendered).
    const sessionContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await sessionContext.route("**://www.google.com/recaptcha/api2/anchor**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: ANCHOR_HTML }),
    );
    await sessionContext.route("**://www.google.com/recaptcha/api2/bframe**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: BFRAME_HTML }),
    );
    const sessionController = BrowserController.fromHarnessPage(await sessionContext.newPage());
    installBrokerBrowserCustody({
      acquire: async () => ({ browser: sessionController, profileDir: "fixture-only" }),
      cleanupAdmission: async () => true,
      orphanAdmission: async () => {},
      orphan: async () => {},
      release: async (controller, beforeRelease) => {
        await beforeRelease?.();
        await controller.closeOwnPagesOnly();
      },
    });
    let sessionId: string | undefined;
    try {
      const started = await startProvisionSession(
        { serviceUrl: baseUrl },
        {
          observeSession: async (session) => ({
            session_id: session.id,
            url: session.browser.currentUrl(),
            text: "",
            elements: [],
          }),
          compactV2StartMetadata: () => ({}),
        },
      );
      sessionId = started.session_id;

      // A js_click locator into the anchor frame must refuse ("no element
      // matched" — the anchor frame stays unresolvable for untrusted intents).
      await expect(
        actInternally(sessionId, { kind: "js_click", target: "css=#recaptcha-anchor" }, "compact"),
      ).rejects.toThrow(/no element matched/);

      // The real-mouse click locator remains the trusted activation path and
      // actually toggles the widget (the pre-fix lie was a dispatched no-op).
      await actInternally(sessionId, { kind: "click", target: "css=#recaptcha-anchor" }, "compact");
      const anchorFrame = sessionContext
        .pages()[0]!
        .frames()
        .find((fr) => fr.url().startsWith("https://www.google.com/recaptcha/api2/anchor"));
      expect(anchorFrame).toBeDefined();
      await expect
        .poll(
          async () =>
            await anchorFrame!.getAttribute("#recaptcha-anchor", "aria-checked").catch(() => null),
          { timeout: 10_000, interval: 250 },
        )
        .toBe("true");
    } finally {
      if (sessionId !== undefined) {
        await finishProvisionSession(sessionId).catch(() => undefined);
      }
      await sessionContext.close();
    }
  }, 60_000);
});
