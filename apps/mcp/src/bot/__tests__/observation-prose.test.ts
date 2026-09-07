import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// The former separate-prose-channel tests now exercise its replacement through
// real Chrome: CDP capture -> canonical serializer -> shared substring screen.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { captureBrowserUseDOM } from "../browser-use-capture.js";
import { serializeBrowserUseDOM } from "../browser-use-serializer.js";
import { buildSafeControlsV2, screenBrowserUseValueV2 } from "../compact-observation-v2.js";
let browser: Browser;
const transparentFrameSecurity = async (): Promise<{ opaque: boolean }> => ({ opaque: false });
const captureThroughController = async (page: Page) => {
  const controller = new BrowserController({ humanize: false });
  (controller as unknown as { page: Page }).page = page;
  return controller.extractBrowserUseObservation();
};
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
describe("interleaved observation DOM", () => {
  it("keeps hierarchy and prose and retrieves a below-the-fold control from the whole document", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(
        '<!doctype html><html><body><p>Account overview</p><button><span>Continue signup</span></button><div style="height:1800px"></div><button id="below">Create workspace below</button></body></html>',
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const dom = serializeBrowserUseDOM(capture.root).dom;
      expect(dom).toContain("Account overview");
      expect(dom).toMatch(/\[main:\d+\]<button \/>\n\tContinue signup/);
      expect(dom).not.toContain("Create workspace below");
      expect(capture.moreBelow).toBe(true);
      expect(capture.moreAbove).toBe(false);
      const below = capture.elements.find((e) => e.id === "below");
      expect(below?.visibleText).toContain("Create workspace below");
      expect(below?.inViewport).toBe(false);
      await page.locator(below!.selector).scrollIntoViewIfNeeded();
      const after = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      expect(serializeBrowserUseDOM(after.root).dom).toContain("Create workspace below");
      expect(after.moreAbove).toBe(true);
    } finally {
      await page.close();
    }
  });
  it("keeps capture geometry in CSS pixels on a scaled display after scrolling", async () => {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    try {
      await page.setContent(
        '<!doctype html><html><body><div style="height:1800px"></div><button id="below">Still below the fold</button><div style="height:1200px"></div></body></html>',
      );
      await page.evaluate(() => window.scrollTo(0, 600));
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const below = capture.elements.find((element) => element.id === "below");
      expect(below?.inViewport).toBe(false);
      expect(serializeBrowserUseDOM(capture.root).dom).not.toContain("Still below the fold");
      expect(capture.moreAbove).toBe(true);
      expect(capture.moreBelow).toBe(true);
    } finally {
      await context.close();
    }
  });
  it("binds controls in same-origin and cross-origin frames to their own documents", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/child"
          ? '<button id="child">Cross origin action</button>'
          : request.url === "/same"
            ? '<button id="same">Same origin action</button>'
            : `<iframe src="/same"></iframe><iframe src="http://localhost:${(server.address() as AddressInfo).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const capture = await captureThroughController(page);
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          expect(element, `unbound frame control ${node.id}`).toBeDefined();
          return `@e:${element!.index}`;
        },
      });
      expect(output.dom).toContain("Same origin action");
      expect(output.dom).toContain("Cross origin action");
      const child = capture.elements.find((element) => element.id === "child")!;
      const same = capture.elements.find((element) => element.id === "same")!;
      expect(child.frameUrl).toContain("http://localhost:");
      expect(same.frameUrl).toContain("http://127.0.0.1:");
      await page
        .frames()
        .find((frame) => frame.url() === child.frameUrl)!
        .locator(child.selector)
        .click();
      await page
        .frames()
        .find((frame) => frame.url() === same.frameUrl)!
        .locator(same.selector)
        .click();
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps a sandboxed synthesized control visible but outside action and query maps", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/child"
          ? '<span id="cross" onclick="window.clicked = true">Permitted cross-origin action</span>'
          : request.url === "/same"
            ? '<span id="same" onclick="window.clicked = true">Same-origin action</span>'
            : `<iframe src="/same"></iframe><iframe sandbox="allow-scripts" srcdoc='<span id="opaque" onclick="window.clicked = true">Opaque sandbox action</span>'></iframe><iframe src="http://localhost:${(server.address() as AddressInfo).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const capture = await captureThroughController(page);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? handles.get(element)!
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });

      expect(capture.elements.map((element) => element.id)).toEqual(
        expect.arrayContaining(["same", "cross"]),
      );
      expect(capture.elements.some((element) => element.id === "opaque")).toBe(false);
      expect(safe.rows.map((row) => row.ref)).toEqual([...safe.byRef.keys()]);
      expect(
        safe.rows.map(
          (row) => capture.elements.find((element) => handles.get(element) === row.ref)?.id,
        ),
      ).toEqual(expect.arrayContaining(["same", "cross"]));
      expect(output.dom).toContain("not-targetable=true");
      expect(output.dom).toContain("Opaque sandbox action");
      const sameFrame = page.frames().find((frame) => frame.url().endsWith("/same"));
      await sameFrame!.locator("#same").click();
      await page
        .frames()
        .find((frame) => frame.url().includes("localhost:"))!
        .locator("#cross")
        .click();
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps active-origin opaque controls visible but outside action and query maps", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/normal"
          ? '<span id="normal-action" onclick="window.clicked = true">Normal frame action</span>'
          : request.url === "/opaque"
            ? '<span id="opaque-action" onclick="window.clicked = true">Active-origin opaque action</span>'
            : '<iframe src="/normal"></iframe><iframe id="opaque-frame" sandbox="allow-scripts" src="/opaque"></iframe>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await page.locator("#opaque-frame").evaluate((frame) => frame.removeAttribute("sandbox"));

      const capture = await captureThroughController(page);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? handles.get(element)!
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });

      expect(capture.elements.map((element) => element.id)).toContain("normal-action");
      expect(capture.elements.some((element) => element.id === "opaque-action")).toBe(false);
      expect(
        safe.rows.map(
          (row) => capture.elements.find((element) => handles.get(element) === row.ref)?.id,
        ),
      ).toContain("normal-action");
      expect(output.dom).toContain("Active-origin opaque action");
      expect(output.dom).toContain("not-targetable=true");
      await page
        .frames()
        .find((frame) => frame.url().endsWith("/normal"))!
        .locator("#normal-action")
        .click();
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps null-origin frame controls visible but outside action and query maps", async () => {
    const page = await browser.newPage();
    try {
      const dataDocument = encodeURIComponent(
        '<span id="data-action" onclick="window.clicked = true">Data opaque action</span>',
      );
      await page.setContent(
        `<iframe id="blank-frame"></iframe><iframe srcdoc='<span id="srcdoc-action" onclick="window.clicked = true">Srcdoc opaque action</span>'></iframe><iframe src="data:text/html,${dataDocument}"></iframe>`,
      );
      const blankHandle = await page.locator("#blank-frame").elementHandle();
      const blankFrame = await blankHandle!.contentFrame();
      await blankFrame!.setContent(
        '<span id="blank-action" onclick="window.clicked = true">Blank opaque action</span>',
      );

      const capture = await captureThroughController(page);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? handles.get(element)!
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });

      expect(
        capture.elements.some((element) =>
          ["blank-action", "srcdoc-action", "data-action"].includes(element.id ?? ""),
        ),
      ).toBe(false);
      expect(safe.rows).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("Blank opaque action") }),
          expect.objectContaining({ text: expect.stringContaining("Srcdoc opaque action") }),
          expect.objectContaining({ text: expect.stringContaining("Data opaque action") }),
        ]),
      );
      expect(output.dom).toContain("Blank opaque action");
      expect(output.dom).toContain("Srcdoc opaque action");
      expect(output.dom).toContain("Data opaque action");
      expect(output.dom.match(/not-targetable=true/g)).toHaveLength(3);
    } finally {
      await page.close();
    }
  });
  it("keeps an unbindable closed-shadow control visible without disabling the rest of the fixture", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        readFileSync(new URL("./fixtures/shadow-unbound.html", import.meta.url), "utf8"),
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      expect(output.dom).toContain("Complete page before web components");
      expect(output.dom).toContain("Complete page after web components");
      expect(output.dom).toContain("closed shadow action");
      expect(output.refs).toHaveLength(3);
      expect(output.dom).toMatch(/\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/);
      expect(capture.elements.some((element) => element.id === "closed")).toBe(false);
      const actionable = capture.elements.filter((element) =>
        ["outside", "open"].includes(element.id ?? ""),
      );
      expect(actionable).toHaveLength(2);
      for (const element of actionable) await page.locator(element.selector).click();
      expect(
        await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked),
      ).toEqual(["outside", "open"]);
    } finally {
      await page.close();
    }
  });
  it("preserves contained input, onclick, aria-label and text; screens every rendered line", async () => {
    const page = await browser.newPage();
    try {
      const token = "f9a062f02fad" + "f5";
      await page.setContent(
        `<div role="button" style="width:600px;height:300px"><span>Context text</span><input aria-label="Email"><span onclick="void 0">Separate action</span><span role="button" aria-label="Copy ${token}">Token ${token}</span></div>`,
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const ref = (node: { id: string }): string => `@e:f9a062f02fadf5_${node.id}`;
      const original = serializeBrowserUseDOM(capture.root, { ref });
      const screened = serializeBrowserUseDOM(capture.root, {
        ref,
        screen: screenBrowserUseValueV2,
      });
      const dom = screened.dom;
      // The synthetic token occurs in both a naming attribute and a text node.
      // Structural refs deliberately contain the same shape and must survive.
      expect(screened.refs).toEqual(original.refs);
      const withoutRefs = (value: string): string => value.replace(/\[@e:[^\]]+\]</g, "[REF]<");
      expect(withoutRefs(dom)).toBe(withoutRefs(original.dom).replaceAll(token, "[redacted]"));
      expect(dom.split("\n")).toHaveLength(original.dom.split("\n").length);
      expect(dom).toContain("Context text");
      expect(dom).toContain("<input");
      expect(dom).toContain("Separate action");
      expect(dom).toContain("aria-label=Copy [redacted]");
      expect(dom).toContain("Token [redacted]");
      expect(withoutRefs(dom)).not.toContain(token);
    } finally {
      await page.close();
    }
  });
});
