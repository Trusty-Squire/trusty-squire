import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// The former separate-prose-channel tests now exercise its replacement through
// real Chrome: CDP capture -> canonical serializer with verbatim page content.
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserController, type InteractiveElement } from "../browser.js";
import { captureBrowserUseDOM } from "../browser-use-capture.js";
import { serializeBrowserUseDOM, type BrowserUseNode } from "../browser-use-serializer.js";
import { buildSafeControlsV2, StableObservationRefs } from "../compact-observation-v2.js";
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
  it("returns rendered API keys, app slugs, key names and documentation JSON verbatim", async () => {
    const page = await browser.newPage();
    // The first two are exact reported false positives. Key names and requestId
    // are synthetic representatives: the brief did not supply their literals.
    const values = [
      "usernametaken29",
      "trusty-squire-dogfood-20260625",
      "resend-dogfood-20260907",
      "trusty-squire-resend-20260907",
      '"requestId": "550e8400-e29b-41d4-a716-446655440000"',
      "sk" + "-proj-0123456789abcdefghijklmnop",
      "f9a062f0-2fadf5ab-9c1d2e3f",
      "key_3kR9xQ2m_7LpW4vZn",
    ];
    try {
      await page.setContent("<main></main>");
      await page.locator("main").evaluate((main, values) => {
        for (const value of values) {
          const paragraph = document.createElement("p");
          paragraph.textContent = value;
          const button = document.createElement("button");
          button.setAttribute("aria-label", value);
          button.textContent = value;
          const input = document.createElement("input");
          input.type = "text";
          input.value = value;
          main.append(paragraph, button, input);
        }
      }, values);
      const capture = await captureThroughController(page);
      const { dom } = serializeBrowserUseDOM(capture.root);
      for (const value of values) {
        expect(dom).toContain(value);
        expect(dom).toContain(`aria-label=${value}`);
        expect(dom).toContain(`value=${value}`);
      }
      expect(dom).not.toContain("[redacted]");
    } finally {
      await page.close();
    }
  });
  it("surfaces actual selection evidence while a stateless card stays reachable with its original ref", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        readFileSync(
          new URL("../../../../../fixtures/observation-efficiency/selectable-cards.html", import.meta.url),
          "utf8",
        ),
      );
      const refs = new StableObservationRefs();
      const capture = await captureThroughController(page);
      const ref = (n: BrowserUseNode): string => refs.get("doc", n.id);
      const before = serializeBrowserUseDOM(capture.root, { ref });
      const row = (dom: string, id: string): string =>
        dom.split("\n").find((line) => line.includes(`id=${id} `))!;
      const stateless = row(before.dom, "stateless");
      expect(stateless).not.toMatch(/(?:aria-pressed|aria-selected|data-state|selected|state_icons)=/);
      const stable = stateless.match(/\[([^\]]+)\]/)![1]!;
      const boundNode = [...capture.nodeElements].find(([id]) => refs.get("doc", id) === stable)![1];
      await page.locator(boundNode.selector).click();
      for (const id of ["pressed", "classified", "icon", "selected", "data"])
        await page.locator(`#${id}`).click();
      const after = serializeBrowserUseDOM((await captureThroughController(page)).root, { ref });
      expect(row(after.dom, "stateless")).toBe(stateless);
      expect(row(before.dom, "pressed")).toContain("aria-pressed=false");
      expect(row(after.dom, "pressed")).toContain("aria-pressed=true");
      expect(row(after.dom, "selected")).toContain("aria-selected=true");
      expect(row(after.dom, "data")).toContain("data-state=checked");
      expect(row(after.dom, "classified")).toContain("border-selected");
      expect(row(after.dom, "icon")).toContain('state_icons=["check-icon"]');
      expect(after.refs).toContain(stable);
      expect(
        await page.evaluate(
          () => (window as unknown as { cardClicks: Record<string, number> }).cardClicks.stateless,
        ),
      ).toBe(1);
      expect(row(after.dom, "classified")).not.toContain("selected=true");
    } finally {
      await page.close();
    }
  });
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
  it("uses only capped local context for below-fold iframe controls", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent('<iframe id="support" style="width: 400px; height: 100px"></iframe>');
      const frame = await (await page.locator("#support").elementHandle())!.contentFrame();
      const local = "Local support preference ".repeat(4);
      await frame!.setContent(
        `<section>Whole section context must not be inherited <div style="margin-top: 800px">${local}<span><button id="below"> </button></span></div></section>`,
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const findFrame = (node: BrowserUseNode): BrowserUseNode | undefined =>
        node.nodeName === "IFRAME"
          ? node
          : node.children.map(findFrame).find((value) => value !== undefined) ||
            (node.contentDocument ? findFrame(node.contentDocument) : undefined);
      const hint = findFrame(capture.root)?.hiddenElements.find((element) => element.tag === "button");
      expect(hint?.text).toBe(Array.from(local).slice(0, 40).join(""));
      expect(hint?.text).not.toContain("Whole section context");
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
  it("keeps an unmapped child control non-targetable when its selector collides with the main document", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button id="shared" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe srcdoc="<button id=shared>Child action</button>"></iframe>',
      );
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              const result = await send(method, params);
              if (method !== "Page.getFrameTree") return result;
              const tree = structuredClone(result) as {
                frameTree: { childFrames?: Array<{ frame: { url: string } }> };
              };
              tree.frameTree.childFrames![0]!.frame.url = "https://stale.example/child";
              return tree;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const newCDPSession = vi
        .spyOn(context, "newCDPSession")
        .mockImplementation(async (target) => {
          if (target === page) return intercepted;
          throw new Error("No frame with given id");
        });
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      } finally {
        newCDPSession.mockRestore();
      }
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      const lines = output.dom.split("\n");
      const childTextLine = lines.findIndex((line) => line.includes("Child action"));
      expect(childTextLine).toBeGreaterThan(0);
      expect(lines[childTextLine - 1]).toMatch(
        /\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/,
      );
      expect(capture.elements.some((element) => element.visibleText === "Child action")).toBe(
        false,
      );
      const main = capture.elements.find((element) => element.visibleText === "Main action")!;
      expect(main.framePath).toBeNull();
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
    }
  });
  it("keeps same-URL child navigation from rebinding a captured control", async () => {
    let childLoads = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/child") {
        childLoads += 1;
        response.end(
          childLoads === 1
            ? '<button id="shared">Captured child action</button>'
            : '<button id="shared">Replacement child action</button>',
        );
        return;
      }
      response.end(
        '<button id="main" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe src="/child"></iframe>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const childUrl = `${baseUrl}/child`;
      await page.goto(baseUrl);
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      let childFrameId: string | undefined;
      let navigated = false;
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              if (
                method === "Page.createIsolatedWorld" &&
                params?.frameId === childFrameId &&
                !navigated
              ) {
                navigated = true;
                await page
                  .frames()
                  .find((frame) => frame.url() === childUrl)!
                  .goto(childUrl);
              }
              const result = await send(method, params);
              if (method === "Page.getFrameTree") {
                const tree = result as {
                  frameTree: { childFrames?: Array<{ frame: { id: string } }> };
                };
                childFrameId = tree.frameTree.childFrames?.[0]?.frame.id;
              }
              return result;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const staleChild = {
        index: 7,
        tag: "button",
        type: null,
        id: "shared",
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: "button",
        labelText: null,
        visibleText: "Captured child action",
        selector: "#shared",
        visible: true,
        inViewport: true,
        inConsentWidget: false,
        framePath: "0",
      };
      const newCDPSession = vi.spyOn(context, "newCDPSession").mockResolvedValue(intercepted);
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(
          page,
          [staleChild],
          (frame) => (frame === page.mainFrame() ? null : "0"),
          transparentFrameSecurity,
        );
      } finally {
        newCDPSession.mockRestore();
      }
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      const lines = output.dom.split("\n");
      const capturedTextLine = lines.findIndex((line) => line.includes("Captured child action"));
      expect(childLoads).toBe(2);
      expect(capturedTextLine).toBeGreaterThan(0);
      expect(lines[capturedTextLine - 1]).toMatch(
        /\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/,
      );
      expect(
        capture.elements.some((element) => element.visibleText === "Captured child action"),
      ).toBe(false);
      expect(
        capture.elements.some((element) => element.visibleText === "Replacement child action"),
      ).toBe(false);
      const main = capture.elements.find((element) => element.visibleText === "Main action")!;
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps the parent observation usable when a child CDP session disappears during capture", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button id="main" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe srcdoc="<button id=child>Child action</button>"></iframe>',
      );
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      type CapturedNode = {
        nodeName: string;
        children?: CapturedNode[];
        contentDocument?: unknown;
      };
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              const result = await send(method, params);
              if (method !== "DOM.getDocument") return result;
              const document = structuredClone(result) as {
                root: CapturedNode;
              };
              const stripChildDocuments = (node: CapturedNode): void => {
                if (node.nodeName === "IFRAME") delete node.contentDocument;
                for (const child of node.children ?? []) stripChildDocuments(child);
              };
              stripChildDocuments(document.root);
              return document;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const newCDPSession = vi
        .spyOn(context, "newCDPSession")
        .mockImplementation(async (target) => {
          if (target === page) return intercepted;
          throw new Error("Target frame detached during capture");
        });
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
        expect(newCDPSession).toHaveBeenCalledTimes(2);
      } finally {
        newCDPSession.mockRestore();
      }
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      expect(output.dom).toContain("Main action");
      expect(output.dom).toContain("<iframe");
      expect(output.dom).not.toContain("Child action");
      const main = capture.elements.find((element) => element.visibleText === "Main action")!;
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
    }
  });
  it("keeps a captured child frame visible when its CDP binding world disappears", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button id="main" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe srcdoc="<button id=child>Child action</button>"></iframe>',
      );
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      let childFrameId: string | undefined;
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              if (method === "Page.createIsolatedWorld" && params?.frameId === childFrameId)
                throw new Error("No frame with given id");
              const result = await send(method, params);
              if (method === "Page.getFrameTree") {
                const tree = result as {
                  frameTree: { childFrames?: Array<{ frame: { id: string } }> };
                };
                childFrameId = tree.frameTree.childFrames?.[0]?.frame.id;
              }
              return result;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const newCDPSession = vi.spyOn(context, "newCDPSession").mockResolvedValue(intercepted);
      const framePath = (frame: Frame): string | null => {
        const indexes: number[] = [];
        let current: Frame | null = frame;
        while (current !== null) {
          const parent = current.parentFrame();
          if (parent === null) break;
          indexes.unshift(parent.childFrames().indexOf(current));
          current = parent;
        }
        return indexes.length ? indexes.join("/") : null;
      };
      const staleChild: InteractiveElement = {
        index: 99,
        tag: "button",
        type: null,
        id: "child",
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: "button",
        labelText: null,
        visibleText: "Child action",
        selector: "#child",
        visible: true,
        inViewport: true,
        inConsentWidget: false,
        framePath: "0",
      };
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(
          page,
          [staleChild],
          framePath,
          transparentFrameSecurity,
        );
      } finally {
        newCDPSession.mockRestore();
      }

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
          return element === undefined
            ? { ref: `@e:unbound_${node.id}`, targetable: false }
            : handles.get(element)!;
        },
      });

      expect(childFrameId).toBeDefined();
      expect(output.dom).toContain("Child action");
      expect(output.dom).toMatch(/\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/);
      expect(capture.elements.some((element) => element.id === "child")).toBe(false);
      expect([...safe.byRef.values()]).not.toContain("#child");
      const main = capture.elements.find((element) => element.id === "main")!;
      expect(main).toBeDefined();
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
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
  it("preserves contained input, onclick, aria-label and text; keeps rendered names and text verbatim", async () => {
    const page = await browser.newPage();
    try {
      const token = "f9a062f02fad" + "f5";
      await page.setContent(
        `<div role="button" style="width:600px;height:300px"><span>Context text</span><input aria-label="Email"><span onclick="void 0">Separate action</span><span role="button" aria-label="Copy ${token}">Token ${token}</span></div>`,
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const ref = (node: { id: string }): string => `@e:f9a062f02fadf5_${node.id}`;
      const { dom } = serializeBrowserUseDOM(capture.root, { ref });
      expect(dom).toContain("Context text");
      expect(dom).toContain("<input");
      expect(dom).toContain("Separate action");
      expect(dom).toContain(`aria-label=Copy ${token}`);
      expect(dom).toContain(`Token ${token}`);
    } finally {
      await page.close();
    }
  });
});
