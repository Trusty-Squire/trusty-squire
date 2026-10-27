// Real-browser check of approvals.open(): the popup and sheet paths across two
// origins, with the page posting its decision the way the Squire approval
// page does (apps/web/app/lib/approval-embed.ts).
//
//   pnpm -F @trusty-squire/sdk test:browser
//
// Host app:      http://127.0.0.1:<port>   loads dist/index.js
// Squire stand-in: http://localhost:<port> serves /vault/fetch/<id>

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist");
const APPROVAL_ID = "01JDBROWSERTEST0000000000A";

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const HOST_PAGE = (squireOrigin) => `<!doctype html>
<meta charset="utf-8"><title>Host app</title>
<button id="popup">Approve in popup</button>
<button id="sheet">Approve in sheet</button>
<script type="module">
  import { openApproval } from "/sdk/index.js";
  const approval = { id: "${APPROVAL_ID}", approveUrl: "${squireOrigin}/vault/fetch/${APPROVAL_ID}" };
  window.outcomes = [];
  for (const mode of ["popup", "sheet"]) {
    document.getElementById(mode).addEventListener("click", () => {
      openApproval(approval, { mode, closeDelayMs: 0 }).then(
        (outcome) => window.outcomes.push({ mode, ...outcome }),
        (error) => window.outcomes.push({ mode, error: error.code ?? String(error) }),
      );
    });
  }
</script>`;

// The approval page's side of the protocol: post to the opener (popup) or the
// parent (sheet), addressed to return_origin only.
const SQUIRE_PAGE = `<!doctype html>
<meta charset="utf-8"><title>Squire approval</title>
<p id="mode"></p>
<button id="decide">Approve with passkey</button>
<script>
  const params = new URLSearchParams(location.search);
  const mode = params.get("embed");
  const returnOrigin = params.get("return_origin");
  const id = location.pathname.split("/").pop();
  document.getElementById("mode").textContent = mode + " " + returnOrigin;
  const host = mode === "popup" ? window.opener : window.parent;
  document.getElementById("decide").addEventListener("click", () => {
    // A message for another approval must be ignored by the SDK.
    host.postMessage({ source: "trusty-squire", type: "approval.decision", approvalId: "other", status: "denied" }, returnOrigin);
    host.postMessage({ source: "trusty-squire", type: "approval.decision", approvalId: id, status: "approved" }, returnOrigin);
    if (mode === "popup") setTimeout(() => window.close(), 50);
  });
</script>`;

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

const squire = await listen((req, res) => {
  if (req.url?.startsWith(`/vault/fetch/${APPROVAL_ID}`)) {
    res.writeHead(200, { "content-type": "text/html" }).end(SQUIRE_PAGE);
    return;
  }
  res.writeHead(404).end();
});
const squireOrigin = `http://localhost:${squire.address().port}`;

const host = await listen(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" }).end(HOST_PAGE(squireOrigin));
    return;
  }
  if (url.pathname.startsWith("/sdk/")) {
    const file = normalize(join(dist, url.pathname.slice("/sdk/".length)));
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  res.writeHead(404).end();
});
const hostOrigin = `http://127.0.0.1:${host.address().port}`;

// Playwright's own Chromium when installed, else the system Chrome.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(hostOrigin);
  const outcomes = () => page.evaluate(() => window.outcomes);

  // 1. Popup: approve inside the popup; the host resolves with the decision.
  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#popup")]);
  await popup.waitForLoadState();
  const popupUrl = new URL(popup.url());
  assert(popupUrl.origin === squireOrigin, "popup opens the Squire origin");
  assert(popupUrl.searchParams.get("embed") === "popup", "popup carries embed=popup");
  assert(popupUrl.searchParams.get("return_origin") === hostOrigin, "popup carries the host origin");
  await Promise.all([popup.waitForEvent("close"), popup.click("#decide")]);
  await page.waitForFunction(() => window.outcomes.length === 1);
  const [approved] = await outcomes();
  assert(
    approved.mode === "popup" && approved.status === "approved" && approved.approvalId === APPROVAL_ID,
    "host receives the popup's decision and ignores the other approval's message",
  );

  // 2. Popup closed without a decision resolves dismissed.
  const [second] = await Promise.all([context.waitForEvent("page"), page.click("#popup")]);
  await second.waitForLoadState();
  await second.close();
  await page.waitForFunction(() => window.outcomes.length === 2, null, { timeout: 5_000 });
  assert((await outcomes())[1].status === "dismissed", "closing the popup resolves dismissed");

  // 3. Sheet: an iframe with the passkey permission and the visible address.
  await page.click("#sheet");
  const frameElement = await page.waitForSelector("[data-trusty-squire-sheet] iframe");
  const allow = await frameElement.getAttribute("allow");
  assert(allow.includes(`publickey-credentials-get ${squireOrigin}`), "sheet iframe allows passkeys for Squire only");
  const address = await page.textContent("[data-trusty-squire-address]");
  assert(address === `localhost:${squire.address().port}/vault/fetch/${APPROVAL_ID}`, "sheet shows the page address");
  const frame = await frameElement.contentFrame();
  await frame.waitForSelector("#decide");
  await frame.click("#decide");
  await page.waitForFunction(() => window.outcomes.length === 3);
  assert((await outcomes())[2].status === "approved", "host receives the sheet's decision");
  await page.waitForSelector("[data-trusty-squire-sheet]", { state: "detached" });
  assert(true, "sheet closes after the decision");
  console.log("PASS popup.browser");
} finally {
  await browser.close();
  host.close();
  squire.close();
}
