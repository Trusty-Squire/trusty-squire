import { existsSync } from "node:fs";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { NativeDialogs } from "../native-dialogs.js";
import {
  act,
  observe,
  observeQuery,
  finishProvisionSession,
  startHarnessProvisionSession,
  startProvisionSession,
  awaitVerification,
} from "../provision-session.js";
import { operateDialogTool } from "../../tools/operate-dialog.js";
import { shareOperateSession } from "../live-share.js";
import { sessionForCall } from "../session/lifecycle.js";
import { runOperateDrive } from "../operate-drive.js";
import { vi } from "vitest";
import { ApiClient } from "../../api-client.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" }),
    args: ["--no-sandbox"],
  });
});
afterAll(async () => {
  await browser?.close();
});

const url = "https://native-dialog.test/form";
const fixture = `<!doctype html><title>GitHub style uninstall</title>
<form action="/submitted"><input id="uninstall" type="submit" value="Uninstall" data-confirm="This action cannot be undone" onclick="return confirm(this.dataset.confirm)"></form>
<button id="alert" onclick="alert('Notice')">Alert</button>
<button id="prompt" onclick="document.title=prompt('Name?', 'Ada') ?? 'cancelled'">Prompt</button>`;

it("Reproduction 2026-10-20: without a handler confirm silently prevents form submission", async () => {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.goto(url);
  await page.locator("#uninstall").click();
  expect(page.url()).toBe(url);
  await page.close();
});

it.each(["accept", "dismiss"] as const)(
  "Reproduction 2026-10-20: operate_click exposes confirm and operate_dialog can %s",
  async (action) => {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.goto(url);
    const controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: url,
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const initial = await observe(started.session_id, "compact");
      const rows = z
        .object({ safe_table: z.array(z.tuple([z.string(), z.string(), z.string().optional()])) })
        .parse(initial).safe_table;
      const row = rows.find((candidate) => candidate[2]?.toLowerCase().includes("uninstall"));
      expect(row).toBeDefined();
      const result = await act(started.session_id, { kind: "click", target: row![0] }, "compact");
      expect(result.semantic?.blockers?.[0]).toMatchObject({
        kind: "native_dialog",
        type: "confirm",
        text: "This action cannot be undone",
      });
      expect((await observe(started.session_id, "compact")).semantic?.blockers?.[0]?.id).toBe(
        controller.nativeDialogs.evidence()[0]?.id,
      );
      const dialog = controller.nativeDialogs.evidence()[0]!;
      expect(await observeQuery(started.session_id, "Uninstall")).toMatchObject({
        semantic: { blockers: [{ id: dialog.id }] },
      });
      await operateDialogTool.handler(
        { session_id: started.session_id, dialog_id: dialog.id, action },
        new ApiClient({
          apiBaseUrl: "http://127.0.0.1:1",
          registryBaseUrl: "http://127.0.0.1:1",
          agentSessionToken: "test",
        }),
      );
      if (action === "accept") await page.waitForURL("**/submitted?");
      else expect(page.url()).toBe(url);
      expect(controller.nativeDialogs.blocked).toBe(false);
      await expect(controller.nativeDialogs.answer(dialog.id, "accept")).rejects.toThrow(
        "stale_native_dialog",
      );
    } finally {
      await finishProvisionSession(started.session_id);
      await page.close();
    }
  },
  15_000,
);

it("holds alert and prompt and preserves prompt response", async () => {
  const page = await browser.newPage();
  const controller = BrowserController.fromHarnessPage(page);
  await page.setContent(fixture);
  await controller.click({ kind: "selector", selector: "#alert", method: "click" });
  expect(controller.nativeDialogs.evidence()[0]?.type).toBe("alert");
  await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "accept");
  await controller.click({ kind: "selector", selector: "#prompt", method: "click" });
  const prompt = controller.nativeDialogs.evidence()[0]!;
  expect(prompt.default_value).toBe("Ada");
  await controller.nativeDialogs.answer(prompt.id, "accept", "Jellybean");
  await expect.poll(() => page.title()).toBe("Jellybean");
  await controller.click({ kind: "selector", selector: "#prompt", method: "click" });
  await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "dismiss");
  await expect.poll(() => page.title()).toBe("cancelled");
  await controller.click({ kind: "selector", selector: "#prompt", method: "click" });
  await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "accept");
  await expect.poll(() => page.title()).toBe("Ada");
  await page.close();
});

it("dismisses unanswered dialogs within the bound and records the timeout", async () => {
  const page = await browser.newPage();
  const dialogs = new NativeDialogs(50);
  dialogs.watch(page);
  await page.setContent(
    "<button onclick=\"document.title=confirm('Sure?') ? 'accepted' : 'dismissed'\">Confirm</button>",
  );
  await dialogs.interrupt(() => page.locator("button").click());
  await expect.poll(() => dialogs.timeoutNotices().length).toBe(1);
  expect(dialogs.blocked).toBe(false);
  expect(await page.title()).toBe("dismissed");
  await dialogs.dispose();
  await page.close();
});

it("holds beforeunload without hanging navigation; dismiss retains the document", async () => {
  const page = await browser.newPage();
  const controller = BrowserController.fromHarnessPage(page);
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<button onclick="onbeforeunload=()=>true">Arm</button>',
    }),
  );
  await page.goto(url);
  await page.locator("button").click();
  await controller.navigate("https://native-dialog.test/next");
  const dialog = controller.nativeDialogs.evidence()[0]!;
  expect(dialog.type).toBe("beforeunload");
  await controller.nativeDialogs.answer(dialog.id, "dismiss");
  expect(page.url()).toBe(url);
  // The navigation retry backoff is 1500 ms; cancellation must survive it.
  await page.waitForTimeout(1800);
  expect(controller.nativeDialogs.blocked).toBe(false);
  expect(page.url()).toBe(url);
  await controller.navigate("https://native-dialog.test/next");
  await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "accept");
  await page.waitForURL("**/next");
  await page.close();
});

it("watches later popups without capturing another session's page", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const controller = BrowserController.fromHarnessPage(page);
  await page.setContent("<button onclick=\"window.open('about:blank')\">Open</button>");
  const popupReady = page.waitForEvent("popup");
  await page.locator("button").click();
  const popup = await popupReady;
  await popup.setContent("<button onclick=\"confirm('Popup?')\">Confirm</button>");
  await controller.nativeDialogs.interrupt(() => popup.locator("button").click());
  expect(controller.nativeDialogs.evidence()[0]?.text).toBe("Popup?");
  await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "dismiss");
  await context.route("https://native-dialog.test/popup", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><script>confirm("Popup on load?")</script>',
    }),
  );
  await page.setContent(
    "<button onclick=\"window.open('https://native-dialog.test/popup')\">Open</button>",
  );
  await controller.nativeDialogs.interrupt(() => page.locator("button").click());
  await expect.poll(() => controller.nativeDialogs.evidence()[0]?.text).toBe("Popup on load?");
  await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "dismiss");
  const foreign = await context.newPage();
  await foreign.setContent(
    "<button onclick=\"document.title=confirm('Foreign?')\">Confirm</button>",
  );
  await foreign.locator("button").click();
  expect(controller.nativeDialogs.blocked).toBe(false);
  expect(await foreign.title()).toBe("false");
  await context.close();
});

it("Reproduction 2026-10-20: a human in the real live viewer sees and accepts the confirmation", async () => {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  const controller = BrowserController.fromHarnessPage(page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: url,
    initialObservation: "drive",
  });
  const viewer = await browser.newPage();
  try {
    const shared = await shareOperateSession(sessionForCall(started.session_id)!, async (port) => ({
      url: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    }));
    await viewer.goto(shared.url);
    await expect
      .poll(() =>
        viewer
          .locator("canvas")
          .evaluate((canvas) => (canvas instanceof HTMLCanvasElement ? canvas.width : 0)),
      )
      .toBeGreaterThan(300);
    const button = await page.locator("#uninstall").boundingBox();
    const canvas = await viewer.locator("canvas").boundingBox();
    const viewport = page.viewportSize()!;
    await viewer.mouse.click(
      canvas!.x + ((button!.x + button!.width / 2) / viewport.width) * canvas!.width,
      canvas!.y + ((button!.y + button!.height / 2) / viewport.height) * canvas!.height,
    );
    await expect
      .poll(() => viewer.locator("#native-dialog").isVisible(), { timeout: 5000 })
      .toBe(true);
    expect(await viewer.locator("#dialog-message").textContent()).toBe(
      "This action cannot be undone",
    );
    expect(page.url()).toBe(url);
    await viewer.locator("#dialog-accept").click();
    await page.waitForURL("**/submitted?");
    await expect
      .poll(() => viewer.locator("#native-dialog").isVisible(), { timeout: 5000 })
      .toBe(false);
  } finally {
    await viewer.close();
    await finishProvisionSession(started.session_id);
    await page.close();
  }
}, 15_000);

it.each(["accept", "handoff"] as const)(
  "drive makes an explicit native confirmation decision: %s",
  async (choice) => {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    const controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: url,
      initialObservation: "drive",
    });
    try {
      await controller.click({ kind: "selector", selector: "#uninstall", method: "click" });
      const askJev = vi.fn(async () => ({
        result: {
          answers: {
            native_dialog: {
              choice,
              confidence: 1,
              probabilities: {
                accept: choice === "accept" ? 1 : 0,
                dismiss: 0,
                handoff: choice === "handoff" ? 1 : 0,
              },
            },
          },
        },
        attempts: 1,
        elapsedMs: 1,
      }));
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal:
            choice === "accept"
              ? "Uninstall and accept the browser confirmation dialog"
              : "Inspect the installation",
          max_steps: 1,
        },
        new ApiClient({
          apiBaseUrl: "http://127.0.0.1:1",
          registryBaseUrl: "http://127.0.0.1:1",
          agentSessionToken: "test",
        }),
        undefined,
        {
          askJev,
          act,
          observe,
          startSession: startProvisionSession,
          awaitVerification,
          injectCard: async () => ({}),
        },
      );
      expect(askJev).toHaveBeenCalledOnce();
      expect(JSON.stringify(askJev.mock.calls)).toContain("This action cannot be undone");
      if (choice === "accept") await page.waitForURL("**/submitted?");
      else {
        expect(result.status).toBe("needs_value");
        expect(controller.nativeDialogs.blocked).toBe(true);
        expect(page.url()).toBe(url);
      }
    } finally {
      await finishProvisionSession(started.session_id);
      await page.close();
    }
  },
  15_000,
);

it("reports a startup alert before DOMContentLoaded without hanging session creation", async () => {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><script>alert("Welcome")</script><title>Ready</title>',
    }),
  );
  const controller = BrowserController.fromHarnessPage(page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: url,
    initialObservation: "drive",
  });
  try {
    expect(started.semantic?.blockers?.[0]).toMatchObject({
      kind: "native_dialog",
      type: "alert",
      text: "Welcome",
    });
    await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "accept");
    await expect.poll(() => page.title()).toBe("Ready");
  } finally {
    await finishProvisionSession(started.session_id);
  }
}, 5000);

it("masks released card values in native dialog text while keeping unrelated evidence", async () => {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><button id="confirm" onclick="confirm(\'4111 1111 1111 1111 CVV 739 total USD 42\')">Confirm</button><button id="prompt" onclick="prompt(\'CVV?\', \'739\')">Prompt</button>',
    }),
  );
  const controller = BrowserController.fromHarnessPage(page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: url,
    initialObservation: "drive",
  });
  try {
    controller.registerCardValueOutputMask({ pan: "4111111111111111", cvv: "739" });
    await controller.click({ kind: "selector", selector: "#confirm", method: "click" });
    const observation = await observe(started.session_id, "compact");
    expect(observation.semantic?.blockers?.[0]?.text).toBe(
      "[card number] CVV [security code] total USD 42",
    );
    await controller.nativeDialogs.answer(controller.nativeDialogs.evidence()[0]!.id, "dismiss");
    await controller.click({ kind: "selector", selector: "#prompt", method: "click" });
    expect(
      (await observe(started.session_id, "compact")).semantic?.blockers?.[0]?.default_value,
    ).toBe("[security code]");
  } finally {
    await finishProvisionSession(started.session_id);
  }
});
