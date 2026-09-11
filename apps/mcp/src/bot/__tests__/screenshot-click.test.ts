import { chromium, type Browser } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import { clickScreenshot, type ScreenshotPoint } from "../screenshot-click.js";
import {
  startHarnessProvisionSession,
  finishProvisionSession,
  captureScreenshot,
  observe,
  observeQuery,
} from "../provision-session.js";
import { paymentSession } from "../session/lifecycle.js";
import { operateClickTool } from "../../tools/provision-drive.js";
import {
  operatorMutationDispatchPhase,
  withOperatorRequestContext,
} from "../request-cancellation.js";

let browser: Browser;
// Opt-in product evidence from isolated fixtures; ordinary test runs write nothing.
async function evidence(name: string, data: string | Buffer) {
  const directory = process.env.SCREENSHOT_CLICK_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), data);
}
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
async function fixture(
  scale = 1,
  closedFrame = false,
  fixtureBrowser = browser,
  parentMarkup = "",
) {
  const context = await fixtureBrowser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  await page.route("http://**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().includes("child.test")
        ? `<div id="host"></div><script>const s=document.querySelector('#host').attachShadow({mode:'closed'});s.innerHTML='<label><input type="checkbox" style="width:24px;height:24px">Verify you are human</label>';window.events=[];s.querySelector('input').addEventListener('click',e=>window.events.push({trusted:e.isTrusted,checked:e.target.checked}));</script>`
        : '<style>body{margin:0;height:1600px}iframe{position:absolute;left:150px;top:220px;width:300px;height:100px;border:0}</style><iframe src="http://child.test/frame"></iframe>' +
          parentMarkup,
    }),
  );
  await page.goto("http://parent.test/");
  if (closedFrame) {
    const frameNavigation = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame.url().includes("child.test"),
    });
    await page.evaluate(() => {
      document.querySelector("iframe")!.remove();
      const host = document.createElement("div");
      document.body.append(host);
      host.attachShadow({ mode: "closed" }).innerHTML =
        '<iframe style="position:absolute;left:150px;top:220px;width:300px;height:100px;border:0" src="http://child.test/frame"></iframe>';
    });
    await frameNavigation;
  }
  const frame = page.frames().find((f) => f.url().includes("child.test"))!;
  await frame.waitForSelector("#host");
  const controller = BrowserController.fromHarnessPage(page);
  return {
    page,
    get frame() {
      return page.frames().find((f) => f.url().includes("child.test"))!;
    },
    controller,
    close: () => context.close(),
  };
}
function point(
  shot: Awaited<ReturnType<BrowserController["captureOperatorScreenshot"]>>,
  x: number,
  y: number,
) {
  expect(shot.clickBinding).toBeDefined();
  return { screenshot_id: shot.clickBinding!.screenshot_id, x, y };
}

describe("screenshot-bound native pointer dispatch", () => {
  it.each(["button", "descendant", "unrelated"] as const)(
    "binds control text while allowing %s text changes",
    async (change) => {
      const f = await fixture();
      try {
        await f.page.evaluate(() => {
          document.body.innerHTML =
            '<button style="position:absolute;left:150px;top:220px;width:160px;height:60px"><span style="display:block;width:100%;height:100%">Continue</span></button><p>Waiting</p>';
        });
        const shot = await f.controller.captureOperatorScreenshot();
        await f.page.evaluate((change) => {
          const el = document.querySelector(change === "unrelated" ? "p" : "span")!;
          el.firstChild!.nodeValue = "Delete account";
        }, change);
        const mouse = vi.spyOn(f.page.mouse, "click");
        const authorize = vi.fn();
        const result = clickScreenshot(
          f.page,
          point(shot, change === "button" ? 152 : 174, 244),
          authorize,
        );
        if (change === "unrelated") {
          await expect(result).resolves.toBe("dispatched");
          expect(mouse).toHaveBeenCalledOnce();
        } else {
          await expect(result).rejects.toMatchObject({
            code: "stale_screenshot",
            dispatch: "not_dispatched",
          });
          expect(authorize).not.toHaveBeenCalled();
          expect(mouse).not.toHaveBeenCalled();
        }
      } finally {
        vi.restoreAllMocks();
        await f.close();
      }
    },
  );

  it.each([
    ["wrapping", "associated"],
    ["explicit", "associated"],
    ["wrapping", "unrelated"],
    ["explicit", "unrelated"],
  ] as const)("binds %s checkbox labels when %s text changes", async (kind, change) => {
    const f = await fixture();
    try {
      await f.page.evaluate((kind) => {
        const input =
          '<input id="choice" type="checkbox" style="position:absolute;left:150px;top:220px;width:24px;height:24px;margin:0">';
        document.body.innerHTML =
          (kind === "wrapping"
            ? `<label>${input}<span id="caption">Enable alerts</span></label>`
            : `${input}<label for="choice"><span id="caption">Enable alerts</span></label>`) +
          '<label for="other"><span id="unrelated">Other choice</span></label><input id="other" type="checkbox">';
      }, kind);
      const shot = await f.controller.captureOperatorScreenshot();
      await f.page.locator(change === "associated" ? "#caption" : "#unrelated").evaluate((el) => {
        el.firstChild!.nodeValue = "Share activity";
      });
      const mouse = vi.spyOn(f.page.mouse, "click");
      const authorize = vi.fn();
      const result = clickScreenshot(f.page, point(shot, 162, 232), authorize);
      if (change === "associated") {
        await expect(result).rejects.toMatchObject({
          code: "stale_screenshot",
          dispatch: "not_dispatched",
        });
        expect(mouse).not.toHaveBeenCalled();
        expect(authorize).not.toHaveBeenCalled();
        expect(await f.page.locator("#choice").isChecked()).toBe(false);
      } else {
        await expect(result).resolves.toBe("dispatched");
        expect(mouse).toHaveBeenCalledOnce();
        expect(await f.page.locator("#choice").isChecked()).toBe(true);
      }
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });

  it.each(["remove", "hide", "move", "unrelated"] as const)(
    "preserves captured occlusion identity when an overlay changes: %s",
    async (change) => {
      const f = await fixture();
      try {
        await f.page.evaluate(() => {
          document.body.innerHTML =
            '<button id="under" style="position:absolute;left:150px;top:220px;width:160px;height:60px">Underlying action</button><button id="overlay" style="position:absolute;left:150px;top:220px;width:160px;height:60px;z-index:2">Overlay action</button><p id="unrelated">Waiting</p>';
          (window as unknown as { clicks: string[] }).clicks = [];
          document.querySelectorAll("button").forEach(
            (button) =>
              (button.onclick = () => {
                (window as unknown as { clicks: string[] }).clicks.push(button.id);
              }),
          );
        });
        const shot = await f.controller.captureOperatorScreenshot();
        await f.page.evaluate((change) => {
          const overlay = document.querySelector<HTMLElement>("#overlay")!;
          if (change === "remove") overlay.remove();
          if (change === "hide") overlay.style.visibility = "hidden";
          if (change === "move") overlay.style.left = "350px";
          if (change === "unrelated") document.querySelector("#unrelated")!.textContent = "Ready";
        }, change);
        const mouse = vi.spyOn(f.page.mouse, "click");
        const authorize = vi.fn();
        const result = clickScreenshot(f.page, point(shot, 174, 244), authorize);
        if (change === "unrelated") {
          await expect(result).resolves.toBe("dispatched");
          expect(await f.page.evaluate("window.clicks")).toEqual(["overlay"]);
        } else {
          await expect(result).rejects.toMatchObject({
            code: "stale_screenshot",
            dispatch: "not_dispatched",
          });
          expect(mouse).not.toHaveBeenCalled();
          expect(authorize).not.toHaveBeenCalled();
          expect(await f.page.evaluate("window.clicks")).toEqual([]);
          if (change === "remove") {
            await evidence("overlay-captured.png", Buffer.from(shot.base64, "base64"));
            await evidence("overlay-removed.png", await f.page.screenshot());
            await evidence(
              "overlay-refusal.json",
              JSON.stringify(
                {
                  request: point(shot, 174, 244),
                  error: await result.catch((error) => ({
                    code: error.code,
                    dispatch: error.dispatch,
                  })),
                  observedClicks: await f.page.evaluate("window.clicks"),
                },
                null,
                2,
              ),
            );
          }
        }
      } finally {
        vi.restoreAllMocks();
        await f.close();
      }
    },
  );

  it("cancels during final geometry before authorization or input", async () => {
    const f = await fixture();
    try {
      const shot = await f.controller.captureOperatorScreenshot();
      const controller = new AbortController();
      const reason = new Error("cancelled during final geometry");
      const frameElement = f.frame.frameElement.bind(f.frame);
      vi.spyOn(f.frame, "frameElement").mockImplementation(async () => {
        const handle = await frameElement();
        const boundingBox = handle.boundingBox.bind(handle);
        vi.spyOn(handle, "boundingBox").mockImplementation(async () => {
          const result = await boundingBox();
          if (operatorMutationDispatchPhase() === "dispatch_attempted") controller.abort(reason);
          return result;
        });
        return handle;
      });
      const mouse = vi.spyOn(f.page.mouse, "click");
      const authorize = vi.fn();
      await expect(
        withOperatorRequestContext(controller.signal, () =>
          clickScreenshot(f.page, point(shot, 174, 244), authorize),
        ),
      ).rejects.toBe(reason);
      expect(controller.signal.aborted).toBe(true);
      expect(authorize).not.toHaveBeenCalled();
      expect(mouse).not.toHaveBeenCalled();
      expect(await f.frame.evaluate("window.events")).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });

  it.each([1, 2])(
    "clicks a closed-shadow cross-origin framed checkbox at DPR %s",
    async (scale) => {
      const f = await fixture(scale);
      try {
        const shot = await f.controller.captureOperatorScreenshot();
        const authorize = vi.fn();
        const p = point(
          shot,
          (174 * shot.clickBinding!.width) / 800,
          (244 * shot.clickBinding!.height) / 600,
        );
        await withOperatorRequestContext(new AbortController().signal, async () => {
          expect(await clickScreenshot(f.page, p, authorize)).toBe("dispatched");
          expect(operatorMutationDispatchPhase()).toBe("dispatch_attempted");
        });
        expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
        if (scale === 1) {
          await evidence("closed-shadow-captured.png", Buffer.from(shot.base64, "base64"));
          await evidence("closed-shadow-clicked.png", await f.page.screenshot());
          await evidence(
            "native-click-events.json",
            JSON.stringify(await f.frame.evaluate("window.events"), null, 2),
          );
        }
        expect(authorize).toHaveBeenCalledWith(
          expect.objectContaining({ frameOrigin: "http://child.test", mainFrame: false }),
        );
        await expect(clickScreenshot(f.page, p, authorize)).rejects.toMatchObject({
          code: "stale_screenshot",
          dispatch: "not_dispatched",
        });
      } finally {
        await f.close();
      }
    },
  );
  it("dispatches through an iframe owned by a closed shadow root", async () => {
    const f = await fixture(1, true);
    try {
      const shot = await f.controller.captureOperatorScreenshot();
      await clickScreenshot(f.page, point(shot, 174, 244), () => {});
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
    } finally {
      await f.close();
    }
  });

  it("dispatches into a frame with its own CDP renderer session", async () => {
    const isolatedBrowser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
    const f = await fixture(1, false, isolatedBrowser);
    try {
      const frameSession = await f.page.context().newCDPSession(f.frame);
      const tree = await frameSession.send("Page.getFrameTree");
      expect(tree.frameTree.frame.url).toBe("http://child.test/frame");
      const shot = await f.controller.captureOperatorScreenshot();
      await clickScreenshot(f.page, point(shot, 174, 244), () => {});
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
      await frameSession.detach();
    } finally {
      await f.close();
      await isolatedBrowser.close();
    }
  });

  it("transforms a zoomed visual viewport to native CSS pointer coordinates", async () => {
    const f = await fixture();
    try {
      const cdp = await f.page.context().newCDPSession(f.page);
      await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
      const shot = await f.controller.captureOperatorScreenshot();
      await clickScreenshot(f.page, point(shot, 348, 488), () => {});
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
      await cdp.detach();
    } finally {
      await f.close();
    }
  });

  it("transforms frame-cropped pixels after page scroll", async () => {
    const f = await fixture(2);
    try {
      await f.page.evaluate(async () => {
        scrollTo(0, 100);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const shot = await f.controller.captureOperatorScreenshot({ frameUrlContains: "child.test" });
      await clickScreenshot(
        f.page,
        point(shot, (24 * shot.clickBinding!.width) / 300, (24 * shot.clickBinding!.height) / 100),
        () => {},
      );
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
    } finally {
      await f.close();
    }
  });
  it("transforms full-page pixels to the current viewport", async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(async () => {
        scrollTo(0, 100);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const shot = await f.controller.captureOperatorScreenshot({ fullPage: true });
      await clickScreenshot(f.page, point(shot, 174, 244), () => {});
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
    } finally {
      await f.close();
    }
  });
  it.each(["viewport", "navigation", "frame-navigation", "scroll", "frame-move"] as const)(
    "rejects %s changes without input dispatch",
    async (change) => {
      const f = await fixture();
      try {
        const shot = await f.controller.captureOperatorScreenshot();
        if (change === "viewport") await f.page.setViewportSize({ width: 900, height: 600 });
        if (change === "navigation") await f.page.reload();
        if (change === "frame-navigation") await f.frame.goto("http://child.test/other");
        if (change === "scroll") await f.page.evaluate(() => scrollTo(0, 20));
        if (change === "frame-move")
          await f.page.locator("iframe").evaluate((el) => {
            el.style.left = "200px";
          });
        const mouse = vi.spyOn(f.page.mouse, "click");
        await expect(
          clickScreenshot(f.page, point(shot, 174, 244), () => {}),
        ).rejects.toMatchObject({ code: "stale_screenshot", dispatch: "not_dispatched" });
        expect(mouse).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
  it("consumes an uncertain dispatched click and refuses replay", async () => {
    const f = await fixture();
    try {
      const shot = await f.controller.captureOperatorScreenshot();
      const original = f.page.mouse.click.bind(f.page.mouse);
      const mouse = vi.spyOn(f.page.mouse, "click").mockImplementation(async (x, y) => {
        await original(x, y);
        throw new Error("transport lost after dispatch");
      });
      const p = point(shot, 174, 244);
      await expect(clickScreenshot(f.page, p, () => {})).rejects.toMatchObject({
        code: "screenshot_click_uncertain",
        dispatch: "unknown",
      });
      await expect(clickScreenshot(f.page, p, () => {})).rejects.toMatchObject({
        code: "stale_screenshot",
        dispatch: "not_dispatched",
      });
      expect(mouse).toHaveBeenCalledTimes(1);
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
    } finally {
      await f.close();
    }
  });
  it("keeps authorization before dispatch and consumes concurrent/rejected attempts", async () => {
    const f = await fixture();
    try {
      const shot = await f.controller.captureOperatorScreenshot();
      const p = point(shot, 174, 244);
      const mouse = vi.spyOn(f.page.mouse, "click");
      await expect(
        clickScreenshot(f.page, p, () => {
          throw new Error("existing payment guard");
        }),
      ).rejects.toThrow("existing payment guard");
      await expect(clickScreenshot(f.page, p, () => {})).rejects.toMatchObject({
        code: "stale_screenshot",
      });
      expect(mouse).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(["move", "replace"] as const)(
    "rejects actual target %s despite stable frame geometry",
    async (change) => {
      const f = await fixture();
      try {
        const shot = await f.controller.captureOperatorScreenshot();
        await f.frame.evaluate((change) => {
          const host = document.querySelector("#host")!;
          if (change === "move") host.setAttribute("style", "padding-left:5px");
          else
            host.outerHTML =
              '<div id="host"><input type="checkbox" style="width:24px;height:24px"></div>';
        }, change);
        const mouse = vi.spyOn(f.page.mouse, "click");
        await expect(
          clickScreenshot(f.page, point(shot, 174, 244), () => {}),
        ).rejects.toMatchObject({ code: "stale_screenshot" });
        expect(mouse).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it("rejects competing clicks, superseded images and out-of-image points", async () => {
    const f = await fixture();
    try {
      const first = await f.controller.captureOperatorScreenshot();
      const second = await f.controller.captureOperatorScreenshot();
      await expect(clickScreenshot(f.page, point(first, 174, 244), () => {})).rejects.toMatchObject(
        { code: "stale_screenshot" },
      );
      const p = point(second, 174, 244);
      const results = await Promise.allSettled([
        clickScreenshot(f.page, p, () => {}),
        clickScreenshot(f.page, p, () => {}),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await f.frame.evaluate("window.events")).toHaveLength(1);
      const third = await f.controller.captureOperatorScreenshot();
      await expect(clickScreenshot(f.page, point(third, 900, 244), () => {})).rejects.toMatchObject(
        { code: "invalid_screenshot_point", dispatch: "not_dispatched" },
      );
    } finally {
      await f.close();
    }
  });
});

describe("native screenshot/click tool contract on an isolated session", () => {
  it("preserves DOM visibility, literal roles and blocker evidence after an uncertain screenshot click", async () => {
    const f = await fixture(
      1,
      false,
      browser,
      '<div style="opacity:0"><label>Password<input type="password"></label><button>Show password</button></div><div role="slider" tabindex="0" aria-label="Volume">Volume</div><p>Performing security verification</p>',
    );
    const started = await startHarnessProvisionSession({
      browser: f.controller,
      serviceUrl: "http://parent.test/",
      extraAllowedHosts: ["child.test"],
      observationFormat: "browser-use-dom",
    });
    try {
      const shot = await captureScreenshot(started.session_id);
      const original = f.page.mouse.click.bind(f.page.mouse);
      const mouse = vi.spyOn(f.page.mouse, "click").mockImplementation(async (x, y) => {
        await original(x, y);
        throw new Error("lost acknowledgement after actual input");
      });
      const result = await operateClickTool.handler(
        {
          session_id: started.session_id,
          screenshot: { screenshot_id: shot.click_binding!.screenshot_id, x: 174, y: 244 },
        },
        null,
      );
      expect(result).toMatchObject({
        screenshot_click: { dispatch: "unknown", outcome: "unknown" },
      });
      expect(started.dom).not.toContain("Show password");
      expect(started.dom).toContain("Performing security verification");
      const after = await observe(started.session_id);
      // The browser-use response may be a delta containing only the changed checkbox.
      expect(after.dom).toContain("checked=true");
      const query = await observeQuery(started.session_id, "");
      expect(query.semantic).toMatchObject({ blocked: true });
      expect(JSON.stringify(query.safe_table)).not.toContain("Show password");
      expect(JSON.stringify(query.safe_table)).toContain("slider");
      expect(mouse).toHaveBeenCalledTimes(1);
      expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
    } finally {
      vi.restoreAllMocks();
      await finishProvisionSession(started.session_id);
      await f.close();
    }
  });

  it.each([false, true])(
    "refuses an allowed URL with opaque sandbox origin (inherited=%s)",
    async (nested) => {
      const f = await fixture();
      const started = await startHarnessProvisionSession({
        browser: f.controller,
        serviceUrl: "http://parent.test/",
        extraAllowedHosts: ["child.test"],
        observationFormat: "browser-use-dom",
      });
      try {
        if (nested)
          await f.page.route("http://child.test/frame", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<iframe src="http://child.test/leaf" style="position:absolute;left:0;top:0;width:300px;height:100px;border:0"></iframe>',
            }),
          );
        await f.page
          .locator("iframe")
          .evaluate((el) => el.setAttribute("sandbox", "allow-scripts"));
        await f.frame.goto("http://child.test/frame");
        const target = nested
          ? f.page.frames().find((frame) => frame.url().endsWith("/leaf"))!
          : f.frame;
        await target.waitForSelector("#host");
        expect(await target.evaluate(() => location.origin)).toBe("http://child.test");
        const shot = await captureScreenshot(started.session_id);
        const mouse = vi.spyOn(f.page.mouse, "click");
        await expect(
          operateClickTool.handler(
            {
              session_id: started.session_id,
              screenshot: { screenshot_id: shot.click_binding!.screenshot_id, x: 174, y: 244 },
            },
            null,
          ),
        ).rejects.toThrow("target_not_allowed");
        expect(mouse).not.toHaveBeenCalled();
        expect(await target.evaluate("window.events")).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        await finishProvisionSession(started.session_id);
        await f.close();
      }
    },
  );

  it.each(["success", "uncertain", "payment"] as const)(
    "handles a closed-shadow popup link with %s dispatch",
    async (mode) => {
      const f = await fixture();
      await f.page.context().route("http://parent.test/destination", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Popup destination</main>",
        }),
      );
      const started = await startHarnessProvisionSession({
        browser: f.controller,
        serviceUrl: "http://parent.test/",
        observationFormat: "browser-use-dom",
      });
      const session = paymentSession(started.session_id);
      try {
        await f.page.evaluate(() => {
          document.body.innerHTML = '<main>Original page</main><div id="popup-host"></div>';
          document.querySelector("#popup-host")!.attachShadow({ mode: "closed" }).innerHTML =
            '<a href="http://parent.test/destination" target="_blank" style="position:absolute;left:150px;top:220px;width:150px;height:60px;display:block">Open destination</a>';
        });
        if (mode === "payment") session.paymentFieldSealActive = true;
        const shot = await captureScreenshot(started.session_id);
        const originalClick = f.page.mouse.click.bind(f.page.mouse);
        const mouse = vi.spyOn(f.page.mouse, "click").mockImplementation(async (x, y) => {
          await originalClick(x, y);
          if (mode === "uncertain") throw new Error("acknowledgement lost after popup dispatch");
        });
        const opened = f.page.waitForEvent("popup");
        const result = await operateClickTool.handler(
          {
            session_id: started.session_id,
            screenshot: { screenshot_id: shot.click_binding!.screenshot_id, x: 174, y: 244 },
          },
          null,
        );
        const popup = await opened;
        await popup.waitForLoadState("domcontentloaded");
        expect(popup.url()).toBe("http://parent.test/destination");
        expect(f.page.isClosed()).toBe(false);
        expect(mouse).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
          screenshot_click: {
            dispatch: mode === "uncertain" ? "unknown" : "dispatched",
            outcome: "unknown",
            retry_policy: "observe_before_new_action",
          },
        });
        await popup.locator("main").evaluate((el) => {
          el.textContent = "Popup destination ready";
        });
        const after = await observe(started.session_id, "full");
        if (mode === "payment") {
          expect(f.controller.activePage()).toBe(f.page);
          expect(after.url).toBe("http://parent.test/");
          expect(after.dom).toContain("Original page");
        } else {
          expect(f.controller.activePage()).toBe(popup);
          expect(after.url).toBe("http://parent.test/destination");
          expect(after.dom).toContain("Popup destination ready");
          if (mode === "success") expect(result).toMatchObject({ url: popup.url() });
        }
      } finally {
        session.paymentFieldSealActive = false;
        vi.restoreAllMocks();
        await finishProvisionSession(started.session_id);
        await f.close();
      }
    },
  );

  it("exposes exclusive ref/image schemas and finite original-image coordinates", () => {
    const screenshot = { screenshot_id: "12345678-1234-4234-8234-123456789abc", x: 1, y: 2 };
    expect(operateClickTool.inputSchema.safeParse({ session_id: "s", screenshot }).success).toBe(
      true,
    );
    for (const args of [
      { session_id: "s" },
      { session_id: "s", ref: "@label", screenshot },
      { session_id: "s", screenshot: { ...screenshot, x: Infinity } },
    ])
      expect(operateClickTool.inputSchema.safeParse(args).success).toBe(false);
    expect(operateClickTool.jsonInputSchema.oneOf).toHaveLength(2);
  });

  it.each(["success", "transport", "observation"] as const)(
    "reports %s accurately and does not replay the screenshot",
    async (mode) => {
      const f = await fixture();
      const started = await startHarnessProvisionSession({
        browser: f.controller,
        serviceUrl: "http://parent.test/",
        extraAllowedHosts: ["child.test"],
        observationFormat: "browser-use-dom",
      });
      try {
        const shot = await captureScreenshot(started.session_id);
        expect(shot.click_binding).toBeDefined();
        const screenshot: ScreenshotPoint = {
          screenshot_id: shot.click_binding!.screenshot_id,
          x: 174,
          y: 244,
        };
        const mouse = f.page.mouse.click.bind(f.page.mouse);
        if (mode !== "success")
          vi.spyOn(f.page.mouse, "click").mockImplementation(async (x, y) => {
            await mouse(x, y);
            if (mode === "transport") throw new Error("lost acknowledgement");
            vi.spyOn(f.controller, "extractBrowserUseObservation").mockRejectedValue(
              new Error("observation unavailable after dispatch"),
            );
          });
        const result = await operateClickTool.handler(
          { session_id: started.session_id, screenshot },
          null,
        );
        expect(result).toMatchObject({
          screenshot_click: {
            dispatch: mode === "transport" ? "unknown" : "dispatched",
            outcome: "unknown",
            retry_policy: "observe_before_new_action",
          },
        });
        const replay = await operateClickTool.handler(
          { session_id: started.session_id, screenshot },
          null,
        );
        expect(replay).toMatchObject({
          status: "stale_screenshot",
          screenshot_click: { dispatch: "not_dispatched" },
        });
        expect(await f.frame.evaluate("window.events")).toEqual([{ trusted: true, checked: true }]);
        await evidence(
          `tool-${mode}.json`,
          JSON.stringify(
            { result, replay, events: await f.frame.evaluate("window.events") },
            null,
            2,
          ),
        );
      } finally {
        vi.restoreAllMocks();
        await finishProvisionSession(started.session_id);
        await f.close();
      }
    },
  );

  it.each(["scope", "payment"] as const)(
    "preserves the existing %s refusal for coordinate clicks",
    async (guard) => {
      const f = await fixture();
      const started = await startHarnessProvisionSession({
        browser: f.controller,
        serviceUrl: "http://parent.test/",
        observationFormat: "browser-use-dom",
      });
      const session = paymentSession(started.session_id);
      try {
        if (guard === "payment") {
          await f.page.evaluate(() => {
            document.body.innerHTML =
              '<button style="position:absolute;left:150px;top:220px;width:100px;height:60px">Place order</button>';
            (window as unknown as { clicks: number }).clicks = 0;
            document.querySelector("button")!.onclick = () => {
              (window as unknown as { clicks: number }).clicks++;
            };
          });
          session.placeOrderApproval = {
            approvalId: "synthetic",
            merchant: "parent.test",
            amountCents: 100,
            currency: "USD",
            cardRef: "synthetic",
            last4: "1234",
          };
          session.placeOrderAttempted = true;
        }
        const shot = await captureScreenshot(started.session_id);
        const mouse = vi.spyOn(f.page.mouse, "click");
        const screenshot = { screenshot_id: shot.click_binding!.screenshot_id, x: 174, y: 244 };
        await expect(
          operateClickTool.handler({ session_id: started.session_id, screenshot }, null),
        ).rejects.toThrow(guard === "scope" ? "target_not_allowed" : "action_failed");
        expect(mouse).not.toHaveBeenCalled();
        expect(
          await operateClickTool.handler({ session_id: started.session_id, screenshot }, null),
        ).toMatchObject({ status: "stale_screenshot" });
      } finally {
        session.placeOrderApproval = null;
        vi.restoreAllMocks();
        await finishProvisionSession(started.session_id);
        await f.close();
      }
    },
  );

  it("distinguishes an unresolved screenshot-derived label from an expired physical ref", async () => {
    const f = await fixture();
    const started = await startHarnessProvisionSession({
      browser: f.controller,
      serviceUrl: "http://parent.test/",
      observationFormat: "browser-use-dom",
    });
    try {
      await expect(
        operateClickTool.handler(
          { session_id: started.session_id, ref: "@verify-you-are-human" },
          null,
        ),
      ).rejects.toThrow("target_unresolved");
      await expect(
        operateClickTool.handler({ session_id: started.session_id, ref: "@e:expired" }, null),
      ).rejects.toThrow("stale_ref");
      expect(await f.frame.evaluate("window.events")).toEqual([]);
    } finally {
      await finishProvisionSession(started.session_id);
      await f.close();
    }
  });
});
