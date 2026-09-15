// Isolate the primer for DOM.getNodeForLocation in headed Chrome.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", "720x1280x24", "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launchPersistentContext(`/tmp/c2-diag/profile-${Date.now()}`, {
  headless: false,
  executablePath: "/usr/bin/google-chrome",
  env: { ...process.env, DISPLAY: `:${displayNum}` },
  viewport: null,
  args: ["--window-position=0,0", "--window-size=1280,1024", "--no-first-run", "--no-default-browser-check", "--password-store=basic"],
});
const mkPage = async () => {
  const page = await browser.newPage();
  await page.setContent(`<style>body{margin:0;background:#eee}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
  const cdp = await page.context().newCDPSession(page);
  return { page, cdp };
};
const tryHit = async (cdp) => {
  try {
    await cdp.send("DOM.getNodeForLocation", { x: 150, y: 130, includeUserAgentShadowDOM: true });
    return "OK";
  } catch {
    return "FAIL";
  }
};
try {
  {
    const { page, cdp } = await mkPage();
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, 300));
    console.log("A. bringToFront only:", await tryHit(cdp));
    await page.mouse.move(150, 130);
    console.log("A2. + mouse.move:", await tryHit(cdp));
  }
  {
    const { cdp } = await mkPage();
    await cdp.send("Page.bringToFront").catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    console.log("B. CDP Page.bringToFront only:", await tryHit(cdp));
  }
  {
    const { page, cdp } = await mkPage();
    await page.mouse.move(150, 130);
    await new Promise((r) => setTimeout(r, 300));
    console.log("C. mouse.move only:", await tryHit(cdp));
  }
  {
    const { page, cdp } = await mkPage();
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch((e) => console.log(e.message));
    await new Promise((r) => setTimeout(r, 300));
    console.log("D. focus emulation only:", await tryHit(cdp));
  }
  {
    const { page, cdp } = await mkPage();
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, 300));
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    console.log("E. bringToFront + focus emulation:", await tryHit(cdp));
    await page.mouse.move(150, 130);
    console.log("E2. + mouse.move:", await tryHit(cdp));
  }
  // Check active window state: is the browser window even focused on X?
  {
    const { page, cdp } = await mkPage();
    console.log("F. document.hasFocus():", await page.evaluate("document.hasFocus()"));
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, 500));
    console.log("F2. hasFocus after bringToFront:", await page.evaluate("document.hasFocus()"), "hit:", await tryHit(cdp));
  }
} finally {
  await browser.close().catch(() => {});
  xvfb.kill();
}
