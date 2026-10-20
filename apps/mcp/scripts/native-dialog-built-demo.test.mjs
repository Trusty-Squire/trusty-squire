// Manual built-service demonstration: build MCP first, then run this file with Vitest's isolated-home setup.
import { chromium } from "playwright";
import { expect, it } from "vitest";

it.skipIf(process.env.NATIVE_DIALOG_BUILT_DEMO !== "1")(
  "Reproduction 2026-10-20: built operator and real viewer both submit after explicit confirmation",
  async () => {
    const { BrowserController } = await import("../dist/bot/browser.js");
    const { startHarnessProvisionSession, finishProvisionSession } =
      await import("../dist/bot/provision-session.js");
    const { buildBrokerToolRegistry, findTool } = await import("../dist/tools/index.js");
    const { shareOperateSession } = await import("../dist/bot/live-share.js");
    const { sessionForCall } = await import("../dist/bot/session/lifecycle.js");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const tools = buildBrokerToolRegistry({});
    const transcript = [];
    try {
      for (const path of ["agent", "viewer"]) {
        const page = await browser.newPage();
        await page.route("**/*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><title>Uninstall fixture</title><form action="/submitted"><input id="uninstall" type="submit" value="Uninstall" data-confirm="This action cannot be undone" onclick="return confirm(this.dataset.confirm)"></form>',
          }),
        );
        const session = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: "https://built-dialog.test/form",
          format: "compact",
        });
        try {
          if (path === "agent") {
            const row = session.safe_table.find((row) => row[2]?.includes("@uninstall"));
            const clicked = await findTool("operate_click", tools).handler(
              { session_id: session.session_id, ref: row[0] },
              null,
            );
            expect(clicked.semantic.blockers[0].type).toBe("confirm");
            transcript.push({ path, before: page.url(), blocker: clicked.semantic.blockers[0] });
            await findTool("operate_dialog", tools).handler(
              {
                session_id: session.session_id,
                dialog_id: clicked.semantic.blockers[0].id,
                action: "accept",
              },
              null,
            );
          } else {
            const share = await shareOperateSession(
              sessionForCall(session.session_id),
              async (port) => ({ url: `http://127.0.0.1:${port}`, close: async () => undefined }),
            );
            const viewer = await browser.newPage();
            try {
              await viewer.goto(share.url);
              await expect
                .poll(() => viewer.locator("canvas").evaluate((canvas) => canvas.width))
                .toBeGreaterThan(300);
              const button = await page.locator("#uninstall").boundingBox();
              const canvas = await viewer.locator("canvas").boundingBox();
              const viewport = page.viewportSize();
              await viewer.mouse.click(
                canvas.x + ((button.x + button.width / 2) / viewport.width) * canvas.width,
                canvas.y + ((button.y + button.height / 2) / viewport.height) * canvas.height,
              );
              await expect
                .poll(() => viewer.locator("#native-dialog").isVisible(), { timeout: 5000 })
                .toBe(true);
              transcript.push({
                path,
                before: page.url(),
                question: await viewer.locator("#dialog-message").textContent(),
              });
              await viewer.locator("#dialog-accept").click();
              await page.waitForURL("**/submitted?");
            } finally {
              await viewer.close();
            }
          }
          await page.waitForURL("**/submitted?");
          transcript.push({ path, after: page.url(), submitted: true });
        } finally {
          await finishProvisionSession(session.session_id);
        }
      }
      console.log("BUILT_NATIVE_DIALOG_DEMONSTRATION", JSON.stringify(transcript));
    } finally {
      await browser.close();
    }
  },
  20_000,
);
