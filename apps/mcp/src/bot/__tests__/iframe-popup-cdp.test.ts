import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium as patchright } from "patchright";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { startPopupPauseGuard } from "../popup-pause-guard.js";

it("adopts a cross-site iframe popup with debugger statements through CDP", async () => {
  const profile = await mkdtemp(join(tmpdir(), "iframe-popup-cdp-"));
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const port = (server.address() as AddressInfo).port;
    if (req.url === "/frame")
      res.end(
        `<button onclick="debugger; window.open('http://localhost:${port}/popup')">Continue with Google fixture</button><script>debugger;</script>`,
      );
    else if (req.url === "/popup")
      res.end(
        "<script>debugger;</script><button onclick=\"document.body.dataset.clicked='yes'\">Chooser responds</button>",
      );
    else res.end(`<iframe src="http://localhost:${port}/frame"></iframe>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const child = spawn(
    chromium.executablePath(),
    [
      "--headless",
      "--no-sandbox",
      "--site-per-process",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let browser: Awaited<ReturnType<typeof patchright.connectOverCDP>> | undefined;
  let stopGuard: (() => void) | undefined;
  try {
    let endpoint = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const [debugPort, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8"))
          .trim()
          .split("\n");
        endpoint = `ws://127.0.0.1:${debugPort}${path}`;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(endpoint).not.toBe("");
    browser = await patchright.connectOverCDP(endpoint);
    stopGuard = await startPopupPauseGuard(endpoint);
    const context = browser.contexts()[0]!;
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    const controller = BrowserController.fromHarnessPage(page as unknown as Page);
    const capture = await controller.extractBrowserUseObservation();
    expect(
      capture.elements.some((e) => JSON.stringify(e).includes("Continue with Google fixture")),
    ).toBe(true);
    const cdp = await context.newCDPSession(page);
    const targets = await cdp.send("Target.getTargets");
    expect(targets.targetInfos.some((t) => t.type === "iframe" && t.url.endsWith("/frame"))).toBe(
      true,
    );
    controller.armOpenedTabAdoption();
    const popupEvent = page.waitForEvent("popup", { timeout: 5000 });
    await page.frameLocator("iframe").getByRole("button").click({ timeout: 5000 });
    const popup = await popupEvent;
    await popup.waitForLoadState("domcontentloaded");
    expect(await controller.adoptOpenedTab()).toBe(`http://localhost:${port}/popup`);
    const after = await controller.extractBrowserUseObservation();
    expect(after.elements.some((e) => JSON.stringify(e).includes("Chooser responds"))).toBe(true);
    const pauseClient = await context.newCDPSession(popup);
    await pauseClient.send("Debugger.enable");
    await pauseClient.send("Debugger.pause");
    await popup.getByRole("button").click({ timeout: 5000 });
    await pauseClient.detach();
    expect(await popup.locator("body").getAttribute("data-clicked")).toBe("yes");
    console.warn(
      "IFRAME_POPUP_PASS: cross-site control captured; popup adopted; debugger statements completed; chooser responds",
    );
  } finally {
    stopGuard?.();
    await browser?.close();
    child.kill("SIGINT");
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve(null) : child.once("exit", resolve),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}, 30000);
