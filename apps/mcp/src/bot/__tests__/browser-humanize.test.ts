// Tests the BrowserController humanization toggle. We don't drive a
// real Chromium here — that's slow and flaky in CI — instead we verify
// the configuration plumbing and the fast-path behavior. The actual
// timing characteristics (bezier mouse, variable typing) are covered
// by end-to-end signup tests against real services.

import { describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";

describe("BrowserController humanize option", () => {
  it("defaults humanize to true", () => {
    // The default — match production where we want to pass anti-bot
    // scoring.
    const browser = new BrowserController();
    // humanize is private but we test the observable: instances
    // constructed with no opts should be considered humanized.
    expect((browser as unknown as { humanize: boolean }).humanize).toBe(true);
  });

  it("respects explicit humanize: false", () => {
    // Tests should opt out so they don't wait 800-2000ms after every
    // goto() and 80-300ms before every click.
    const browser = new BrowserController({ humanize: false });
    expect((browser as unknown as { humanize: boolean }).humanize).toBe(false);
  });

  it("respects explicit humanize: true", () => {
    const browser = new BrowserController({ humanize: true });
    expect((browser as unknown as { humanize: boolean }).humanize).toBe(true);
  });

  it("initializes a tracked mouse position so successive clicks form a path", () => {
    // The bezier-path mouse simulation needs a starting position. We
    // seed it at (100, 100) rather than (0, 0) because (0, 0) is the
    // exact corner of the viewport and a scorer could plausibly key
    // off "mouse starts at origin" as a tell.
    const browser = new BrowserController();
    expect((browser as unknown as { mouseX: number; mouseY: number }).mouseX).toBe(100);
    expect((browser as unknown as { mouseX: number; mouseY: number }).mouseY).toBe(100);
  });
});

describe("BrowserController warm page reset", () => {
  it("keeps the handler-bound primary page, closes popups, and clears task state", async () => {
    const primary = {
      isClosed: () => false,
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
    };
    const popup = {
      isClosed: () => false,
      close: vi.fn(async () => undefined),
    };
    const controller = new BrowserController({ humanize: false });
    const internals = controller as unknown as {
      context: {
        browser: () => { isConnected: () => boolean };
        pages: () => unknown[];
      };
      page: unknown;
      primaryPage: unknown;
      oauthProductPage: unknown;
      oauthNetLog: unknown[];
      mouseX: number;
      mouseY: number;
    };
    internals.context = {
      browser: () => ({ isConnected: () => true }),
      pages: () => [primary, popup],
    };
    internals.page = popup;
    internals.primaryPage = primary;
    internals.oauthProductPage = primary;
    internals.oauthNetLog = [{ url: "https://oauth.test", status: 200 }];
    internals.mouseX = 900;
    internals.mouseY = 700;

    await controller.resetPageForReuse();

    expect(popup.close).toHaveBeenCalledOnce();
    expect(primary.close).not.toHaveBeenCalled();
    expect(primary.goto).toHaveBeenCalledWith("about:blank", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(internals.page).toBe(primary);
    expect(internals.oauthProductPage).toBeNull();
    expect(internals.oauthNetLog).toEqual([]);
    expect([internals.mouseX, internals.mouseY]).toEqual([100, 100]);
  });
});
