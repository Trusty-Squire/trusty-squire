// What de-primes hit-testing? Does priming survive navigation/scroll?
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
const tryHit = async (cdp, x, y) => {
  try {
    const hit = await cdp.send("DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: true });
    let node;
    try {
      node = await cdp.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId });
    } catch (e) {
      return `GETNODE_OK RESOLVE_FAIL: ${e.message.split("\n")[0]}`;
    }
    if (!node.object || !node.object.objectId) return `GETNODE_OK RESOLVE_NO_OBJECT ${JSON.stringify(node).slice(0, 200)}`;
    try {
      const tag = await cdp.send("Runtime.callFunctionOn", {
        objectId: node.object.objectId,
        functionDeclaration: "function(){ const el=this.nodeType===1?this:this.parentElement; return el ? (el.id || el.tagName) : 'none'; }",
        returnByValue: true,
      });
      return `OK ${JSON.stringify(tag.result.result.value)}`;
    } catch (e) {
      return `GETNODE_OK CALLFN_FAIL: ${e.message.split("\n")[0]}`;
    }
  } catch (e) {
    return `GETNODE_FAIL: ${e.message.split("\n")[0]}`;
  }
};
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await page.setContent(`<style>body{margin:0;height:3000px;background:#eee}</style><div id="box" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:blue"></div>`);
  console.log("1. fresh page, no input:", await tryHit(cdp, 150, 130));
  await page.mouse.move(150, 130);
  console.log("2. after mouse.move:", await tryHit(cdp, 150, 130));
  await page.evaluate(() => scrollTo(0, 0));
  console.log("3. after JS scroll:", await tryHit(cdp, 150, 130));
  await page.setContent(`<style>body{margin:0;height:3000px;background:#ddd}</style><div id="box2" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:red"></div>`);
  console.log("4. after re-setContent (same doc replace):", await tryHit(cdp, 150, 130));
  await page.goto("data:text/html,<style>body{margin:0;background:#eee}</style><div id=\"box3\" style=\"position:absolute;left:100px;top:100px;width:200px;height:60px;background:green\"></div>");
  console.log("5. after goto navigation:", await tryHit(cdp, 150, 130));
  await page.mouse.move(150, 130);
  console.log("6. after mouse.move post-nav:", await tryHit(cdp, 150, 130));
  await page.evaluate(() => scrollTo(0, 500));
  await page.evaluate(() => scrollTo(0, 0));
  console.log("7. after JS scroll down+up:", await tryHit(cdp, 150, 130));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 300 });
  console.log("8. after raw Input mouseMoved:", await tryHit(cdp, 150, 130));
  // does keyboard input prime it?
  await page.goto("data:text/html,<div id=\"box4\" style=\"position:absolute;left:100px;top:100px;width:200px;height:60px;background:purple\"></div>");
  console.log("9. after nav:", await tryHit(cdp, 150, 130));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "Shift" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "Shift" });
  console.log("10. after key event:", await tryHit(cdp, 150, 130));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: 100 });
  console.log("11. after wheel event:", await tryHit(cdp, 150, 130));
  // mouse press also?
  await page.goto("data:text/html,<div id=\"box5\" style=\"position:absolute;left:100px;top:100px;width:200px;height:60px;background:orange\"></div>");
  console.log("12. after nav:", await tryHit(cdp, 150, 130));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 300, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: 300, button: "left", clickCount: 1 });
  console.log("13. after press/release:", await tryHit(cdp, 150, 130));
} finally {
  await browser.close().catch(() => {});
  xvfb.kill();
}
