import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { pageFingerprintOf, waitForNavigationIdle } from "../drive-act.js";
import { attachOperatorRequestAbort, withOperatorRequestContext } from "../request-cancellation.js";

describe("navigation content settle", () => {
  let document: {
    title: string;
    body: { innerText: string };
    querySelectorAll: ReturnType<typeof vi.fn>;
  };
  let page: Page;

  beforeEach(() => {
    vi.useFakeTimers();
    document = {
      title: "Cart",
      body: { innerText: "Cart contents" },
      querySelectorAll: vi.fn(() => []),
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", { href: "https://shop.test/cart" });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => clearTimeout(frame));
    page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    } as unknown as Page;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([false, true])("waits for destination content with empty shell=%s", async (emptyShell) => {
    const before = await pageFingerprintOf(page);
    location.href = "https://shop.test/checkout";
    document.title = "Checkout";
    if (emptyShell) document.body.innerText = "";
    let settled = false;
    const waiting = waitForNavigationIdle(page, before).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(96);
    expect(settled).toBe(false);
    document.body.innerText = "Shipping address";
    await vi.advanceTimersByTimeAsync(16);
    await waiting;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles when destination controls render without body text", async () => {
    const before = await pageFingerprintOf(page);
    document.body.innerText = "";
    const waiting = waitForNavigationIdle(page, before);
    await vi.advanceTimersByTimeAsync(96);
    document.querySelectorAll.mockReturnValue([{ tagName: "INPUT", type: "text", value: "" }]);
    await vi.advanceTimersByTimeAsync(16);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("caps waiting at 300ms with suspended frames=%s", async (suspended) => {
    if (suspended) vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    const before = await pageFingerprintOf(page);
    const controller = new AbortController();
    attachOperatorRequestAbort(controller.signal, (reason) => controller.abort(reason));
    await withOperatorRequestContext(controller.signal, async () => {
      let settled = false;
      const waiting = waitForNavigationIdle(page, before).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await waiting;
      expect(controller.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
