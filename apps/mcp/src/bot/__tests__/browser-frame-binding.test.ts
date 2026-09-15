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
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
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
    } else if (url === "/checkout") {
      // The live checkout shape: a COMMITTED cross-site hosted field ahead of
      // the pending frames. Page.getFrameTree omits the out-of-process child,
      // so the CDP child list is shorter than Playwright's and the two are not
      // index-aligned.
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><html><body><main>Checkout</main>` +
          `<iframe id="hosted-field" src="http://${CHILD_HOST}:${port}/child" ` +
          'style="width:300px;height:120px;border:0"></iframe>' +
          `<iframe id="pending-one" src="http://${PARENT_HOST}:${port}/hang" ` +
          'style="width:300px;height:120px;border:0"></iframe>' +
          `<iframe id="pending-two" src="http://${PARENT_HOST}:${port}/hang" ` +
          'style="width:300px;height:120px;border:0"></iframe>' +
          "</body></html>",
      );
    } else if (url === "/child") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<!doctype html><html><body><button name="child-button">Child</button></body></html>',
      );
    } else if (url === "/hang") {
      // Never respond until the test releases the socket — the navigation
      // stays pending for as long as the capture needs it to.
      pendingChildResponses.push(() => {
        res.setHeader("content-type", "text/html");
        res.end(
          '<!doctype html><html><body><button name="child-button">Child</button></body></html>',
        );
      });
    } else if (url === "/blank") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><html><body><main>Merchant</main></body></html>");
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
    "binds pending frames that sit behind a committed out-of-process sibling",
    { timeout: 60_000 },
    async () => {
      const { page } = await newPage();
      try {
        pendingChildResponses = [];
        await page.goto(`http://${PARENT_HOST}:${port}/checkout`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(1_500);

        // Precondition — the lists really are skewed: Playwright sees the
        // committed hosted field plus both pending frames, the CDP tree sees
        // only the two pending ones. Pairing by index into these two lists
        // would hand CDP child 0 to the hosted field and CDP child 1 to the
        // FIRST pending frame.
        const client = await page.context().newCDPSession(page);
        const tree = await client.send("Page.getFrameTree");
        const cdpChildUrls = (tree.frameTree.childFrames ?? []).map((c) => c.frame.url);
        await client.detach();
        const playwrightChildUrls = page
          .mainFrame()
          .childFrames()
          .map((f) => f.url());
        expect(cdpChildUrls).toEqual([":", ":"]);
        expect(playwrightChildUrls).toHaveLength(3);
        expect(playwrightChildUrls[0]).toContain(CHILD_HOST);

        const observed = await capture(page);
        expect(observed.omissions).toEqual([]);

        // Every frame is bound, each to its own path — the committed field
        // keeps its own content and neither pending frame is reported at it.
        const rows = iframes(observed.root).map((n) => n.attributes.id);
        expect(rows).toContain("hosted-field");
        expect(rows).toContain("pending-one");
        expect(rows).toContain("pending-two");
        const hostedButton = observed.elements.find((element) => element.name === "child-button");
        expect(hostedButton).toBeDefined();
        expect(hostedButton!.framePath).toBe("0");
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
        const childButton = settled.elements.find((element) => element.name === "child-button");
        expect(childButton).toBeDefined();
        expect(childButton?.framePath ?? null).not.toBeNull();
      } finally {
        await page.context().close();
      }
    },
  );

  it.skipIf(!available)(
    "observes an uncommitted frame that already has content instead of failing the capture",
    { timeout: 60_000 },
    async () => {
      const { page } = await newPage();
      try {
        pendingChildResponses = [];
        await page.goto(`http://${PARENT_HOST}:${port}/blank`, { waitUntil: "domcontentloaded" });
        // The 3-D Secure shape: the merchant points a frame at the ACS and
        // renders a control into its initial empty document while that POST is
        // still in flight. Binding the frame is what makes its content
        // reachable at all — and an uncommitted frame has no parseable url, so
        // every element built inside it has to report an origin anyway.
        await page.evaluate(
          ({ src }) => {
            const f = document.createElement("iframe");
            f.id = "threeds";
            f.style.cssText = "width:300px;height:120px;border:0";
            f.src = src;
            document.body.appendChild(f);
            const button = f.contentDocument!.createElement("button");
            button.id = "continue";
            button.textContent = "Continue";
            f.contentDocument!.body.appendChild(button);
          },
          { src: `http://${PARENT_HOST}:${port}/hang` },
        );
        await page.waitForTimeout(600);

        const observed = await capture(page);
        expect(observed.omissions).toEqual([]);
        const button = observed.elements.find((element) => element.id === "continue");
        expect(button).toBeDefined();
        // The initial empty document's origin has no serializable spelling;
        // "null" is the same opaque origin an about:blank frame reports. A
        // child-frame element must never report a null frameOrigin — that is
        // the main frame's spelling.
        expect(button!.frameOrigin).toBe("null");
        expect(button!.framePath).not.toBeNull();
      } finally {
        await page.context().close();
      }
    },
  );

  it.skipIf(!available)(
    "does not label a frame unread when its document did reach the tree",
    { timeout: 60_000 },
    async () => {
      const { page } = await newPage();
      try {
        pendingChildResponses = [];
        await page.goto(`http://${PARENT_HOST}:${port}/blank`, { waitUntil: "domcontentloaded" });
        // document.write into a frame with a pending navigation gives the
        // written document the PARENT's url, so the CDP tree and Playwright
        // disagree in a way no sentinel covers and the frame cannot bind — yet
        // the document is same-process, so it is pierced into the tree and
        // serialized under the iframe row.
        await page.evaluate(
          ({ src }) => {
            const f = document.createElement("iframe");
            f.id = "written";
            f.style.cssText = "width:300px;height:120px;border:0";
            f.src = src;
            document.body.appendChild(f);
            f.contentDocument!.write(
              "<!doctype html><html><body><button id='inside'>Inside</button></body></html>",
            );
            f.contentDocument!.close();
          },
          { src: `http://${PARENT_HOST}:${port}/hang` },
        );
        await page.waitForTimeout(600);

        const observed = await capture(page);
        const omission = observed.omissions.find((o) => o.source?.id === "written");
        expect(omission).toBeDefined();
        expect(omission!.kind).toBe("frame_binding_failed");

        const row = iframes(observed.root).find((n) => n.attributes.id === "written");
        expect(row).toBeDefined();
        // Its content IS in the tree, so the row must keep its ordinary
        // scroll affordance rather than claim the content was not read.
        expect(row!.contentDocument).not.toBeNull();
        expect(row!.scrollText).not.toContain("frame content not read");
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
        // Remove and recreate a cross-site (OOPIF) iframe on a short timer so
        // a capture running concurrently straddles the swap; the doomed
        // frame's bind/accessibility/attach step then fails mid-capture and
        // none of its document reaches the tree. Bounded retry: most runs
        // observe both halves within a handful of captures.
        await page.evaluate(
          ({ src }) => {
            const make = (): HTMLIFrameElement => {
              const f = document.createElement("iframe");
              f.id = "churn";
              f.width = "200";
              f.height = "100";
              f.src = src;
              return f;
            };
            document.body.appendChild(make());
            setInterval(() => {
              document.getElementById("churn")?.remove();
              document.body.appendChild(make());
            }, 40);
          },
          { src: `http://${CHILD_HOST}:${port}/child` },
        );

        let named: BrowserUseCapture["omissions"][number] | undefined;
        let unread: BrowserUseNode[] = [];
        for (
          let attempt = 0;
          attempt < 40 && (named === undefined || unread.length === 0);
          attempt += 1
        ) {
          const result = await capture(page);
          named ??= result.omissions.find((omission) => omission.source !== undefined);
          const marked = iframes(result.root).filter((n) =>
            n.scrollText.startsWith("frame content not read"),
          );
          if (marked.length > 0) unread = marked;
          // The marker says nothing was read, so it must never sit on a row
          // whose document did reach the tree.
          for (const node of marked) expect(node.contentDocument).toBeNull();
        }
        // The omission names the region that was not read — the iframe
        // element's identity, not a bare unmatchable url.
        expect(named).toBeDefined();
        expect(named!.kind).toMatch(/^frame_(binding|accessibility|attach)_failed$/);
        expect(named!.source!.id).toBe("churn");
        // And the row itself carries the fact, so an unreadable frame is not
        // indistinguishable from a genuinely empty one.
        expect(unread.map((n) => n.attributes.id)).toContain("churn");
      } finally {
        await page.context().close();
      }
    },
  );
});
