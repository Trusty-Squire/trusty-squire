import type * as Scope from "../browser-scope.js";
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import type { BrowserProcessOwner } from "../browser-process-owner.js";
import type { PageDriver } from "../page-driver.js";

const events: string[] = [];
vi.mock("../browser-scope.js", async (original) => ({
  ...(await original<typeof Scope>()),
  stopBrowserScope: async () => { events.push("scope-stop"); },
  browserScopeIsEmpty: async () => true,
}));

// The fixture supplies only Playwright methods used by close; no real Chrome
// is launched. Linux close must drain the scope after bounded handle closes.
function fixture() {
  const controller = new BrowserController({ profileDir: "/unused/boundary-profile" });
  const { processOwner: owner, pageDriver: pages } = controller as unknown as {
    processOwner: BrowserProcessOwner;
    pageDriver: PageDriver;
  };
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    isClosed: () => false,
    close: vi.fn(async () => { events.push("page-close"); }),
  }) as unknown as Page;
  const context = {
    close: vi.fn(async () => { events.push("context-close"); }),
  } as unknown as BrowserContext;
  const browser = {
    isConnected: () => true,
    close: vi.fn(async () => { events.push("transport-close"); }),
  } as unknown as Browser;
  pages.page = page;
  pages.primaryPage = page;
  pages.trackOpenedTabs(page);
  owner.context = context;
  (owner as unknown as { cdpBrowser: Browser }).cdpBrowser = browser;
  const dispose = pages.disposeRegistrations.bind(pages);
  vi.spyOn(pages, "disposeRegistrations").mockImplementation(() => {
    events.push("dispose-pages");
    dispose();
  });
  return { controller, pages, page, context, emitter };
}

beforeEach(() => { events.length = 0; });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser process and page boundary", () => {
  it("disposes page registration without terminating physical custody", () => {
    const { controller, pages, page, emitter } = fixture();
    pages.disposeRegistrations();
    expect(pages.ownedPages.has(page)).toBe(false);
    expect(emitter.listenerCount("popup")).toBe(0);
    expect(emitter.listenerCount("domcontentloaded")).toBe(0);
    expect(controller.isConnected()).toBe(true);
    expect(events).toEqual(["dispose-pages"]);
  });

  it.skipIf(process.platform !== "linux")("closes handles before draining the Chrome scope", async () => {
    const { controller, pages } = fixture();
    await expect(controller.close()).resolves.toBe("closed");
    expect(events).toEqual([
      "dispose-pages", "page-close", "context-close", "transport-close", "scope-stop",
    ]);
    expect(pages.page).toBeNull();
    expect(pages.primaryPage).toBeNull();
    expect(controller.isConnected()).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("bounds hung page and context closes before draining the scope", async () => {
    vi.useFakeTimers();
    const { controller, page, context } = fixture();
    vi.mocked(page.close).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(context.close).mockImplementation(() => new Promise(() => undefined));
    const closing = controller.close();
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(closing).resolves.toBe("closed");
    expect(context.close).toHaveBeenCalledOnce();
    expect(events).toContain("scope-stop");
  });
});
