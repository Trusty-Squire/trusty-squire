// C2 live repro harness: headed Chrome, Xvfb 720x1280, window 1280x1024 (broker
// geometry), real captureOperatorScreenshot + clickScreenshot path.
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", "720x1280x24", "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
let context;
try {
  const { BrowserController } = await import("./src/bot/browser.js");
  const { clickScreenshot } = await import("./src/bot/screenshot-click.js");
  context = await chromium.launchPersistentContext(`/tmp/c2-diag/profile-e2e-${Date.now()}`, {
    headless: false,
    executablePath: "/usr/bin/google-chrome",
    env: { ...process.env, DISPLAY: `:${displayNum}` },
    viewport: null,
    args: ["--window-position=0,0", "--window-size=1280,1024", "--no-first-run", "--no-default-browser-check", "--password-store=basic"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.route("http://fixture.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>body{margin:0}</style><button id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="window.events.push('clicked')">Add To Cart</button><script>window.events=[]</script>`,
    }),
  );
  await page.goto("http://fixture.test/");
  const controller = BrowserController.fromHarnessPage(page);
  const shot = await controller.captureOperatorScreenshot();
  if (!shot.clickBinding) throw new Error("no click binding issued");
  console.log("binding:", shot.clickBinding.width + "x" + shot.clickBinding.height);
  // Click the button center in image pixels. Before the fix this threw
  // "Protocol error (DOM.getNodeForLocation): No node found at given location".
  await clickScreenshot(page, { screenshot_id: shot.clickBinding.screenshot_id, x: 200, y: 130 }, () => {});
  const events = await page.evaluate("window.events");
  console.log("events:", JSON.stringify(events));
  if (!events.includes("clicked")) throw new Error("click did not land");
  console.log("C2 E2E: PASS (headed click dispatched on first attempt)");
  await context.close();
  xvfb.kill();
  process.exit(0);
} catch (error) {
  console.error("C2 E2E FAIL:", error.message ?? error);
  await context?.close().catch(() => {});
  xvfb.kill();
  process.exit(1);
}
