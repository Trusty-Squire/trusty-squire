import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
let browser: Browser | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await browser?.close();
});

async function fixture() {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<main>service</main>" });
  });
  const root = BrowserController.fromHarnessPage(await context.newPage());
  const a = await BrowserController.attachSessionPage(root, { humanize: false });
  const b = await BrowserController.attachSessionPage(root, { humanize: false });
  await Promise.all([a.goto("https://a.test"), b.goto("https://b.test")]);
  const page = (controller: BrowserController) => (controller as unknown as { page: Page }).page;
  return { context, root, a, b, page };
}

describe("broker context coordination", () => {
  it("clears Cloudflare cookies only for the recovering site's exact cookie scope", async () => {
    const { context, a } = await fixture();
    await context.addCookies([
      { name: "cf_clearance", value: "a", domain: ".a.test", path: "/" },
      { name: "cf_clearance", value: "b", domain: ".b.test", path: "/" },
      { name: "__cf_bm", value: "b", domain: ".b.test", path: "/" },
    ]);
    const recovery = a as unknown as {
      pollUntilInterstitialClears(
        timeout: number,
      ): Promise<{ cleared: boolean; detected: boolean }>;
      clearCloudflareCookiesAndRetry(timeout: number): Promise<boolean>;
    };
    vi.spyOn(recovery, "pollUntilInterstitialClears").mockResolvedValue({
      cleared: true,
      detected: false,
    });
    expect(await recovery.clearCloudflareCookiesAndRetry(1)).toBe(true);
    expect(await context.cookies("https://a.test")).toEqual([]);
    expect((await context.cookies("https://b.test")).map((cookie) => cookie.name).sort()).toEqual([
      "__cf_bm",
      "cf_clearance",
    ]);
  });

  it("retains an unclosed family's handles for a later proven close", async () => {
    const { a, b, page } = await fixture();
    const original = page(a);
    const failure = vi.spyOn(original, "close").mockRejectedValueOnce(new Error("close failed"));
    expect(await a.closeOwnPagesOnly()).toBe("unknown");
    expect(page(a)).toBe(original);
    expect(original.isClosed()).toBe(false);
    failure.mockRestore();
    expect(await a.closeOwnPagesOnly()).toBe("closed");
    expect(page(b).isClosed()).toBe(false);
  });
});
