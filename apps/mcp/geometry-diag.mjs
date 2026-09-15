// Diagnostic: establish the real coordinate space behind "DOM.getNodeForLocation:
// No node found at given location" under the broker's geometry.
// Replicates: Xvfb screen 720x1280 (portrait), Chrome window --window-size=1280,1024
// at position 0,0 (window wider than the screen), page viewport ~1280x937.
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";

const SCREEN = process.env.SCREEN ?? "720x1280x24"; // broker Xvfb geometry
const WINDOW = process.env.WINDOW ?? "1280,1024"; // self-launch window size
const CTRL = process.env.CONTROL === "1"; // control run: window fits the screen

const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", SCREEN, "-nolisten", "tcp"], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1200));
const display = `:${displayNum}`;
console.log(`Xvfb ${display} screen=${SCREEN} window=${WINDOW} control=${CTRL}`);

const browser = await chromium.launchPersistentContext(`/tmp/c2-diag/profile-${Date.now()}`, {
  headless: false,
  executablePath: "/usr/bin/google-chrome",
  env: { ...process.env, DISPLAY: display },
  viewport: null,
  args: [
    "--window-position=0,0",
    `--window-size=${WINDOW}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
  ],
});
try {
  const page = await browser.newPage();
  await page.setContent(`<style>body{margin:0;height:4000px}</style>
    <button id="top" style="position:absolute;left:100px;top:50px;width:200px;height:60px">Top button</button>
    <button id="mid" style="position:absolute;left:100px;top:1200px;width:200px;height:60px">Mid button</button>
    <button id="low" style="position:absolute;left:100px;top:3800px;width:200px;height:60px">Low button</button>
    <a id="link" href="#" style="position:absolute;left:600px;top:3850px;width:400px;height:40px">Wide link</a>`);
  const cdp = await page.context().newCDPSession(page);

  const probe = async (label) => {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const vv = metrics.cssVisualViewport;
    const lv = metrics.cssLayoutViewport;
    let shot;
    try {
      shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    } catch (e) {
      console.log(`   captureScreenshot fromSurface failed: ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: "/tmp/c2-diag/pw-fallback.png" }).catch((e2) =>
        console.log(`   playwright fallback also failed: ${e2.message.split("\n")[0]}`),
      );
      try {
        shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: 1 },
        });
        console.log("   clip retry succeeded");
      } catch (e3) {
        console.log(`   clip retry failed: ${e3.message.split("\n")[0]}`);
      }
    }
    if (!shot) {
      console.log(`\n== ${label}: no image; visualViewport=${vv.clientWidth}x${vv.clientHeight}`);
      return;
    }
    const buf = Buffer.from(shot.data, "base64");
    const img = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    console.log(
      `\n== ${label}: scroll=(${vv.pageX},${vv.pageY}) visualViewport=${vv.clientWidth}x${vv.clientHeight} scale=${vv.scale ?? 1} layout=${lv.clientWidth}x${lv.clientHeight} image=${img.w}x${img.h}`,
    );
    if (CTRL) return;
    // Probe every node with its bounding box via a JS side channel.
    const boxes = await page.evaluate(() =>
      ["top", "mid", "low", "link"].map((id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        return { id, x: b.x, y: b.y, w: b.width, h: b.height };
      }),
    );
    for (const b of boxes) {
      if (b.y + b.h < 0 || b.y >= vv.clientHeight) {
        console.log(`   #${b.id} offscreen (y=${b.y}) — skipped`);
        continue;
      }
      const cx = Math.round(b.x + b.w / 2);
      const cy = Math.round(b.y + b.h / 2);
      const attempts = [
        ["viewport-css", cx, cy],
        ["doc-css", cx, cy + vv.pageY],
      ];
      for (const [space, x, y] of attempts) {
        try {
          const hit = await cdp.send("DOM.getNodeForLocation", {
            x,
            y,
            includeUserAgentShadowDOM: true,
          });
          const node = await cdp.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId });
          const tag = await cdp.send("Runtime.callFunctionOn", {
            objectId: node.object.objectId,
            functionDeclaration: "function(){ const el=this.nodeType===1?this:this.parentElement; return el ? (el.id || el.tagName) : 'none'; }",
            returnByValue: true,
          });
          console.log(
            `   #${b.id} @(${x},${y}) [${space}] -> OK ${JSON.stringify(tag.result.result.value)}`,
          );
        } catch (e) {
          console.log(`   #${b.id} @(${x},${y}) [${space}] -> FAIL ${e.message.split("\n")[0]}`);
        }
      }
    }
  };

  await probe("scroll 0 (top button visible, right-side link partially offscreen-left? window wider than screen)");
  await page.evaluate(() => scrollTo(0, 1100));
  await page.waitForTimeout(200);
  await probe("scrolled to mid button");
  await page.evaluate(() => scrollTo(0, 3600));
  await page.waitForTimeout(200);
  await probe("scrolled near bottom");
} finally {
  await browser.close().catch(() => {});
  xvfb.kill();
}
console.log("\nxdotool-style check: window geometry as X sees it:");
