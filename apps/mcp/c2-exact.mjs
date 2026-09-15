// Exact replica of launchSelfManagedContext: spawn google-chrome with the
// real argv, connectOverCDP, attachOwnPage (ctx.newPage), then raw
// DOM.getNodeForLocation probes. No input, no capture.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { readFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", "720x1280x24", "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
const profileDir = mkdtempSync(join(tmpdir(), "c2-exact-"));
rmSync(join(profileDir, "SingletonLock"), { force: true });
const argv = [
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "--password-store=basic",
  "--window-position=0,0", "--window-size=1280,1024", "--lang=en-US",
  "--disable-blink-features=AutomationControlled",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-sandbox", "--disable-dev-shm-usage",
  "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  "about:blank",
];
const child = spawn("/usr/bin/google-chrome", argv, {
  env: { ...process.env, DISPLAY: `:${displayNum}` },
  stdio: ["ignore", "ignore", "pipe"], detached: true,
});
child.unref();
const deadline = Date.now() + 30000;
let port = null;
while (Date.now() < deadline) {
  const f = join(profileDir, "DevToolsActivePort");
  if (existsSync(f)) { port = readFileSync(f, "utf8").split("\n")[0]; break; }
  await new Promise((r) => setTimeout(r, 100));
}
if (port === null) { console.error("no DevToolsActivePort"); process.exit(1); }
try {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = await context.newPage(); // attachOwnPage path
  await page.setContent(`<style>body{margin:0;height:4000px}</style><button id="b" style="position:absolute;left:100px;top:50px;width:200px;height:60px">B</button>`);
  const cdp = await context.newCDPSession(page);
  for (const [label, x, y] of [["btn-center", 200, 80], ["body", 640, 400]]) {
    try { await cdp.send("DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: true }); console.log(`${label} -> OK`); }
    catch (e) { console.log(`${label} -> FAIL ${e.message.split("\n")[0]}`); }
  }
  // And the real product click path:
  const { BrowserController } = await import("./src/bot/browser.js");
  const { clickScreenshot } = await import("./src/bot/screenshot-click.js");
  const controller = BrowserController.fromHarnessPage(page);
  const shot = await controller.captureOperatorScreenshot();
  await clickScreenshot(page, { screenshot_id: shot.clickBinding.screenshot_id, x: 200, y: 80 }, () => {});
  console.log("clickScreenshot ->", JSON.stringify(await page.evaluate("window.events ?? []")));
  await browser.close(); xvfb.kill(); process.exit(0);
} catch (e) { console.error("EXACT FAIL:", e.message ?? e); process.exit(1); }
