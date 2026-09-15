// What makes DOM.getNodeForLocation work in headed Chrome?
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", "720x1280x24", "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
console.log(`Xvfb :${displayNum}`);

const browser = await chromium.launchPersistentContext(`/tmp/c2-diag/profile-${Date.now()}`, {
  headless: false,
  executablePath: "/usr/bin/google-chrome",
  env: { ...process.env, DISPLAY: `:${displayNum}` },
  viewport: null,
  args: ["--window-position=0,0", "--window-size=1280,1024", "--no-first-run", "--no-default-browser-check", "--password-store=basic"],
});
const tryHit = async (cdp, x, y) => {
  try {
    await cdp.send("DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: true });
    return "OK";
  } catch (e) {
    return "FAIL";
  }
};
try {
  console.log("pages at start:", browser.pages().length);
  const page = await browser.newPage();
  console.log("pages after newPage:", browser.pages().length, browser.pages().map((p) => p.url()));
  await page.setContent(`<style>body{margin:0;background:#eee}</style><div id="box" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
  let cdp = await page.context().newCDPSession(page);
  console.log("baseline (no focus/move):", await tryHit(cdp, 150, 130));
  await page.bringToFront();
  console.log("after bringToFront:", await tryHit(cdp, 150, 130));
  await cdp.send("Page.bringToFront", {}).catch(() => {});
  console.log("after CDP Page.bringToFront:", await tryHit(cdp, 150, 130));
  await page.mouse.move(150, 130);
  console.log("after mouse.move:", await tryHit(cdp, 150, 130));
  await page.mouse.move(400, 400);
  await page.mouse.move(150, 130);
  console.log("after mouse.move around:", await tryHit(cdp, 150, 130));
  await page.focus("#box").catch(() => {});
  console.log("after focus:", await tryHit(cdp, 150, 130));
  // new CDP session
  cdp.detach().catch(() => {});
  const cdp2 = await page.context().newCDPSession(page);
  console.log("fresh CDP session:", await tryHit(cdp2, 150, 130));
  // Emulation visibility?
  await cdp2.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  console.log("after focus emulation:", await tryHit(cdp2, 150, 130));
  // check visibility state as the page sees it
  console.log("document.visibilityState:", await page.evaluate("document.visibilityState"));
  console.log("hasFocus:", await page.evaluate("document.hasFocus()"));
} finally {
  await browser.close().catch(() => {});
  xvfb.kill();
}
