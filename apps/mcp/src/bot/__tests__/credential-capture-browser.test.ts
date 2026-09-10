import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as lifecycle from "../session/lifecycle.js";
import { captureCredentialSource } from "../provision-session.js";
import type { Session } from "../session/model.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    browser: { activePage: () => page },
  } as unknown as Session);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await browser?.close();
});

it("captures only one visible source in the explicit container without clicking reveal", async () => {
  await page.setContent(`<input aria-label="API key" value="unrelated-fixture"><dialog open aria-label="Created key">
    <button onclick="document.body.dataset.clicked='yes'">Reveal unrelated key</button>
    <input aria-label="API key" value="fresh-fixture-value"></dialog>`);
  const captured = await captureCredentialSource("fixture", {
    role: "textbox",
    name: "API key",
    container: { role: "dialog", name: "Created key" },
  });
  expect(captured).toEqual({ candidate_count: 1, value: "fresh-fixture-value" });
  expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
  expect(await captureCredentialSource("fixture", { role: "textbox", name: "API key" })).toEqual({
    candidate_count: 2,
  });
});

it("never retargets a matching source in a replacement document", async () => {
  await page.setContent('<input aria-label="API key" value="original-fixture">');
  const locator = page.getByRole("textbox", { name: "API key", exact: true });
  const originalHandles = locator.elementHandles.bind(locator);
  vi.spyOn(locator, "elementHandles").mockImplementation(async () => {
    const handles = await originalHandles();
    await page.goto('data:text/html,<input aria-label="API key" value="replacement-fixture">');
    return handles;
  });
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    await expect(
      captureCredentialSource("fixture", { role: "textbox", name: "API key" }),
    ).rejects.toThrow();
  } finally {
    lookup.mockRestore();
  }
  expect(await page.getByRole("textbox").inputValue()).toBe("replacement-fixture");
});
