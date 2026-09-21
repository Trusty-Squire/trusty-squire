import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  drivePointerUsesCdp,
  listOptionIdentity,
  pageFingerprintOf,
  settleDriveStep,
  waitForNavigationIdle,
} from "../drive-act.js";
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

  it.each([false, true])(
    "waits for destination content with empty shell=%s",
    async (emptyShell) => {
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
    },
  );

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
    if (suspended)
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn(() => 1),
      );
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

describe("action settle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the two-frame settle bounded while navigation replaces the page context", async () => {
    vi.useFakeTimers();
    const page = {
      evaluate: async () => await new Promise(() => undefined),
    } as unknown as Page;
    let settled = false;
    const waiting = settleDriveStep(page, false).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toBe(true);
  });
});

describe("drive pointer path", () => {
  it("keeps CDP coordinates only for a cross-origin child frame", () => {
    expect(drivePointerUsesCdp(true, true)).toBe(false);
    expect(drivePointerUsesCdp(true, false)).toBe(false);
    expect(drivePointerUsesCdp(false, true)).toBe(false);
    expect(drivePointerUsesCdp(false, false)).toBe(true);
  });
});

describe("list option identity", () => {
  it("accepts an ARIA option or a listbox child, not a combobox trigger", () => {
    expect(listOptionIdentity("option", false, false, "Other")).toEqual({
      text: "Other",
      role: "option",
    });
    expect(listOptionIdentity("none", true, false, "Keyword Search")).toEqual({
      text: "Keyword Search",
      role: "option",
    });
    expect(listOptionIdentity("menuitem", false, true, "Save")).toEqual({
      text: "Save",
      role: "menuitem",
    });
    expect(listOptionIdentity("combobox", false, false, "Select reasons...")).toBeNull();
    expect(listOptionIdentity("option", false, false, "   ")).toBeNull();
  });
});
