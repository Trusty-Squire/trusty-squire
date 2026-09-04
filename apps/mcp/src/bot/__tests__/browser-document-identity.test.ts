// Real-Chromium test for the PRIMARY half of the observation epoch: what the
// browser reports as the identity of the main document (docs/observation-model.md
// §9). The load-bearing claim is a Playwright detail that cannot be faked with a
// stub — `framenavigated` fires for History API navigations as well as real
// ones, while `domcontentloaded` fires once per real main-frame document. Keying
// document identity on the former made a checkout SPA's own `replaceState`
// churn retire every operator ref mid-form; keying it on the latter does not,
// and a genuine document replacement still moves it.
//
// The epoch's other half (the normalized origin+pathname backstop, which is what
// retires refs on a same-document route change to a different logical page) is
// covered with a mocked browser in operate-session-flow.test.ts.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrowserController } from "../browser.js";

let httpServer: Server;
let browser: Browser;
let page: Page;
let controller: BrowserController;
let port: number;

beforeAll(async () => {
  httpServer = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body><input name="firstName" /></body></html>`);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as AddressInfo).port;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  controller = BrowserController.fromHarnessPage(page);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("main document identity", () => {
  it("holds across same-document history churn and moves on a real navigation", async () => {
    const base = `http://127.0.0.1:${port}`;
    await page.goto(`${base}/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information`);
    const opened = controller.mainDocumentIdentity();

    // The exact shape a live Shopify checkout produces while an address block
    // is being filled: it rewrites its own volatile path token, and its router
    // pushes the next step. Both are `framenavigated`; neither is a new
    // document, so neither may move the identity.
    await page.evaluate(() =>
      history.replaceState({}, "", "/checkouts/cn/8kQm4Xd1pWvB6nHy3LrTzE/information?_r=2"),
    );
    await page.evaluate(() =>
      history.pushState({}, "", "/checkouts/cn/8kQm4Xd1pWvB6nHy3LrTzE/shipping"),
    );
    await page.waitForTimeout(50);
    expect(controller.mainDocumentIdentity()).toBe(opened);

    // A real navigation replaces the document and must move it, even when the
    // page it lands on is served from the very same URL.
    await page.goto(`${base}/other`);
    const navigated = controller.mainDocumentIdentity();
    expect(navigated).not.toBe(opened);
    await page.reload();
    expect(controller.mainDocumentIdentity()).not.toBe(navigated);
  }, 60_000);
});
