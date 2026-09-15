// Theory: DOM.getNodeForLocation fails ("No node found") when the point lands
// on a cross-origin out-of-process iframe. Deterministic if true.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 937 } });
await page.route("http://outer.test/", (r) => r.fulfill({ contentType: "text/html", body: `<style>body{margin:0}</style><iframe src="http://inner.test/" style="position:absolute;left:0;top:0;width:400px;height:300px;border:0"></iframe><button id="b" style="position:absolute;left:500px;top:100px;width:200px;height:60px" onclick="window.e=window.e||[];window.e.push(1)">B</button>` }));
await page.route("http://inner.test/", (r) => r.fulfill({ contentType: "text/html", body: `<body style="margin:0;background:#9cf"><h1>OOPIF</h1></body>` }));
await page.goto("http://outer.test/");
await page.waitForTimeout(500);
const cdp = await (await page.context().newCDPSession(page));
for (const [label, x, y] of [["over-iframe", 200, 150], ["over-button", 600, 130], ["over-body", 700, 700]]) {
  try { const hit = await cdp.send("DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: true }); console.log(`${label} -> OK backend=${hit.backendNodeId}`); }
  catch (e) { console.log(`${label} -> FAIL ${e.message.split("\n")[0]}`); }
}
await browser.close();
