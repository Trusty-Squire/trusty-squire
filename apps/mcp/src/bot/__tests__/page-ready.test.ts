import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { PAGE_READY_CAPS, waitForPageReady } from "../page-ready.js";

describe("page readiness", () => {
  let document: {
    readyState: "complete";
    body: { innerText: string; querySelector: () => null };
    querySelectorAll: () => never[];
  };
  let page: Page;

  beforeEach(() => {
    vi.useFakeTimers();
    document = {
      readyState: "complete",
      body: { innerText: "", querySelector: () => null },
      querySelectorAll: () => [],
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
    page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      waitForFunction: async (
        fn: (arg: unknown) => unknown,
        arg: unknown,
        options: { timeout: number },
      ) =>
        await new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const poll = () => {
            if (fn(arg)) return resolve();
            if (Date.now() - started >= options.timeout) return reject(new Error("timeout"));
            setTimeout(poll, 16);
          };
          poll();
        }),
    } as unknown as Page;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for a blank stage to render before allowing a drive read", async () => {
    const waiting = waitForPageReady(page, { kind: "drive-read" });
    await vi.advanceTimersByTimeAsync(96);
    document.body.innerText = "Payment details";
    await vi.advanceTimersByTimeAsync(16);
    const readiness = await waiting;
    expect(readiness.ready).toBe(true);
    expect(readiness.elapsedMs).toBeGreaterThanOrEqual(96);
  });

  it("reports an unrendered document after the original 1.5 s cap", async () => {
    const waiting = waitForPageReady(page, { kind: "drive-read" });
    await vi.advanceTimersByTimeAsync(PAGE_READY_CAPS.driveEmpty + 16);
    const readiness = await waiting;
    expect(readiness).toMatchObject({ ready: false, reason: "no_rendered_content" });
    expect(readiness.elapsedMs).toBeGreaterThanOrEqual(PAGE_READY_CAPS.driveEmpty);
  });

  it.each(["Loading...", "Loading your workspace..."])(
    "does not treat %s as rendered page content",
    async (label) => {
      document.body.innerText = label;
      const waiting = waitForPageReady(page, { kind: "drive-read" });
      await vi.advanceTimersByTimeAsync(PAGE_READY_CAPS.driveEmpty + 16);
      expect(await waiting).toMatchObject({ ready: false, reason: "no_rendered_content" });
    },
  );

  it("does not count a painted loading iframe as a finished page", async () => {
    const mainFrame = {};
    const childDocument = {
      readyState: "complete",
      body: {
        innerText: "Loading...",
        querySelector: () => null,
        children: [
          {
            tagName: "DIV",
            getBoundingClientRect: () => ({ width: 100, height: 30 }),
          },
        ],
      },
      querySelectorAll: () => [],
    };
    const frame = {
      isDetached: () => false,
      frameElement: async () => ({
        isVisible: async () => true,
        boundingBox: async () => ({ width: 100, height: 30 }),
        dispose: async () => undefined,
      }),
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
        vi.stubGlobal("document", childDocument);
        vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", opacity: "1" }));
        try {
          return fn(arg);
        } finally {
          vi.stubGlobal("document", document);
        }
      },
    };
    page = { ...page, frames: () => [mainFrame, frame], mainFrame: () => mainFrame } as Page;
    const waiting = waitForPageReady(page, { kind: "drive-read" });
    await vi.advanceTimersByTimeAsync(PAGE_READY_CAPS.driveEmpty + 16);
    expect(await waiting).toMatchObject({ ready: false, reason: "no_rendered_content" });
  });

  it("keeps the same-page change watch bounded while content has not changed", async () => {
    document.body.innerText = "Cart contents";
    const waiting = waitForPageReady(page, {
      kind: "drive-action",
      beforeFingerprint: "Cart contents",
      watchChange: true,
    });
    await vi.advanceTimersByTimeAsync(PAGE_READY_CAPS.driveChange + 80);
    const readiness = await waiting;
    expect(readiness.ready).toBe(true);
    expect(readiness.elapsedMs).toBeGreaterThanOrEqual(PAGE_READY_CAPS.driveChange);
  });

  it("bounds the two-frame settle when navigation suspends the old context", async () => {
    page = { evaluate: async () => await new Promise(() => undefined) } as unknown as Page;
    const waiting = waitForPageReady(page, { kind: "drive-action" });
    await vi.advanceTimersByTimeAsync(PAGE_READY_CAPS.driveFrames);
    const readiness = await waiting;
    expect(readiness.ready).toBe(true);
    expect(readiness.elapsedMs).toBeGreaterThanOrEqual(PAGE_READY_CAPS.driveFrames);
  });
});
