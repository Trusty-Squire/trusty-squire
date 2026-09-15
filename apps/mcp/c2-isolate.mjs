import { chromium } from "playwright";
import { spawn } from "node:child_process";
const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", "720x1280x24", "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
const HTML = `<style>body{margin:0;height:4000px}</style><button id="b" style="position:absolute;left:100px;top:50px;width:200px;height:60px">B</button>`;
try {
  const browser = await chromium.launchPersistentContext(`/tmp/c2-diag/profile-iso-${Date.now()}`, {
    headless: false, executablePath: "/usr/bin/google-chrome",
    env: { ...process.env, DISPLAY: `:${displayNum}` }, viewport: null,
    args: ["--window-position=0,0", "--window-size=1280,1024", "--no-first-run", "--no-default-browser-check", "--password-store=basic"],
  });
  const context = browser;
  await new Promise((r) => setTimeout(r, 3000));
  const variants = [
    ["initial-page + goto", async () => { const p = context.pages()[0]; await p.goto("data:text/html," + encodeURIComponent(HTML)); return p; }],
    ["newPage + setContent", async () => { const p = await context.newPage(); await p.setContent(HTML); return p; }],
    ["newPage + goto data:", async () => { const p = await context.newPage(); await p.goto("data:text/html," + encodeURIComponent(HTML)); return p; }],
  ];
  for (const [label, make] of variants) {
    const page = await make();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable");
    let out;
    try {
      await cdp.send("DOM.getNodeForLocation", { x: 200, y: 80, includeUserAgentShadowDOM: true });
      out = "OK";
    } catch (e) { out = "FAIL " + e.message.split("\n")[0]; }
    console.log(`${label} -> ${out}`);
    await page.close().catch(() => {});
  }
  await browser.close();
  xvfb.kill();
  process.exit(0);
} catch (e) { console.error("HARNESS FAIL:", e.message); xvfb.kill(); process.exit(1); }
