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

it.each(["role", "selector"] as const)(
  "never retargets a matching %s source in a replacement document",
  async (kind) => {
    await page.setContent('<input aria-label="API key" value="original-fixture">');
    const locator = page.getByRole("textbox", { name: "API key", exact: true });
    const originalHandles = locator.elementHandles.bind(locator);
    vi.spyOn(locator, "elementHandles").mockImplementation(async () => {
      const handles = await originalHandles();
      await page.goto('data:text/html,<input aria-label="API key" value="replacement-fixture">');
      return handles;
    });
    const lookup =
      kind === "role"
        ? vi.spyOn(page, "getByRole").mockReturnValue(locator)
        : vi.spyOn(page, "locator").mockReturnValue(locator);
    const filter = vi.spyOn(locator, "filter").mockReturnValue(locator);
    try {
      await expect(
        captureCredentialSource(
          "fixture",
          kind === "role" ? { role: "textbox", name: "API key" } : { selector: "input" },
        ),
      ).rejects.toThrow();
    } finally {
      lookup.mockRestore();
      filter.mockRestore();
    }
    expect(await page.getByRole("textbox").inputValue()).toBe("replacement-fixture");
  },
);

it("captures the settled plain-text copy field reported on Neon", async () => {
  const value = "synthetic-neon-token-not-a-real-key";
  await page.setContent(`<section role="dialog">
    <div><div><label>API token</label><div><div><div><div>${value}</div></div></div>
      <div><div><button onclick="document.body.dataset.copied='yes'">Copy</button></div></div>
    </div></div></div><button>Copy and close</button>
  </section>`);
  // Firstmate confirmed the real token is a visible DIV, without an input/code
  // ancestor. Only the reported label/value grouping is represented; no
  // production classes, IDs, or token content are used to locate the value.
  const selector = 'label:text-is("API token") + div div:not(:has(*))';
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toEqual({
    candidate_count: 0,
  });
  expect(await captureCredentialSource("fixture", { role: "code" })).toEqual({
    candidate_count: 0,
  });
  expect(
    await captureCredentialSource("fixture", {
      selector,
      container: { role: "dialog" },
    }),
  ).toEqual({ candidate_count: 1, value });
  expect(await page.locator("body").getAttribute("data-copied")).toBeNull();

  // One-variable counterfactual: only the value-bearing element becomes an
  // input. The unchanged textbox source now works (the proven Resend path).
  await page.locator(selector).evaluate((node) => {
    const input = document.createElement("input");
    input.value = node.textContent!;
    node.replaceWith(input);
  });
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toEqual({
    candidate_count: 1,
    value,
  });
});

it("keeps explicit plain-text sources scoped, visible, and unambiguous", async () => {
  await page.setContent(`<div class="copy-value">outside-fixture</div>
    <section role="dialog"><div class="copy-value" hidden>hidden-fixture</div>
    <div class="copy-value">inside-fixture</div></section>`);
  const source = { selector: ".copy-value", container: { role: "dialog" as const } };
  expect(await captureCredentialSource("fixture", source)).toEqual({
    candidate_count: 1,
    value: "inside-fixture",
  });
  expect(await captureCredentialSource("fixture", { selector: ".copy-value" })).toEqual({
    candidate_count: 2,
  });
  await page.locator("section").evaluate((node) => {
    const other = document.createElement("div");
    other.className = "copy-value";
    other.textContent = "another-fixture";
    node.append(other);
  });
  expect(await captureCredentialSource("fixture", source)).toEqual({ candidate_count: 2 });
});
