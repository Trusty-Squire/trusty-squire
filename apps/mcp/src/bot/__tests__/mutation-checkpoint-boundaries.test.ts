import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import { withOperatorRequestContext } from "../request-cancellation.js";

it("checkpoints handle, frame, select, and phone mutations before their first effect", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const controller = new BrowserController({ humanize: false });
  try {
    await page.setContent(
      '<input id="text" value="old"><select id="select"><option>Old</option><option>New</option></select><select name="phone-country"><option value="US">United States +1</option><option value="JP">Japan +81</option></select><input type="tel">',
    );
    const handle = await page.$("#text");
    const select = await page.$("#select");
    if (!handle || !select) throw new Error("fixture missing");
    const target = { frameUrl: page.url(), frameOrigin: "null", framePath: "0" };
    const internals = controller as unknown as { resolveFrameElement: () => Promise<unknown> };
    const resolver = vi.spyOn(internals, "resolveFrameElement");
    const cases = [
      {
        run: () => controller.typeHandle(handle, "new"),
        read: () => page.locator("#text").inputValue(),
        old: "old",
        next: "new",
      },
      {
        run: () => controller.typeInFrame(target, "#text", "frame", false, page),
        read: () => page.locator("#text").inputValue(),
        old: "new",
        next: "frame",
        handle,
      },
      {
        run: () => controller.selectInFrame(target, "#select", "new", page),
        read: () => page.locator("#select").inputValue(),
        old: "Old",
        next: "New",
        handle: select,
      },
      {
        run: () => controller.setPhoneCountry("JP", page),
        read: () => page.locator('[name="phone-country"]').inputValue(),
        old: "US",
        next: "JP",
      },
    ];
    for (const test of cases) {
      if (test.handle) resolver.mockResolvedValue(test.handle);
      const denied = vi.fn(async () => {
        throw new Error("journal unavailable");
      });
      await expect(
        withOperatorRequestContext(new AbortController().signal, test.run, denied),
      ).rejects.toThrow("journal unavailable");
      expect(denied).toHaveBeenCalledOnce();
      expect(await test.read()).toBe(test.old);
      if (test.handle) {
        const fresh = await page.$(test.handle === select ? "#select" : "#text");
        resolver.mockResolvedValue(fresh);
      }
      const checkpoint = vi.fn(async () => {
        expect(await test.read()).toBe(test.old);
      });
      await withOperatorRequestContext(new AbortController().signal, test.run, checkpoint);
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(await test.read()).toBe(test.next);
    }
  } finally {
    vi.restoreAllMocks();
    await browser.close();
  }
});
