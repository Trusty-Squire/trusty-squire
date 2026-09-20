import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { openOwnedContextPage } from "../browser.js";

function fakePage(url: string): Page {
  return { url: () => url } as Page;
}

function fakeContext(pages: Page[], created?: Page): BrowserContext {
  return {
    pages: () => pages,
    newPage: vi.fn(async () => {
      if (created === undefined) throw new Error("newPage should not run");
      return created;
    }),
  } as unknown as BrowserContext;
}

describe("openOwnedContextPage", () => {
  it("adopts the sole blank page on a cold launch", async () => {
    const blank = fakePage("about:blank");
    const context = fakeContext([blank]);
    await expect(openOwnedContextPage(context)).resolves.toBe(blank);
    expect(context.newPage).not.toHaveBeenCalled();
  });

  it("opens a new page when a leftover session tab is already in the context", async () => {
    const leftover = fakePage("https://example.test/confirm");
    const created = fakePage("about:blank");
    const context = fakeContext([leftover], created);
    await expect(openOwnedContextPage(context)).resolves.toBe(created);
    expect(created).not.toBe(leftover);
    expect(context.newPage).toHaveBeenCalledOnce();
  });

  it("opens a new page when two sequential sessions share the context", async () => {
    const first = fakePage("https://example.test/welcome");
    const second = fakePage("about:blank");
    const context = fakeContext([first], second);
    const owned = await openOwnedContextPage(context);
    expect(owned).toBe(second);
    expect(owned).not.toBe(first);
  });
});
