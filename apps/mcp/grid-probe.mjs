// Grid probe: find the coordinate space DOM.getNodeForLocation actually uses
// under broker geometry (Xvfb 720x1280 screen, window 1280x1024).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const SCREEN = process.env.SCREEN ?? "720x1280x24";
const WINDOW = process.env.WINDOW ?? "1280,1024";
const displayNum = 60 + Math.floor(Math.random() * 100);
const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", SCREEN, "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
console.log(`Xvfb :${displayNum} screen=${SCREEN} window=${WINDOW}`);

const browser = await chromium.launchPersistentContext(`/tmp/c2-diag/profile-${Date.now()}`, {
  headless: false,
  executablePath: "/usr/bin/google-chrome",
  env: { ...process.env, DISPLAY: `:${displayNum}` },
  viewport: null,
  args: ["--window-position=0,0", `--window-size=${WINDOW}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic"],
});
try {
  const page = await browser.newPage();
  await page.setContent(`<style>body{margin:0;height:4000px;background:#eee}</style>
    <div id="g1" style="position:absolute;left:100px;top:50px;width:200px;height:60px;background:red"></div>
    <div id="g2" style="position:absolute;left:100px;top:1200px;width:200px;height:60px;background:blue"></div>
    <div id="g3" style="position:absolute;left:100px;top:3800px;width:200px;height:60px;background:green"></div>`);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => scrollTo(0, 1100));
  await page.waitForTimeout(300);
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const vv = metrics.cssVisualViewport;
  console.log(`scroll=(${vv.pageX},${vv.pageY}) visualViewport=${vv.clientWidth}x${vv.clientHeight}`);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const buf = Buffer.from(shot.data, "base64");
  console.log(`image=${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);

  // Grid probe across the viewport in several candidate spaces.
  const grid = [];
  for (let x = 50; x <= 1250; x += 100) for (let y = 50; y <= 850; y += 100) grid.push([x, y]);
  const spaces = {
    "viewport-css": ([x, y]) => [x, y],
    "viewport+chromeH87": ([x, y]) => [x, y + 87],
    "viewport+chromeH100": ([x, y]) => [x, y + 100],
    "surface-image": ([x, y]) => [x, y], // same as viewport-css; surface is 1280 wide
    "window-x11": ([x, y]) => [x, y],
  };
  for (const [name, fn] of Object.entries(spaces)) {
    if (name !== "viewport-css" && name !== "viewport+chromeH87" && name !== "viewport+chromeH100") continue;
    let ok = 0, fail = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    for (const [x, y] of grid) {
      const [px, py] = fn([x, y]);
      try {
        await cdp.send("DOM.getNodeForLocation", { x: px, y: py, includeUserAgentShadowDOM: true });
        ok++; minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
      } catch { fail++; }
    }
    console.log(`${name}: ok=${ok} fail=${fail} okX=[${minx < 1e9 ? minx : "-"}..${maxx > -1 ? maxx : "-"}] okY=[${miny < 1e9 ? miny : "-"}..${maxy > -1 ? maxy : "-"}]`);
  }

  // Where does the blue box (viewport y=100..160, x=100..300) resolve?
  // And check whether the resolved node at a "chrome-offset" coordinate matches expectations.
  for (const [px, py] of [[150, 130], [150, 217], [150, 230], [700, 130], [900, 130], [1100, 130]]) {
    try {
      const hit = await cdp.send("DOM.getNodeForLocation", { x: px, y: py, includeUserAgentShadowDOM: true });
      const node = await cdp.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId });
      const tag = await cdp.send("Runtime.callFunctionOn", {
        objectId: node.object.objectId,
        functionDeclaration: "function(){ const el=this.nodeType===1?this:this.parentElement; return el ? (el.id || el.className || el.tagName) : 'none'; }",
        returnByValue: true,
      });
      console.log(`(${px},${py}) -> ${JSON.stringify(tag.result.result.value)}`);
    } catch (e) {
      console.log(`(${px},${py}) -> FAIL ${e.message.split("\n")[0]}`);
    }
  }
} finally {
  await browser.close().catch(() => {});
  xvfb.kill();
}
