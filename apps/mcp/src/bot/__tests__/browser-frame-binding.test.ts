// Real-Chromium regression for frame BINDING during uncommitted navigations
// (live ouraring.com purchase session: frame_binding_failed on framePaths 1
// and 2 from the first page load, never recovering; a third appeared at
// 3-D Secure).
//
// bindFrames matches CDP `Page.getFrameTree` children to Playwright
// `frame.childFrames()` by URL string equality. A frame whose navigation has
// not committed has NO stable URL: the CDP tree reports ":" while Playwright
// reports "". The strings never become equal while the navigation stays
// pending, so an ad/analytics/3DS iframe that renders before its navigation
// commits reported frame_binding_failed on every capture for the frame's
// whole life — the 1s retry in browser.ts cannot help because the mismatch is
// stable, not transient.
//
// A second, deliberate property: when a frame still cannot be read (e.g. it
// is removed and recreated mid-capture), the observation must NAME what was
// not read — the omission carries the iframe element's identity and the
// iframe's own row carries the fact — instead of leaving an unreadable
// region indistinguishable from a genuinely empty one.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureBrowserUseDOM, type BrowserUseCapture } from "../browser-use-capture.js";
import type { BrowserUseNode } from "../browser-use-serializer.js";

const PARENT_HOST = "example.com";
const CHILD_HOST = "example.org";

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

let server: Server;
let port: number;
let browser: Browser | undefined;
let pendingChildResponses: Array<() => void> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = (req.url ?? "").split("?")[0];
    if (url === "/parent") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><html><body><main>Merchant</main>` +
          // Same-site frame whose navigation never commits (the live defect).
          `<iframe id="pending-same" src="http://${PARENT_HOST}:${port}/hang" ` +
          'style="width:300px;height:120px;border:0"></iframe>' +
          // Cross-site (OOPIF) frame whose navigation never commits.
          `<iframe id="pending-cross" src="http://${CHILD_HOST}:${port}/hang" ` +
          'style="width:300px;height:120px;border:0"></iframe>' +
          // XFO-blocked frame — a committed URL on both sides; must bind.
          `<iframe id="blocked" src="http://${PARENT_HOST}:${port}/xfo" ` +
          'style="width:300px;height:120px;border:0"></iframe>' +
          "</body></html>",
      );
    } else if (url === "/child") {
      res.setHeader("content-type", "text/html");
      res.end(
        "<!doctype html><html><body><button name=\"child-button\">Child</button></body></html>",
      );
    } else if (url === "/hang") {
      // Never respond until the test releases the socket — the navigation
      // stays pending for as long as the capture needs it to.
      pendingChildResponses.push(() => {
        res.setHeader("content-type", "text/html");
        res.end(
          "<!doctype html><html><body><button name=\"child-button\">Child</button></body></html>",
        );
      });
    } else if (url === "/xfo") {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><html><body>denied</body></html>");
    } else {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html");
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  if (available) {
    browser = await chromium.launch({
      headless: true,
      // Force site isolation so the cross-site pending frame is a real OOPIF —
      // the ouraring 3-D Secure shape — not merely a same-process frame.
      args: [
        "--site-per-process",
        `--host-resolver-rules=MAP ${PARENT_HOST} 127.0.0.1,MAP ${CHILD_HOST} 127.0.0.1`,
      ],
    });
  }
});

afterAll(async () => {
  await browser?.close();
  // /hang sockets never end on their own; drop them so close() can finish.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function iframes(n: BrowserUseNode): BrowserUseNode[] {
  const own = n.nodeName === "IFRAME" || n.nodeName === "FRAME" ? [n] : [];
  return [
    ...own,
    ...n.children.flatMap(iframes),
    ...(n.contentDocument ? iframes(n.contentDocument) : []),
  ];
}

async function capture(page: Page): Promise<BrowserUseCapture> {
  return captureBrowserUseDOM(page, [], (frame: Frame) => {
    const path: string[] = [];
    let current: Frame | null = frame;
    while (current !== null && current !== page.mainFrame()) {
      path.unshift(String(current.parentFrame()?.childFrames().indexOf(current) ?? -1));
      current = current.parentFrame();
    }
    return path.length === 0 ? null : path.join("/");
  });
}

describe("frame binding during uncommitted navigations (real Chromium, real HTTP)", () => {
  it.skipIf(!available)(
    "binds frames whose navigation never commits instead of reporting frame_binding_failed for the whole session",
    { timeout: 60_000 },
    async () => {
      const { page } = await newPage();
      try {
        pendingChildResponses = [];
        await page.goto(`http://${PARENT_HOST}:${port}/parent`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1_000);

        // Precondition: the pending navigations really are pending — the CDP
        // tree has no committed URL for them (the exact live failing shape).
        const client = await page.context().newCDPSession(page);
        const tree = await client.send("Page.getFrameTree");
        const urls: string[] = [];
        const walk = (node: { frame: { url: string }; childFrames?: unknown[] }): void => {
          urls.push(node.frame.url);
          for (const child of (node.childFrames ?? []) as Array<{ frame: { url: string } }>)
            walk(child);
        };
        walk(tree.frameTree as unknown as { frame: { url: string } });
        expect(urls.filter((url) => url === ":").length).toBeGreaterThanOrEqual(2);
        await client.detach();

        const first = await capture(page);
        expect(first.omissions).toEqual([]);

        // The pending frames' own rows still render as ordinary iframe rows —
        // an unreadable region must not silently disappear either.
        const rows = iframes(first.root).map((n) => n.attributes.id);
        expect(rows).toContain("pending-same");
        expect(rows).toContain("pending-cross");
      } finally {
        await page.context().close();
      }
    },
  );

  it.skipIf(!available)(
    "re-reads a pending frame once its navigation commits as the page settles",
    { timeout: 60_000 },
    async () => {
      const { page } = await newPage();
      try {
        pendingChildResponses = [];
        await page.goto(`http://${PARENT_HOST}:${port}/parent`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);

        const whilePending = await capture(page);
        expect(whilePending.omissions).toEqual([]);

        pendingChildResponses.splice(0).forEach((release) => release());
        await page.waitForTimeout(1_500);

        const settled = await capture(page);
        expect(settled.omissions).toEqual([]);
        // A frame that was pending at first load is now bound through its own
        // session: its content is read, not merely tolerated as empty.
        const childButton = settled.elements.find(
          (element) => element.name === "child-button",
        );
        expect(childButton).toBeDefined();
        expect(childButton?.framePath ?? null).not.toBeNull();
      } finally {
        await page.context().close();
      }
    },
  );

  it.skipIf(!available)(
    "names what was not read when a frame still cannot be read",
    { timeout: 120_000 },
    async () => {
      const { page } = await newPage();
      try {
        await page.goto(`http://${PARENT_HOST}:${port}/child`, { waitUntil: "domcontentloaded" });
        // Remove and recreate an iframe on a short timer so a capture running
        // concurrently straddles the swap; the doomed frame's accessibility
        // fetch then fails mid-capture. Bounded retry: most runs observe it
        // within a few captures.
        await page.evaluate(() => {
          const f = document.createElement("iframe");
          f.id = "churn";
          f.width = "200";
          f.height = "100";
          document.body.appendChild(f);
          setInterval(() => {
            const old = document.getElementById("churn");
            const fresh = old?.cloneNode() as HTMLIFrameElement;
            old?.remove();
            if (fresh) document.body.appendChild(fresh);
          }, 40);
        });

        let observed: BrowserUseCapture | undefined;
        for (let attempt = 0; attempt < 24 && observed === undefined; attempt += 1) {
          const result = await capture(page);
          if (result.omissions.length > 0) observed = result;
        }
        expect(observed).toBeDefined();
        expect(observed!.omissions[0]!.kind).toMatch(/^frame_(binding|accessibility)_failed$/);
        // The omission names the region that was not read — the iframe
        // element's identity, not a bare unmatchable url.
        expect(observed!.omissions[0]!.source).toBeDefined();
        expect(observed!.omissions[0]!.source!.id).toBe("churn");
        // And the row itself carries the fact, so an unreadable frame is not
        // indistinguishable from a genuinely empty one.
        const unread = iframes(observed!.root).filter((n) =>
          n.scrollText.startsWith("frame content not read"),
        );
        expect(unread.length).toBeGreaterThanOrEqual(1);
      } finally {
        await page.context().close();
      }
    },
  );
});
