import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { chromium as patchrightChromium } from "patchright";
import { expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import {
  captureScreenshot,
  finishProvisionSession,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { operateUploadTool } from "../../tools/provision-drive.js";
import { inputJsonSchema } from "../../tools/input-json-schema.js";
import { withOperatorRequestContext } from "../request-cancellation.js";
import { hostDisplayAcceptsConnections } from "../display-env.js";
import {
  createXvfbDisplayRig,
  startRemoteLoginDisplay,
  remoteLoginEnvironment,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "../remote-login-display.js";

const FIRST_FRAME_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfEYEY0pSH8OITBAtxmnf11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBEIYhD+7aWsEAAAAASUVORK5CYII=",
  "base64",
);

it.each(["button", "hidden-input", "opacity-zero-input"])(
  "uploads a local file through %s",
  async (mode) => {
    const fixtureDir = await mkdtemp(join(process.cwd(), ".operator-upload-fixture-"));
    const filePath = join(fixtureDir, "app-release.aab");
    let browser: Browser | undefined;
    const url = "https://upload-fixture.test/";
    let sessionId: string | undefined;
    try {
      await writeFile(filePath, "synthetic app bundle");
      browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button type="button" onclick="document.querySelector('#bundle').click()">Upload app bundles</button>
          <input id="bundle" type="file" ${mode === "opacity-zero-input" ? 'style="opacity:0"' : "hidden"} onchange="document.querySelector('output').textContent = this.files[0].name + ':' + this.files[0].size">
          <output></output>`,
        }),
      );
      const started = await startHarnessProvisionSession({
        browser: BrowserController.fromHarnessPage(page),
        serviceUrl: url,
        format: "compact",
      });
      sessionId = started.session_id;
      const rows = (started as unknown as { safe_table: string[][] }).safe_table;
      const target = rows.find((row) =>
        mode === "button" ? row[2]?.split("|")[0] === "@upload-app-bundles" : row[1] === "f",
      )?.[0];
      expect(target).toBeDefined();
      const result = await operateUploadTool.handler(
        { session_id: sessionId, target: target!, path: filePath },
        null,
      );
      expect(result).toHaveProperty("session_id", sessionId);
      expect(await page.locator("output").textContent()).toBe("app-release.aab:20");
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await browser?.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  },
  30_000,
);

// Reproduction dreamina-upload-target-1: a document-delegated card creates a
// detached input only when clicked, so neither card nor input has an issued ref.
async function detachedFixture(
  run: (fixture: {
    page: Page;
    request: {
      session_id: string;
      path: string;
      screenshot: { screenshot_id: string; x: number; y: number };
    };
    fixtureDir: string;
  }) => Promise<void>,
  childFrame = false,
  headed = false,
  picker = false,
) {
  const fixtureDir = await mkdtemp(join(process.cwd(), ".operator-upload-fixture-"));
  const filePath = join(fixtureDir, "first-frame.png");
  let browser: Browser | undefined;
  let sessionId: string | undefined;
  let rig: RemoteLoginRig | undefined;
  const url = "https://upload-fixture.test/";
  try {
    await writeFile(filePath, FIRST_FRAME_PNG);
    if (headed && !(await hostDisplayAcceptsConnections())) {
      rig = createXvfbDisplayRig({ width: 1280, height: 960 });
      await startRemoteLoginDisplay(rig);
    }
    browser = (await (headed ? patchrightChromium : chromium).launch({
      headless: !headed,
      args: ["--no-sandbox"],
      ...(rig ? { env: remoteLoginEnvironment(rig) } : {}),
    })) as unknown as Browser;
    const page = await browser.newPage();
    const markup = `<div id="card" style="position:absolute;left:20px;top:30px;width:200px;height:100px">Add first frame</div>
        <output></output><script>
        document.body.dataset.cardClicks = '0';
        document.addEventListener('click', e => {
          if (!e.target.closest('#card')) return;
          document.body.dataset.cardClicks = String(Number(document.body.dataset.cardClicks) + 1);
          const input = document.createElement('input');
          input.type = 'file';
          input.onchange = () => document.querySelector('output').textContent = input.files[0].name + ':' + input.files[0].size;
          input.click();
        });</script>`;
    // Reproduction R-1092b: Dreamina's card calls showOpenFilePicker during the
    // trusted click and reads the file through the returned handle.
    const pickerMarkup = `<div id="card" style="position:absolute;left:20px;top:30px;width:200px;height:100px">Add first frame</div>
        <output></output><script>
        document.body.dataset.cardClicks = '0';
        document.addEventListener('click', e => {
          if (!e.target.closest('#card')) return;
          document.body.dataset.cardClicks = String(Number(document.body.dataset.cardClicks) + 1);
          window.showOpenFilePicker({
            excludeAcceptAllOption: true,
            multiple: false,
            types: [{ accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpeg'] } }],
          }).then(
            handles => handles[0].getFile(),
          ).then(
            file => document.querySelector('output').textContent = file.name + ':' + file.size,
            error => document.querySelector('output').textContent = 'picker:' + error.name,
          );
        });</script>`;
    await page.route("https://**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          childFrame && route.request().url() === url
            ? '<iframe style="position:absolute;left:100px;top:120px;width:400px;height:300px;border:0" src="https://upload-child.test/"></iframe>'
            : picker
              ? pickerMarkup
              : markup,
      }),
    );
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
    });
    sessionId = started.session_id;
    const rows = (started as unknown as { safe_table: string[][] }).safe_table;
    expect(rows.some((row) => row[1] === "f" || row[2]?.includes("@add-first-frame"))).toBe(false);
    const shot = await captureScreenshot(
      sessionId,
      childFrame ? { frameUrlContains: "upload-child.test" } : {},
    );
    expect(shot.click_binding).toBeDefined();
    const request = {
      session_id: sessionId,
      screenshot: {
        screenshot_id: shot.click_binding!.screenshot_id,
        x: 60,
        y: 70,
      },
      path: filePath,
    };
    await run({ page, request, fixtureDir });
  } finally {
    vi.restoreAllMocks();
    if (sessionId) await finishProvisionSession(sessionId);
    await browser?.close();
    if (rig) await teardownRemoteLoginRig(rig);
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

it.each([false, true])(
  "uploads the no-ref card through screenshot coordinates (child frame: %s)",
  async (childFrame) => {
    await detachedFixture(async ({ page, request }) => {
      const mouse = vi.spyOn(page.mouse, "click");
      await expect(
        operateUploadTool.handler(
          { session_id: request.session_id, target: "@add-first-frame", path: request.path },
          null,
        ),
      ).rejects.toThrow("stale_ref");
      expect(mouse).not.toHaveBeenCalled();
      const result = await operateUploadTool.handler(
        operateUploadTool.inputSchema.parse(request),
        null,
      );
      expect(result).toMatchObject({
        session_id: request.session_id,
        screenshot_click: { dispatch: "dispatched" },
      });
      const frame = childFrame
        ? page.frames().find((f) => f.url().includes("upload-child.test"))!
        : page.mainFrame();
      expect(await frame.locator("output").textContent()).toBe("first-frame.png:179");
      expect(Number(await frame.locator("body").getAttribute("data-card-clicks"))).toBe(1);
      const replay = await operateUploadTool.handler(request, null);
      expect(replay).toMatchObject({
        status: "stale_screenshot",
        screenshot_click: { dispatch: "not_dispatched" },
      });
      expect(mouse).toHaveBeenCalledOnce();
      console.warn(
        `Reproduction dreamina-upload-target-1: ref-only upload returned stale_ref; screenshot upload attached first-frame.png:179 with one click (child frame: ${childFrame}); replay refused`,
      );
    }, childFrame);
  },
  30_000,
);

it.each(["stale", "expired", "outside", "missing-file", "directory", "cancelled"] as const)(
  "does not click or attach for %s screenshot upload",
  async (mode) => {
    await detachedFixture(async ({ page, request, fixtureDir }) => {
      const mouse = vi.spyOn(page.mouse, "click");
      const waiter = vi.spyOn(page, "waitForEvent");
      if (mode === "stale")
        await page.locator("#card").evaluate((el) => {
          el.textContent = "Different action";
        });
      if (mode === "expired") {
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
      }
      if (mode === "outside") request.screenshot.x = 100_000;
      if (mode === "missing-file") request.path = join(fixtureDir, "absent.png");
      if (mode === "directory") request.path = fixtureDir;
      const abort = new AbortController();
      if (mode === "cancelled") abort.abort(new Error("operator_request_cancelled"));
      const upload = () => operateUploadTool.handler(request, null);
      if (mode === "missing-file" || mode === "directory" || mode === "cancelled") {
        await expect(withOperatorRequestContext(abort.signal, upload)).rejects.toThrow();
      } else {
        expect(await upload()).toMatchObject({
          status: mode === "outside" ? "invalid_screenshot_point" : "stale_screenshot",
          screenshot_click: { dispatch: "not_dispatched" },
        });
      }
      expect(mouse).not.toHaveBeenCalled();
      expect(waiter).not.toHaveBeenCalled();
      expect(Number(await page.locator("body").getAttribute("data-card-clicks"))).toBe(0);
      expect(await page.locator("output").textContent()).toBe("");
    });
  },
  30_000,
);

it.each([
  "timeout",
  "chooser-failure",
  "file-write-failure",
  "click-failure",
  "cancel-after-click",
] as const)(
  "does not replay or attach after %s",
  async (mode) => {
    await detachedFixture(async ({ page, request }) => {
      const originalClick = page.mouse.click.bind(page.mouse);
      const mouse = vi.spyOn(page.mouse, "click");
      const abort = new AbortController();
      if (mode === "timeout" || mode === "chooser-failure") {
        await page.evaluate(() =>
          document.addEventListener("click", (e) => e.stopImmediatePropagation(), true),
        );
        vi.spyOn(page, "waitForEvent").mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw Object.assign(
            new Error("Failure for /private/synthetic.png at secret page content"),
            {
              name: mode === "timeout" ? "TimeoutError" : "Error",
            },
          );
        });
      } else if (mode === "file-write-failure") {
        page.once("filechooser", (chooser) => {
          vi.spyOn(chooser, "setFiles").mockRejectedValue(
            new Error("/private/synthetic.png: secret page content"),
          );
        });
      } else if (mode === "click-failure") {
        mouse.mockRejectedValue(new Error("pointer acknowledgement lost"));
      } else {
        mouse.mockImplementation(async (x, y) => {
          await originalClick(x, y);
          abort.abort(new Error("operator_request_cancelled"));
        });
      }
      const result = await withOperatorRequestContext(abort.signal, () =>
        operateUploadTool.handler(request, null),
      );
      expect(result).toMatchObject({
        status: "screenshot_click_uncertain",
        screenshot_click: {
          dispatch: mode === "click-failure" ? "unknown" : "dispatched",
          retry_policy: "observe_before_new_action",
        },
      });
      if (mode !== "click-failure") {
        expect(result).toHaveProperty("upload_failure", {
          phase: mode === "timeout" || mode === "chooser-failure" ? "chooser_wait" : "file_write",
          cause:
            mode === "timeout"
              ? "chooser_timeout"
              : mode === "chooser-failure"
                ? "chooser_failed"
                : mode === "file-write-failure"
                  ? "file_write_failed"
                  : "cancelled",
        });
        expect(JSON.stringify(result)).not.toMatch(/private|secret page content/);
      }
      expect(await page.locator("output").textContent()).toBe("");
      // A new request can observe the spent binding without replaying the click.
      expect(await operateUploadTool.handler(request, null)).toMatchObject({
        status: "stale_screenshot",
      });
      expect(mouse).toHaveBeenCalledOnce();
      expect(Number(await page.locator("body").getAttribute("data-card-clicks"))).toBe(
        mode === "cancel-after-click" || mode === "file-write-failure" ? 1 : 0,
      );
    });
  },
  30_000,
);

it("requires exactly one upload target and finite original-image coordinates", () => {
  const base = { session_id: "s", path: "/tmp/first-frame.png" };
  const screenshot = { screenshot_id: "12345678-1234-4234-8234-123456789abc", x: 1, y: 2 };
  for (const target of [{ target: "@upload" }, { screenshot }]) {
    expect(operateUploadTool.inputSchema.safeParse({ ...base, ...target }).success).toBe(true);
  }
  for (const target of [
    {},
    { target: "@upload", screenshot },
    { screenshot: { ...screenshot, x: Infinity } },
    { screenshot: { ...screenshot, y: -1 } },
    { screenshot: { ...screenshot, selector: "#card" } },
  ]) {
    expect(operateUploadTool.inputSchema.safeParse({ ...base, ...target }).success).toBe(false);
  }
  expect(
    operateUploadTool.inputSchema.safeParse({ ...base, target: "@upload", path: "relative.png" })
      .success,
  ).toBe(false);
  expect(inputJsonSchema(operateUploadTool.inputSchema).properties).toHaveProperty("screenshot");
  expect(operateUploadTool.jsonOutputSchema?.properties).toHaveProperty("screenshot_click");
});

// Reproduction dreamina-live-upload-2: these headed fixtures qualify the
// deferred chooser and frame path, not the real site's unexplained failure.
it.each([false, true])(
  "headed Patchright attaches a synthetic first frame (child frame: %s)",
  async (childFrame) => {
    await detachedFixture(
      async ({ page, request }) => {
        const mouse = vi.spyOn(page.mouse, "click");
        const result = await operateUploadTool.handler(request, null);
        expect(result).toMatchObject({
          session_id: request.session_id,
          screenshot_click: { dispatch: "dispatched" },
        });
        const frame = childFrame
          ? page.frames().find((f) => f.url().includes("upload-child.test"))!
          : page.mainFrame();
        expect(await frame.locator("output").textContent()).toBe("first-frame.png:179");
        expect(Number(await frame.locator("body").getAttribute("data-card-clicks"))).toBe(1);
        expect(mouse).toHaveBeenCalledOnce();
        console.warn(
          `Reproduction dreamina-live-upload-2 fixture: headed Patchright attached first-frame.png:179 with one native click (child frame: ${childFrame}); real Dreamina repair not demonstrated`,
        );
      },
      childFrame,
      true,
    );
  },
  30_000,
);

it("headed completed click followed by real chooser timeout retains safe diagnostics", async () => {
  await detachedFixture(
    async ({ page, request }) => {
      await page.evaluate(() =>
        document.addEventListener("click", (e) => e.stopImmediatePropagation(), true),
      );
      const mouse = vi.spyOn(page.mouse, "click");
      const result = await operateUploadTool.handler(request, null);
      expect(result).toMatchObject({
        status: "screenshot_click_uncertain",
        screenshot_click: { dispatch: "dispatched", retry_policy: "observe_before_new_action" },
        upload_failure: { phase: "chooser_wait", cause: "chooser_timeout" },
      });
      expect(await page.locator("output").textContent()).toBe("");
      expect(await operateUploadTool.handler(request, null)).toMatchObject({
        status: "stale_screenshot",
      });
      expect(mouse).toHaveBeenCalledOnce();
      console.warn(
        "Reproduction dreamina-live-upload-2 fixture: native click completed, chooser timed out, safe phase/cause returned, second click refused",
      );
    },
    false,
    true,
  );
}, 30_000);

it("retains post-upload uncertainty when the file attached but observation failed", async () => {
  await detachedFixture(async ({ page, request }) => {
    const mouse = vi.spyOn(page.mouse, "click");
    vi.spyOn(BrowserController.prototype, "extractBrowserUseObservation").mockRejectedValue(
      new Error("/private/synthetic.png: secret page content"),
    );
    const result = await operateUploadTool.handler(request, null);
    expect(result).toMatchObject({
      status: "screenshot_click_uncertain",
      screenshot_click: { dispatch: "dispatched", retry_policy: "observe_before_new_action" },
      upload_failure: { phase: "post_upload", cause: "post_upload_failed" },
    });
    expect(await page.locator("output").textContent()).toBe("first-frame.png:179");
    expect(JSON.stringify(result)).not.toMatch(/private|secret page content/);
    expect(await operateUploadTool.handler(request, null)).toMatchObject({
      status: "stale_screenshot",
    });
    expect(mouse).toHaveBeenCalledOnce();
  });
}, 30_000);

// Reproduction R-1092b: on 1.1.35-rc.1 this card returned
// screenshot_click_uncertain with chooser_wait/chooser_timeout because
// showOpenFilePicker opens no <input type=file> for Playwright to intercept.
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "attaches a first frame through a showOpenFilePicker card (child frame: %s, headed: %s)",
  async (childFrame, headed) => {
    await detachedFixture(
      async ({ page, request }) => {
        const frame = childFrame
          ? page.frames().find((f) => f.url().includes("upload-child.test"))!
          : page.mainFrame();
        expect(await frame.evaluate(() => typeof Reflect.get(window, "showOpenFilePicker"))).toBe(
          "function",
        );
        const mouse = vi.spyOn(page.mouse, "click");
        const result = await operateUploadTool.handler(request, null);
        expect(result).toMatchObject({
          session_id: request.session_id,
          screenshot_click: { dispatch: "dispatched" },
        });
        expect(result).not.toHaveProperty("upload_failure");
        await expect.poll(() => frame.locator("output").textContent()).toBe("first-frame.png:179");
        expect(Number(await frame.locator("body").getAttribute("data-card-clicks"))).toBe(1);
        expect(mouse).toHaveBeenCalledOnce();
        expect(
          await frame.evaluate(() => String(Reflect.get(window, "showOpenFilePicker"))),
        ).toContain("[native code]");
        console.warn(
          `Reproduction R-1092b fixture: showOpenFilePicker card attached first-frame.png:179 with one click (child frame: ${childFrame}, headed: ${headed})`,
        );
      },
      childFrame,
      headed,
      true,
    );
  },
  30_000,
);

it("names an unrouted showOpenFilePicker call instead of a bare chooser timeout", async () => {
  await detachedFixture(
    async ({ page, request }) => {
      vi.spyOn(page, "waitForEvent").mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw Object.assign(new Error("chooser timeout"), { name: "TimeoutError" });
      });
      const result = await operateUploadTool.handler(request, null);
      expect(result).toMatchObject({
        status: "screenshot_click_uncertain",
        screenshot_click: { dispatch: "dispatched", retry_policy: "observe_before_new_action" },
        upload_failure: { phase: "chooser_wait", cause: "file_picker_unrouted" },
      });
      expect(
        await page.evaluate(() => String(Reflect.get(window, "showOpenFilePicker"))),
      ).toContain("[native code]");
    },
    false,
    false,
    true,
  );
}, 30_000);
