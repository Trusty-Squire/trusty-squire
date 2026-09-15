// Matrix: which variable flips DOM.getNodeForLocation from FAIL to OK in headed Chrome?
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
const tryHit = async (cdp) => {
  try {
    await cdp.send("DOM.getNodeForLocation", { x: 150, y: 130, includeUserAgentShadowDOM: true });
    return "OK";
  } catch {
    return "FAIL";
  }
};
const cases = [
  ["1 scrollable + no primer", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
  }],
  ["2 scrollable + mouse.move", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.mouse.move(150, 130);
  }],
  ["3 scrollable + mouse.move + 300ms", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.mouse.move(150, 130);
    await new Promise((r) => setTimeout(r, 300));
  }],
  ["4 non-scrollable + mouse.move", async (p, c) => {
    await p.setContent(`<style>body{margin:0}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.mouse.move(150, 130);
    await new Promise((r) => setTimeout(r, 300));
  }],
  ["5 scrollable + bringToFront", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.bringToFront();
    await new Promise((r) => setTimeout(r, 300));
  }],
  ["6 scrollable + goto data: + mouse.move", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.goto(`data:text/html,<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.mouse.move(150, 130);
    await new Promise((r) => setTimeout(r, 300));
  }],
  ["7 scrollable + goto http route + mouse.move", async (p, c) => {
    await p.route("http://fixture.test/", (route) => route.fulfill({ contentType: "text/html", body: `<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>` }));
    await p.goto("http://fixture.test/");
    await p.mouse.move(150, 130);
    await new Promise((r) => setTimeout(r, 300));
  }],
  ["8 scrollable + captureScreenshot + mouse.move", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await c.send("Page.captureScreenshot", { format: "png", fromSurface: true }).catch(() => {});
    await p.mouse.move(150, 130);
    await new Promise((r) => setTimeout(r, 300));
  }],
  ["9 scrollable + mouse.move at 400,400 (not on box)", async (p, c) => {
    await p.setContent(`<style>body{margin:0;height:3000px}</style><div id="bx" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
    await p.mouse.move(400, 400);
    await new Promise((r) => setTimeout(r, 300));
  }],
];
try {
  for (const [name, fn] of cases) {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await fn(page, cdp);
    console.log(name, "=>", await tryHit(cdp));
  }
} finally {
  await browser.close().catch(() => {});
  xvfb.kill();
}
